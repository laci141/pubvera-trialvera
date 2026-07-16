// providers.go — the in-process BYOK LLM layer.
//
// The vendored clinical-trials CLI is purely heuristic/keyless: it never reads
// a provider key and never calls an LLM. All LLM work therefore happens HERE,
// in the web layer, as a post-processing step: the CLI's JSON output plus the
// user's free-text input (query / condition / drug / NCT ID) are sent in ONE
// chat-completions call to the caller-selected provider, which returns a
// plain-language synthesis (summary, key points, caveats, and an explicit
// not-medical-advice line). The CLI result is always returned verbatim; an LLM
// failure degrades to the keyless result plus a redacted llm_error.
//
// SECURITY MODEL (same rules as main.go, do not weaken):
//   - The key lives in memory for one request and goes into exactly one
//     outbound Authorization/x-api-key header over HTTPS. Never logged,
//     never persisted, never placed in any environment.
//   - Every error string that could contain a provider response body passes
//     through redact() (exact-key removal) plus control-byte stripping and
//     truncation before it reaches a client or a log line.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// llmTimeout bounds the single synthesis call; it must fit inside the 120s
// request budget in runCLI with room for the CLI run that precedes it.
const llmTimeout = 60 * time.Second

// authStyle selects how the key is presented and which wire format is used.
type authStyle int

const (
	styleOpenAI    authStyle = iota // POST {base}/chat/completions, Authorization: Bearer
	styleAnthropic                  // POST {base}/messages, x-api-key + anthropic-version
)

// providerSpec describes one BYOK provider. BaseURL is the API root WITHOUT
// the /chat/completions (or /messages) suffix; DefaultModel is used when the
// caller sends no model override.
type providerSpec struct {
	BaseURL      string
	DefaultModel string
	Style        authStyle
	// JSONFormat requests JSON-object output via the OpenAI-wire
	// response_format parameter. Only meaningful for styleOpenAI providers;
	// enabled only where the endpoint is known to accept it (openrouter).
	JSONFormat bool
}

// providers is the full BYOK registry. Everything except anthropic speaks the
// OpenAI chat-completions format; gemini via Google's OpenAI-compatibility
// endpoint, qwen via DashScope's international compatible-mode endpoint.
// openrouter is a meta-provider: its model string selects any hosted model
// (including :free ones), so the UI treats model as effectively required there.
var providers = map[string]providerSpec{
	"anthropic":  {"https://api.anthropic.com/v1", "claude-haiku-4-5", styleAnthropic, false},
	"openai":     {"https://api.openai.com/v1", "gpt-5-mini", styleOpenAI, false},
	"gemini":     {"https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", styleOpenAI, false},
	"groq":       {"https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", styleOpenAI, false},
	"mistral":    {"https://api.mistral.ai/v1", "mistral-small-latest", styleOpenAI, false},
	"deepseek":   {"https://api.deepseek.com", "deepseek-chat", styleOpenAI, false},
	"zai":        {"https://api.z.ai/api/paas/v4", "glm-5", styleOpenAI, false},
	"moonshot":   {"https://api.moonshot.ai/v1", "kimi-k2.6", styleOpenAI, false},
	"qwen":       {"https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen3-max", styleOpenAI, false},
	"minimax":    {"https://api.minimax.io/v1", "MiniMax-M2.7", styleOpenAI, false},
	"xai":        {"https://api.x.ai/v1", "grok-4-fast", styleOpenAI, false},
	"openrouter": {"https://openrouter.ai/api/v1", "deepseek/deepseek-chat", styleOpenAI, true},
}

// supportedProviders is the sorted name list used in error messages.
var supportedProviders = func() string {
	names := make([]string, 0, len(providers))
	for n := range providers {
		names = append(names, n)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}()

// llmSynthesis is the structured post-processing summary returned to clients
// under "llm_synthesis". The schema is generic across every command shape
// (risk, safety, compare, search, forecast, …): a plain-language summary,
// key points citing concrete numbers/IDs from the tool output, caveats, and
// an explicit not-medical-advice line.
type llmSynthesis struct {
	Summary   string   `json:"summary"`
	KeyPoints []string `json:"key_points"`
	Caveats   []string `json:"caveats"`
	NotAdvice string   `json:"not_advice"`
	Model     string   `json:"model"`
}

// defaultNotAdvice is enforced when the model omits or blanks the field: the
// disclaimer must always reach the client.
const defaultNotAdvice = "Informational only — not medical advice."

// maxCLIJSONForPrompt caps how much CLI output is embedded in the prompt so
// large result lists cannot blow the model's context window. Same cap as the
// scientific-consensus template; well inside typical context limits.
const maxCLIJSONForPrompt = 56 * 1024

// maxEntriesForLLM caps how many entries of each large array (results, trials,
// sources) the LLM sees. clinical-trials entries are compact (no abstracts),
// so 25 entries per array stay comfortably inside maxCLIJSONForPrompt. Without
// the trim, the naive byte cap could cut a large trailing array mid-JSON,
// silently corrupting exactly the data the LLM needs.
const maxEntriesForLLM = 25

// largeArrayKeys are the clinical-trials CLI output keys that can carry big
// lists worth trimming. (factors lists are short risk explanations and are
// kept whole.)
var largeArrayKeys = []string{"results", "trials", "sources"}

// compactForLLM shrinks the CLI JSON before it is embedded in the prompt.
// Wherever the top-level object (or the drug_a/drug_b sub-objects of compare
// output) carries a results/trials/sources array longer than maxEntriesForLLM,
// the array is trimmed to its first entries (the CLI orders by relevance).
// Anything that fails to parse — or has nothing to trim — is returned
// unchanged. Only the LLM's copy is compacted; the client always receives the
// CLI JSON verbatim.
func compactForLLM(raw []byte) []byte {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return raw
	}
	if !compactObject(obj) {
		return raw
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return out
}

// compactObject applies the large-array trim to one object and recurses into
// compare's drug_a/drug_b sub-objects. Returns true when anything changed.
func compactObject(obj map[string]json.RawMessage) bool {
	changed := false
	for _, k := range largeArrayKeys {
		rawList, ok := obj[k]
		if !ok {
			continue
		}
		var list []json.RawMessage
		if err := json.Unmarshal(rawList, &list); err != nil {
			continue
		}
		if len(list) > maxEntriesForLLM {
			if trimmed, err := json.Marshal(list[:maxEntriesForLLM]); err == nil {
				obj[k] = trimmed
				changed = true
			}
		}
	}
	for _, k := range []string{"drug_a", "drug_b"} {
		sub, ok := obj[k]
		if !ok {
			continue
		}
		var subObj map[string]json.RawMessage
		if err := json.Unmarshal(sub, &subObj); err != nil {
			continue
		}
		if compactObject(subObj) {
			if enc, err := json.Marshal(subObj); err == nil {
				obj[k] = enc
				changed = true
			}
		}
	}
	return changed
}

// synthesisPrompt builds the single user message sent to the LLM. It is
// generic across every clinical-trials command shape and hard-codes the
// informational-only framing: the model must never tell a user what treatment
// to take. The CLI JSON is compacted first (compactForLLM), then byte-capped
// with an explicit truncation note so a mid-JSON cut is never silent.
func synthesisPrompt(command string, inputs []string, cliJSON []byte) string {
	cliJSON = compactForLLM(cliJSON)
	truncated := false
	if len(cliJSON) > maxCLIJSONForPrompt {
		cliJSON = cliJSON[:maxCLIJSONForPrompt]
		truncated = true
	}
	var b strings.Builder
	b.WriteString("You are a clinical-trials data analyst. Below is the JSON output of a clinical-trials intelligence tool (command: " + command + ") for the user's input(s):\n")
	for i, in := range inputs {
		fmt.Fprintf(&b, "INPUT %d: %s\n", i+1, in)
	}
	b.WriteString("\nTOOL OUTPUT (may be truncated):\n")
	b.Write(cliJSON)
	if truncated {
		b.WriteString("\n[NOTE: tool output was truncated mid-JSON; some entries may not be shown.]")
	}
	b.WriteString("\n\nWrite a plain-language synthesis of this tool output for a general reader.\n" +
		"IMPORTANT — this synthesis is INFORMATIONAL ONLY and is NOT medical or clinical advice. Never tell the user what treatment to take, never recommend starting, stopping, or switching any medication, and never advise enrolling in (or avoiding) any specific trial. Describe what the data shows; do not prescribe.\n" +
		"Ground every statement in the tool output above: cite concrete numbers, trial counts, phases, enrollment figures, dates, and NCT IDs from it. Do not invent data. If the output is empty or too thin to summarize, say so plainly in the summary and note it in caveats.\n\n" +
		"Respond with ONLY a JSON object, no markdown fences, with exactly these fields:\n" +
		`{"summary":"2-4 plain-language sentences","key_points":["3-5 points citing concrete numbers/IDs from the tool output"],"caveats":["limitations, e.g. early phase, small N, registry-only signal"],"not_advice":"informational only, not medical advice"}`)
	return b.String()
}

// openAIRequest / anthropicRequest are the minimal wire shapes. temperature is
// deliberately omitted (some providers reject non-default values).
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// responseFormat is the OpenAI-wire response_format parameter. Sent only when
// providerSpec.JSONFormat is set; the nil pointer keeps the wire bytes of every
// other provider's request identical to before the field existed.
type responseFormat struct {
	Type string `json:"type"`
}

type openAIRequest struct {
	Model          string          `json:"model"`
	Messages       []chatMessage   `json:"messages"`
	ResponseFormat *responseFormat `json:"response_format,omitempty"`
}

type anthropicRequest struct {
	Model     string        `json:"model"`
	MaxTokens int           `json:"max_tokens"`
	Messages  []chatMessage `json:"messages"`
}

// llmSynthesize makes one chat call to the selected provider and parses the
// structured synthesis. Every returned error is already safe to expose: key
// redacted, control bytes stripped, body truncated.
func llmSynthesize(ctx context.Context, provider, key, model, command string, inputs []string, cliJSON []byte) (*llmSynthesis, error) {
	spec, ok := providers[provider]
	if !ok { // callers validate first; belt and braces
		return nil, errors.New("unknown provider")
	}
	if model == "" {
		model = spec.DefaultModel
	}
	prompt := synthesisPrompt(command, inputs, cliJSON)

	var url string
	var payload any
	switch spec.Style {
	case styleAnthropic:
		url = spec.BaseURL + "/messages"
		payload = anthropicRequest{Model: model, MaxTokens: 1024, Messages: []chatMessage{{Role: "user", Content: prompt}}}
	default:
		url = spec.BaseURL + "/chat/completions"
		reqPayload := openAIRequest{Model: model, Messages: []chatMessage{{Role: "user", Content: prompt}}}
		if spec.JSONFormat {
			reqPayload.ResponseFormat = &responseFormat{Type: "json_object"}
		}
		payload = reqPayload
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %v", err)
	}

	ctx, cancel := context.WithTimeout(ctx, llmTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("build request: " + sanitizeLLMError(err.Error(), key))
	}
	req.Header.Set("Content-Type", "application/json")
	if spec.Style == styleAnthropic {
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Transport errors can embed the URL but never the key (it travels in a
		// header); sanitize anyway.
		return nil, errors.New("request failed: " + sanitizeLLMError(err.Error(), key))
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, errors.New("read response: " + sanitizeLLMError(err.Error(), key))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("provider returned HTTP %d: %s", resp.StatusCode, sanitizeLLMError(string(respBody), key))
	}

	text, err := extractChatText(spec.Style, respBody)
	if err != nil {
		return nil, errors.New(sanitizeLLMError(err.Error(), key))
	}
	syn, err := parseSynthesis(text)
	if err != nil {
		return nil, errors.New("unparseable synthesis: " + sanitizeLLMError(err.Error(), key))
	}
	syn.Model = model
	return syn, nil
}

// extractChatText pulls the assistant text out of the provider response.
func extractChatText(style authStyle, body []byte) (string, error) {
	if style == styleAnthropic {
		var r struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(body, &r); err != nil {
			return "", errors.New("invalid provider response JSON")
		}
		for _, c := range r.Content {
			if c.Type == "text" && c.Text != "" {
				return c.Text, nil
			}
		}
		return "", errors.New("provider response contained no text content")
	}
	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", errors.New("invalid provider response JSON")
	}
	if len(r.Choices) == 0 || r.Choices[0].Message.Content == "" {
		return "", errors.New("provider response contained no choices")
	}
	return r.Choices[0].Message.Content, nil
}

// parseSynthesis parses the model's JSON output, tolerating markdown fences
// and surrounding prose, then normalizes the fields: a non-empty summary is
// required, list lengths are capped, and the not-advice line is enforced.
func parseSynthesis(text string) (*llmSynthesis, error) {
	start := strings.IndexByte(text, '{')
	end := strings.LastIndexByte(text, '}')
	if start < 0 || end <= start {
		return nil, errors.New("no JSON object in model output")
	}
	var syn llmSynthesis
	if err := json.Unmarshal([]byte(text[start:end+1]), &syn); err != nil {
		return nil, errors.New("model output is not valid JSON")
	}
	syn.Summary = strings.TrimSpace(syn.Summary)
	if syn.Summary == "" {
		return nil, errors.New("model output missing summary")
	}
	syn.KeyPoints = cleanStringList(syn.KeyPoints, 5)
	syn.Caveats = cleanStringList(syn.Caveats, 8)
	syn.NotAdvice = strings.TrimSpace(syn.NotAdvice)
	if syn.NotAdvice == "" {
		syn.NotAdvice = defaultNotAdvice
	}
	return &syn, nil
}

// cleanStringList trims entries, drops blanks, and caps the list length so a
// runaway model response can't bloat the payload.
func cleanStringList(in []string, max int) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if len(s) > 500 {
			s = s[:500]
		}
		out = append(out, s)
		if len(out) >= max {
			break
		}
	}
	return out
}

// sanitizeLLMError makes an upstream diagnostic safe for clients and logs:
// exact key redaction, control bytes stripped, hard length cap.
func sanitizeLLMError(s, key string) string {
	s = redact(s, key)
	s = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' {
			return ' '
		}
		return r
	}, s)
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 240 {
		s = s[:240] + "…"
	}
	return strings.TrimSpace(s)
}

// validateModel enforces the opaque-token rules for the caller-supplied model
// override: trimmed, ≤128 chars, no whitespace or control characters. Returns
// the normalized model and "" on success, or an error message (which never
// echoes the value — the model field is treated as sensitive-adjacent input).
func validateModel(model string) (string, string) {
	model = strings.TrimSpace(model)
	if model == "" {
		return "", ""
	}
	if len(model) > 128 {
		return "", "model must be at most 128 characters"
	}
	for _, r := range model {
		if r <= 0x20 || r == 0x7f {
			return "", "model must not contain whitespace or control characters"
		}
	}
	return model, ""
}
