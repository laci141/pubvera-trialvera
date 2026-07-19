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
	"regexp"
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
	// GroundingNote is set by groundSynthesis when post-validation removed or
	// flagged statements that referenced data absent from the tool output. It
	// is rendered as a visible warning in the UI.
	GroundingNote string `json:"grounding_note,omitempty"`
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

// trialFieldKeys are the array keys whose entries are trial rows and therefore
// get the noise-reduction field whitelist below (sources entries are already
// tiny and stay whole).
var trialFieldKeys = map[string]bool{"results": true, "trials": true}

// llmTrialFields is the whitelist of trial-row fields the LLM sees. Everything
// else (sponsor_class, last_update, source, secondary_ids, relevance scores …)
// is registry bookkeeping: noise that invites hallucination without adding
// summarizable signal. Only the LLM's copy is filtered — the client always
// receives the full row.
var llmTrialFields = map[string]bool{
	"id": true, "nct_id": true, "title": true, "status": true,
	"phase": true, "phases": true, "conditions": true, "interventions": true,
	"countries": true, "sponsor": true, "enrollment": true,
	"start_date": true, "completion_date": true, "primary_completion_date": true,
	"has_results": true, "why_stopped": true, "url": true,
}

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

// compactObject applies the large-array trim plus the trial-field whitelist to
// one object and recurses into compare's drug_a/drug_b sub-objects. Returns
// true when anything changed. Entries that already contain only whitelisted
// fields are kept byte-identical (no re-marshal), so outputs with nothing to
// strip still pass through unchanged.
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
		listChanged := false
		if len(list) > maxEntriesForLLM {
			list = list[:maxEntriesForLLM]
			listChanged = true
		}
		if trialFieldKeys[k] {
			for i, entry := range list {
				if slim, ok := stripTrialEntry(entry); ok {
					list[i] = slim
					listChanged = true
				}
			}
		}
		if listChanged {
			if enc, err := json.Marshal(list); err == nil {
				obj[k] = enc
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

// stripTrialEntry removes non-whitelisted fields from one trial row. Returns
// the slimmed entry and true only when something was actually removed; a row
// that is already clean is left byte-identical.
func stripTrialEntry(entry json.RawMessage) (json.RawMessage, bool) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(entry, &m); err != nil {
		return entry, false
	}
	dropped := false
	for k := range m {
		if !llmTrialFields[k] {
			delete(m, k)
			dropped = true
		}
	}
	if !dropped {
		return entry, false
	}
	enc, err := json.Marshal(m)
	if err != nil {
		return entry, false
	}
	return enc, true
}

// synthesisPrompt builds the single user message sent to the LLM. It is
// generic across every clinical-trials command shape and hard-codes the
// informational-only framing: the model must never tell a user what treatment
// to take. The fact sheet is derived from the FULL result before compaction
// (its numbers must be authoritative), then the CLI JSON is compacted
// (compactForLLM) and byte-capped with an explicit truncation note so a
// mid-JSON cut is never silent.
func synthesisPrompt(command string, inputs []string, cliJSON []byte) string {
	facts := buildFactSheet(cliJSON)
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
	if facts != "" {
		b.WriteString("\n" + facts + "\n")
	}
	b.WriteString("\nTOOL OUTPUT (may be truncated):\n")
	b.Write(cliJSON)
	if truncated {
		b.WriteString("\n[NOTE: tool output was truncated mid-JSON; some entries may not be shown.]")
	}
	b.WriteString("\n\nWrite a plain-language synthesis of this tool output for a general reader.\n" +
		"IMPORTANT — this synthesis is INFORMATIONAL ONLY and is NOT medical or clinical advice. Never tell the user what treatment to take, never recommend starting, stopping, or switching any medication, and never advise enrolling in (or avoiding) any specific trial. Describe what the data shows; do not prescribe.\n" +
		"STRICT GROUNDING RULES — every one is mandatory:\n" +
		"1. Use ONLY facts present in the tool output above. For this task, nothing outside it exists.\n" +
		"2. Back every trial-level claim with its NCT ID in the same sentence, exactly as it appears in the tool output.\n" +
		"3. NEVER mention a country, sponsor, enrollment figure, or trial that does not appear verbatim in the tool output. Copy names and numbers character-for-character; do not paraphrase identifiers.\n" +
		"4. Do not rank or generalize (\"X leads\", \"most trials are…\") unless the counts in the tool output directly show it.\n" +
		"5. If the output is empty or too thin to summarize, say exactly that in the summary and caveats — never fill gaps with plausible-sounding facts.\n")
	if facts != "" {
		b.WriteString("6. Any number you state must come from PRE-COMPUTED FACTS above. Do not count items yourself. If a number is not listed there, do not mention that quantity at all — describe it qualitatively instead.\n")
	}
	b.WriteString("Your response is post-validated by software: statements referencing NCT IDs, countries, or numbers absent from the tool output are removed.\n\n" +
		"Respond with ONLY a JSON object, no markdown fences, with exactly these fields:\n" +
		`{"summary":"2-4 plain-language sentences","key_points":["3-5 points citing concrete numbers/IDs from the tool output"],"caveats":["limitations, e.g. early phase, small N, registry-only signal"],"not_advice":"informational only, not medical advice"}`)
	return b.String()
}

// ---- pre-computed fact sheet -------------------------------------------------

// factTrial is the slice of a trial row the fact sheet derives from.
// HasResults is a pointer so an absent field is distinguishable from false —
// the with/without-results lines are only emitted when EVERY row carries the
// field (a partial count would be exactly the miscounting we're preventing).
type factTrial struct {
	HasResults   *bool  `json:"has_results"`
	Enrollment   int    `json:"enrollment"`
	SponsorClass string `json:"sponsor_class"`
}

// factDrugSide is the slice of compare's drug_a/drug_b side the fact sheet
// derives from. sample_size is the number of trials the CLI pulled for the
// query — NOT a participant count; observed live, the model read "sample
// size 300" as 300 participants, so the emitted label spells that out.
type factDrugSide struct {
	SampleSize *int `json:"sample_size"`
}

// rankedLine formats {label,count} entries as "Not specified 5, N/A 4, Phase 4 1".
func rankedLine(entries []rankedEntry) string {
	parts := make([]string, 0, len(entries))
	for _, e := range entries {
		parts = append(parts, fmt.Sprintf("%s %d", e.Label, e.Count))
	}
	return strings.Join(parts, ", ")
}

// buildFactSheet derives an authoritative numeric fact block from the CLI
// result (aggregates plus counts over the trials array) so the model never
// has to count anything itself — small models demonstrably miscount ("5
// trials have no results" when all 10 had has_results=false). A missing or
// empty field omits its line entirely: no "0"/"unknown" placeholders, which
// would mislead the model. Returns "" when there is nothing to state.
func buildFactSheet(result any) string {
	var raw []byte
	switch v := result.(type) {
	case []byte:
		raw = v
	case json.RawMessage:
		raw = v
	case string:
		raw = []byte(v)
	default:
		enc, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		raw = enc
	}
	var obj struct {
		Returned          *int          `json:"returned"`
		TotalMatching     *int          `json:"total_matching"`
		SampleSize        *int          `json:"sample_size"`
		PhaseDistribution []rankedEntry `json:"phase_distribution"`
		TopCountries      []rankedEntry `json:"top_countries"`
		Trials            []factTrial   `json:"trials"`
		Results           []factTrial   `json:"results"`
		DrugA             *factDrugSide `json:"drug_a"`
		DrugB             *factDrugSide `json:"drug_b"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ""
	}
	rows := obj.Trials
	if len(rows) == 0 {
		rows = obj.Results
	}

	var lines []string
	if obj.Returned != nil {
		lines = append(lines, fmt.Sprintf("- trials returned: %d", *obj.Returned))
	}
	if obj.TotalMatching != nil {
		lines = append(lines, fmt.Sprintf("- total matching: %d", *obj.TotalMatching))
	}
	// sample_size counts trials pulled for the query, never participants —
	// the label must say so or the model states it as an enrollment figure.
	if obj.SampleSize != nil {
		lines = append(lines, fmt.Sprintf("- trials sampled for this analysis (not participant count): %d", *obj.SampleSize))
	}
	if obj.DrugA != nil && obj.DrugA.SampleSize != nil {
		lines = append(lines, fmt.Sprintf("- drug A trials sampled for this analysis (not participant count): %d", *obj.DrugA.SampleSize))
	}
	if obj.DrugB != nil && obj.DrugB.SampleSize != nil {
		lines = append(lines, fmt.Sprintf("- drug B trials sampled for this analysis (not participant count): %d", *obj.DrugB.SampleSize))
	}
	if len(rows) > 0 {
		withRes, counted := 0, 0
		for _, r := range rows {
			if r.HasResults != nil {
				counted++
				if *r.HasResults {
					withRes++
				}
			}
		}
		if counted == len(rows) {
			lines = append(lines,
				fmt.Sprintf("- trials with results reported: %d of %d", withRes, len(rows)),
				fmt.Sprintf("- trials without results: %d of %d", len(rows)-withRes, len(rows)))
		}
	}
	if len(obj.PhaseDistribution) > 0 {
		lines = append(lines, "- phase distribution: "+rankedLine(obj.PhaseDistribution))
	}
	if len(obj.TopCountries) > 0 {
		lines = append(lines, "- top countries: "+rankedLine(obj.TopCountries))
	}
	minE, maxE, haveE := 0, 0, false
	for _, r := range rows {
		if r.Enrollment > 0 {
			if !haveE {
				minE, maxE, haveE = r.Enrollment, r.Enrollment, true
				continue
			}
			if r.Enrollment < minE {
				minE = r.Enrollment
			}
			if r.Enrollment > maxE {
				maxE = r.Enrollment
			}
		}
	}
	if haveE {
		lines = append(lines, fmt.Sprintf("- enrollment range: %d to %d", minE, maxE))
	}
	classCounts := map[string]int{}
	for _, r := range rows {
		if c := strings.TrimSpace(r.SponsorClass); c != "" {
			classCounts[c]++
		}
	}
	if len(classCounts) > 0 {
		type classCount struct {
			label string
			n     int
		}
		classes := make([]classCount, 0, len(classCounts))
		for l, n := range classCounts {
			classes = append(classes, classCount{l, n})
		}
		sort.Slice(classes, func(i, j int) bool {
			if classes[i].n != classes[j].n {
				return classes[i].n > classes[j].n
			}
			return classes[i].label < classes[j].label
		})
		parts := make([]string, 0, len(classes))
		for _, c := range classes {
			parts = append(parts, fmt.Sprintf("%s %d", c.label, c.n))
		}
		lines = append(lines, "- sponsor classes: "+strings.Join(parts, ", "))
	}

	if len(lines) == 0 {
		return ""
	}
	return "PRE-COMPUTED FACTS (authoritative — use these exact numbers, do NOT recount):\n" +
		strings.Join(lines, "\n")
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
	// Post-validation against the FULL CLI JSON (pre-compaction): statements
	// referencing NCT IDs, countries, or numbers absent from the source are
	// removed or flagged. Observed live failure this guards against: a caveat
	// citing a nonexistent "Við Norway" trial for a dataset with no Norway.
	// The fact sheet is appended to the validation source so numbers the model
	// correctly copies from PRE-COMPUTED FACTS (derived counts like "3 of 25"
	// that never appear literally in the JSON) are not flagged as unverified.
	groundingSrc := cliJSON
	if fs := buildFactSheet(cliJSON); fs != "" {
		groundingSrc = append(append([]byte{}, cliJSON...), []byte("\n"+fs)...)
	}
	groundSynthesis(syn, groundingSrc)
	return syn, nil
}

// ---- synthesis post-validation (anti-hallucination) --------------------------

var (
	groundNCTRe = regexp.MustCompile(`NCT\d{8}`)
	groundNumRe = regexp.MustCompile(`\d[\d,]*%?`)
	srcNumRe    = regexp.MustCompile(`\d+`)
)

// countrySourceForms maps a canonical country to the spellings that count as
// evidence when found in the source JSON (CT.gov location names plus common
// variants).
var countrySourceForms = map[string][]string{
	"United States":  {"United States", "USA", "U.S."},
	"United Kingdom": {"United Kingdom", "UK", "England", "Scotland", "Wales", "Northern Ireland"},
	"South Korea":    {"Korea"},
	"Czechia":        {"Czechia", "Czech Republic"},
	"Türkiye":        {"Türkiye", "Turkey"},
}

// countryNames is the detection lexicon: names an LLM plausibly writes in a
// synthesis. Detection is word-boundary and case-sensitive (country names are
// capitalized in prose), which keeps common words like "china cabinet" from
// false-matching in lowercase text.
var countryNames = []string{
	"United States", "U.S.A.", "U.S.", "USA", "America",
	"United Kingdom", "U.K.", "Britain", "England", "Scotland", "Wales",
	"China", "Japan", "South Korea", "Korea", "India", "Pakistan", "Bangladesh",
	"Indonesia", "Malaysia", "Singapore", "Thailand", "Vietnam", "Philippines",
	"Taiwan", "Hong Kong", "Israel", "Iran", "Iraq", "Saudi Arabia", "Qatar",
	"United Arab Emirates", "Egypt", "Nigeria", "Kenya", "Ethiopia", "Ghana",
	"South Africa", "Morocco", "Tunisia", "Algeria", "Uganda", "Tanzania",
	"France", "Germany", "Italy", "Spain", "Portugal", "Netherlands", "Belgium",
	"Switzerland", "Austria", "Sweden", "Norway", "Denmark", "Finland", "Iceland",
	"Ireland", "Poland", "Czechia", "Czech Republic", "Slovakia", "Hungary",
	"Romania", "Bulgaria", "Greece", "Croatia", "Serbia", "Slovenia", "Ukraine",
	"Russia", "Belarus", "Estonia", "Latvia", "Lithuania", "Türkiye", "Turkey",
	"Canada", "Mexico", "Brazil", "Argentina", "Chile", "Colombia", "Peru",
	"Venezuela", "Ecuador", "Uruguay", "Cuba", "Australia", "New Zealand",
}

// countryDetectRe matches any lexicon name on word boundaries. Longer names
// are listed before their substrings (e.g. "South Korea" before "Korea") so
// the longest form wins.
var countryDetectRe = func() *regexp.Regexp {
	quoted := make([]string, 0, len(countryNames))
	for _, n := range countryNames {
		quoted = append(quoted, regexp.QuoteMeta(n))
	}
	return regexp.MustCompile(`(^|[^A-Za-z])(` + strings.Join(quoted, "|") + `)($|[^A-Za-z])`)
}()

// countryEvidenceForms returns the spellings that count as source evidence for
// a country name detected in synthesis text.
func countryEvidenceForms(name string) []string {
	switch name {
	case "U.S.", "U.S.A.", "USA", "America":
		name = "United States"
	case "U.K.", "Britain":
		name = "United Kingdom"
	case "Korea":
		name = "South Korea"
	}
	if forms, ok := countrySourceForms[name]; ok {
		return forms
	}
	return []string{name}
}

// ungroundedTokens returns every NCT ID, country name, and number in text that
// has no supporting occurrence in the source JSON. Percentages are exempt
// (the model may legitimately compute them from grounded counts), as are
// single-digit numbers (too noisy to police).
func ungroundedTokens(text, src, srcLower string, srcNums map[string]bool) []string {
	var probs []string
	seen := map[string]bool{}
	flag := func(tok string) {
		if !seen[tok] {
			seen[tok] = true
			probs = append(probs, tok)
		}
	}
	for _, id := range groundNCTRe.FindAllString(text, -1) {
		if !strings.Contains(src, id) {
			flag(id)
		}
	}
	for _, m := range countryDetectRe.FindAllStringSubmatch(text, -1) {
		name := m[2]
		grounded := false
		for _, form := range countryEvidenceForms(name) {
			if strings.Contains(srcLower, strings.ToLower(form)) {
				grounded = true
				break
			}
		}
		if !grounded {
			flag(name)
		}
	}
	for _, m := range groundNumRe.FindAllString(text, -1) {
		if strings.HasSuffix(m, "%") {
			continue
		}
		n := strings.ReplaceAll(m, ",", "")
		if len(n) < 2 {
			continue
		}
		if !srcNums[n] {
			flag(m)
		}
	}
	return probs
}

// groundSynthesis validates the parsed synthesis against the full CLI JSON:
// key points and caveats containing ungrounded references are DROPPED; a
// summary containing them is kept (it is one prose unit) but flagged. Either
// action sets GroundingNote, which the UI renders as a visible warning, so an
// unverified claim never appears in a factual tone without one.
func groundSynthesis(syn *llmSynthesis, source []byte) {
	src := string(source)
	srcLower := strings.ToLower(src)
	srcNums := map[string]bool{}
	for _, n := range srcNumRe.FindAllString(src, -1) {
		srcNums[n] = true
	}
	var flagged []string
	dropped := 0
	keep := func(items []string) []string {
		out := items[:0]
		for _, s := range items {
			if probs := ungroundedTokens(s, src, srcLower, srcNums); len(probs) > 0 {
				flagged = append(flagged, probs...)
				dropped++
				continue
			}
			out = append(out, s)
		}
		return out
	}
	syn.KeyPoints = keep(syn.KeyPoints)
	syn.Caveats = keep(syn.Caveats)
	summaryProbs := ungroundedTokens(syn.Summary, src, srcLower, srcNums)
	flagged = append(flagged, summaryProbs...)

	if dropped == 0 && len(summaryProbs) == 0 {
		return
	}
	uniq := make([]string, 0, len(flagged))
	seen := map[string]bool{}
	for _, f := range flagged {
		if !seen[f] {
			seen[f] = true
			uniq = append(uniq, f)
		}
	}
	list := strings.Join(uniq, ", ")
	if len(list) > 160 {
		list = list[:160] + "…"
	}
	note := "Post-validation: "
	if dropped > 0 {
		note += fmt.Sprintf("%d AI statement(s) removed for referencing data not present in the tool output", dropped)
	}
	if len(summaryProbs) > 0 {
		if dropped > 0 {
			note += "; "
		}
		note += "the summary contains unverified references — treat with caution"
	}
	note += " (unverified: " + list + ")."
	syn.GroundingNote = note
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
	// Some models echo the schema back: field names ("not_advice") or the
	// not-advice sentence land as list items. Strip those artifacts.
	syn.KeyPoints = stripFieldArtifacts(syn.KeyPoints, syn.NotAdvice)
	syn.Caveats = stripFieldArtifacts(syn.Caveats, syn.NotAdvice)
	return &syn, nil
}

// synthesisFieldNames are the response-schema keys a confused model sometimes
// emits as list CONTENT; any list item exactly matching one is an artifact.
var synthesisFieldNames = map[string]bool{
	"summary": true, "key_points": true, "caveats": true,
	"not_advice": true, "model": true, "grounding_note": true,
}

// normalizeSentence canonicalizes a sentence for duplicate comparison:
// lowercase, whitespace collapsed, trailing punctuation stripped.
func normalizeSentence(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.Trim(s, ".!?—-– ")
	return strings.Join(strings.Fields(s), " ")
}

// stripFieldArtifacts removes schema echoes and duplicates from a synthesis
// list: items that exactly match a known field name, single-token items with
// no space (field-name-like fragments, never a real sentence), items that
// essentially repeat the not_advice line, and repeated sentences within the
// same list.
func stripFieldArtifacts(items []string, notAdvice string) []string {
	seen := map[string]bool{normalizeSentence(notAdvice): true}
	out := items[:0]
	for _, s := range items {
		trimmed := strings.TrimSpace(s)
		if synthesisFieldNames[strings.ToLower(trimmed)] {
			continue
		}
		if !strings.ContainsAny(trimmed, " \t") {
			continue
		}
		n := normalizeSentence(trimmed)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, s)
	}
	return out
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
