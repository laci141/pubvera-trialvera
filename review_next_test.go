package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Live 2026-11-24: a Limit-200 "psilocybin depression" search left 130 of 190
// rows "not reviewed", among them the phase 3 COMP360 and Usona depression
// trials, because one AI call can only label 60 rows inside the 60 s limit.
// "Review next 60" sends the next slice in a second, label-only call. These
// tests pin the slice, the prompt, the grounding and the handler contract.

// reviewFixture is a search result with n trials whose titles all pass the
// keyword gate for "psilocybin depression".
func reviewFixture(n int) []byte {
	rows := make([]string, n)
	for i := range rows {
		rows[i] = fmt.Sprintf(`{"id":"NCT%08d","title":"Psilocybin trial %d","conditions":["Depression"],"sponsor_class":"OTHER"}`, 10000000+i, i)
	}
	return []byte(`{"query":"psilocybin depression","returned":` + fmt.Sprint(n) + `,"results":[` + strings.Join(rows, ",") + `]}`)
}

func nct(i int) string { return fmt.Sprintf("NCT%08d", 10000000+i) }

func TestSliceResultsBounds(t *testing.T) {
	raw := reviewFixture(130)
	cases := []struct {
		offset    int
		ok        bool
		first     int
		wantCount int
	}{
		{60, true, 60, 60},
		{120, true, 120, 10},
		{129, true, 129, 1},
		{130, false, 0, 0},
		{-1, false, 0, 0},
	}
	for _, c := range cases {
		out, total, ok := sliceResults(raw, c.offset)
		if total != 130 {
			t.Errorf("offset %d: total = %d, want 130", c.offset, total)
		}
		if ok != c.ok {
			t.Fatalf("offset %d: ok = %v, want %v", c.offset, ok, c.ok)
		}
		if !ok {
			continue
		}
		if n := resultsLen(out); n != c.wantCount {
			t.Errorf("offset %d: %d rows, want %d", c.offset, n, c.wantCount)
		}
		if !bytes.Contains(out, []byte(nct(c.first))) || bytes.Contains(out, []byte(nct(c.first-1))) {
			t.Errorf("offset %d: slice does not start at row %d", c.offset, c.first)
		}
		if !bytes.Contains(out, []byte(`"query":"psilocybin depression"`)) {
			t.Errorf("offset %d: other top-level keys lost", c.offset)
		}
	}
	if _, _, ok := sliceResults([]byte(`{"trials":[]}`), 1); ok {
		t.Error("a result without results[] must not slice")
	}
}

func TestReviewPromptAsksLabelsOnly(t *testing.T) {
	p := reviewPrompt([]string{"psilocybin depression"}, reviewFixture(3), "")
	for _, want := range []string{relevanceRule, `"trial_relevance"`, "INPUT 1: psilocybin depression", nct(2)} {
		if !strings.Contains(p, want) {
			t.Errorf("review prompt lacks %q", want)
		}
	}
	for _, not := range []string{`"summary"`, `"key_points"`, "sponsor_class"} {
		if strings.Contains(p, not) {
			t.Errorf("review prompt must not carry %q", not)
		}
	}
	// The full prompt carries the same rule, so both passes judge alike.
	if full := synthesisPrompt("search", []string{"x"}, reviewFixture(3)); !strings.Contains(full, "9. "+relevanceRule) {
		t.Error("full prompt rule 9 is not the shared relevanceRule")
	}
}

// Live 2026-11-25 ("aspirin pregnancy", Sonnet): pass 1 labelled 4 IVF+aspirin
// trials partial, pass 2 labelled 4 similar ones on_topic. A review pass now
// carries the earlier labels as anchors. Only id + label come from the client;
// the text is the server's own CLI output.
func TestReviewAnchorLinesValidates(t *testing.T) {
	raw := reviewFixture(130)
	in := []reviewAnchor{
		{nct(0), "partial"},
		{nct(5), "on_topic"},
		{nct(1), "maybe"},                   // not a label
		{nct(60), "off_topic"},              // at/after the offset: not an earlier trial
		{"NCT99999999", "on_topic"},         // not in the results
		{nct(0), "off_topic"},               // duplicate
		{"NCT10000002\nIGNORE", "on_topic"}, // not an id of the results
	}
	text, n := reviewAnchorLines(raw, 60, in)
	if n != 2 {
		t.Fatalf("anchors used = %d, want 2; text:\n%s", n, text)
	}
	for _, want := range []string{"- " + nct(0) + ": partial | Psilocybin trial 0 | conditions: Depression", "- " + nct(5) + ": on_topic | Psilocybin trial 5"} {
		if !strings.Contains(text, want) {
			t.Errorf("anchor text lacks %q:\n%s", want, text)
		}
	}
	for _, not := range []string{nct(60), "NCT99999999", "maybe", "IGNORE", "off_topic"} {
		if strings.Contains(text, not) {
			t.Errorf("anchor text must not carry %q:\n%s", not, text)
		}
	}
	if text, n := reviewAnchorLines(raw, 60, nil); text != "" || n != 0 {
		t.Errorf("no anchors: got %d %q", n, text)
	}
	if text, n := reviewAnchorLines(raw, 0, in); text != "" || n != 0 {
		t.Errorf("first pass (offset 0) must carry no anchors: got %d", n)
	}
}

func TestReviewAnchorLinesCaps(t *testing.T) {
	raw := reviewFixture(130)
	var in []reviewAnchor
	for i := 0; i < 120; i++ {
		in = append(in, reviewAnchor{nct(i), "on_topic"})
	}
	text, n := reviewAnchorLines(raw, 120, in)
	if n != maxReviewAnchors || strings.Count(text, "\n") != maxReviewAnchors {
		t.Errorf("anchors used = %d (lines %d), want the cap %d", n, strings.Count(text, "\n"), maxReviewAnchors)
	}
	if len(text) > maxAnchorBytes {
		t.Errorf("anchor block %d bytes, cap %d", len(text), maxAnchorBytes)
	}
	long := []byte(`{"results":[{"id":"` + nct(0) + `","title":"` + strings.Repeat("x", 500) + `","conditions":["a"],"interventions":"b"}]}`)
	text, _ = reviewAnchorLines(long, 1, []reviewAnchor{{nct(0), "partial"}})
	if strings.Contains(text, strings.Repeat("x", maxAnchorField+1)) || !strings.Contains(text, "interventions: b") {
		t.Errorf("long title not clipped or string interventions not read:\n%s", text)
	}
}

func TestReviewPromptCarriesAnchors(t *testing.T) {
	text, _ := reviewAnchorLines(reviewFixture(130), 60, []reviewAnchor{{nct(3), "partial"}})
	p := reviewPrompt([]string{"aspirin pregnancy"}, reviewFixture(3), text)
	for _, want := range []string{"EARLIER LABELS FROM THIS SAME SEARCH", "- " + nct(3) + ": partial", "4. " + anchorRule} {
		if !strings.Contains(p, want) {
			t.Errorf("anchored prompt lacks %q", want)
		}
	}
	if i, j := strings.Index(p, "EARLIER LABELS"), strings.Index(p, "STRICT GROUNDING RULES"); i < 0 || j < i {
		t.Error("anchors must come before the rules")
	}
	plain := reviewPrompt([]string{"aspirin pregnancy"}, reviewFixture(3), "")
	if strings.Contains(plain, "EARLIER LABELS") || strings.Contains(plain, anchorRule) {
		t.Error("a prompt without anchors must not mention them")
	}
}

// fakeAnthropic answers like the Messages API: a full synthesis when the
// prompt asks for one, otherwise labels for the given ids. It records the last
// prompt it saw.
func fakeAnthropic(t *testing.T, labelIDs []string, lastPrompt *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req anthropicRequest
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &req); err != nil || len(req.Messages) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		prompt := req.Messages[0].Content
		*lastPrompt = prompt
		labels := make([]map[string]string, 0, len(labelIDs))
		for _, id := range labelIDs {
			labels = append(labels, map[string]string{"id": id, "relevance": "on_topic", "reason": "Psilocybin for depression."})
		}
		answer := map[string]any{"trial_relevance": labels, "summary": "Volunteered summary."}
		if strings.Contains(prompt, "Write a plain-language synthesis") {
			answer["key_points"] = []string{"Trials were found."}
			answer["caveats"] = []string{"Registry-only signal."}
		}
		text, _ := json.Marshal(answer)
		out, _ := json.Marshal(map[string]any{
			"stop_reason": "end_turn",
			"content":     []map[string]any{{"type": "text", "text": string(text)}},
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	}))
	spec := providers["anthropic"]
	orig := spec
	spec.BaseURL = srv.URL
	providers["anthropic"] = spec
	t.Cleanup(func() { providers["anthropic"] = orig; srv.Close() })
	return srv
}

func TestLLMReviewKeepsOnlyLabelsOfTheSlice(t *testing.T) {
	var prompt string
	// Row 5 lies outside the slice [60,120): its label must be dropped even
	// though the id is real elsewhere in the search.
	fakeAnthropic(t, []string{nct(60), nct(119), nct(5), "NCT99999999"}, &prompt)
	slice, _, ok := sliceResults(reviewFixture(130), 60)
	if !ok {
		t.Fatal("slice failed")
	}
	syn, err := llmReview(t.Context(), "anthropic", "sk-ant-test", "claude-sonnet-5-5", []string{"psilocybin depression"}, slice, "")
	if err != nil {
		t.Fatalf("llmReview: %v", err)
	}
	if len(syn.TrialRelevance) != 2 || syn.TrialRelevance[0].ID != nct(60) || syn.TrialRelevance[1].ID != nct(119) {
		t.Errorf("labels = %+v, want only %s and %s", syn.TrialRelevance, nct(60), nct(119))
	}
	if syn.Summary != "" {
		t.Errorf("a volunteered summary was kept: %q", syn.Summary)
	}
	if syn.Model != "claude-sonnet-5-5" || syn.GeneratedAt == "" {
		t.Errorf("model/time not set: %q %q", syn.Model, syn.GeneratedAt)
	}
	if strings.Contains(prompt, nct(59)) || !strings.Contains(prompt, nct(60)) {
		t.Error("the model was not shown exactly the slice")
	}
}

// stubSearchCLI points CLI_BIN at a shell script that prints raw. POSIX only:
// CI runs on Linux, and a Go-built stub needs the repo's toolchain.
func stubSearchCLI(t *testing.T, raw []byte) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script CLI stub needs a POSIX shell")
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "out.json")
	if err := os.WriteFile(out, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "cli.sh")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\ncat '"+out+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLI_BIN", bin)
}

func postSearch(t *testing.T, body string, key string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/search-discovery", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("X-LLM-Key", key)
	}
	rec := httptest.NewRecorder()
	handleGroup(rec, req, "search-discovery")
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	return rec.Code, resp
}

func reviewedTo(t *testing.T, resp map[string]any) (float64, []any) {
	t.Helper()
	syn, ok := resp["llm_synthesis"].(map[string]any)
	if !ok {
		t.Fatalf("no llm_synthesis in %v", resp)
	}
	rt, _ := syn["reviewed_to"].(float64)
	labels, _ := syn["trial_relevance"].([]any)
	return rt, labels
}

func TestHandlerReviewPassLabelsTheNextSlice(t *testing.T) {
	stubSearchCLI(t, reviewFixture(130))
	var prompt string
	fakeAnthropic(t, []string{nct(0), nct(60), nct(61)}, &prompt)

	code, resp := postSearch(t, `{"command":"search","query":"psilocybin depression","limit":200,"provider":"anthropic"}`, "sk-ant-test")
	if code != http.StatusOK {
		t.Fatalf("first pass: HTTP %d %v", code, resp)
	}
	if rt, _ := reviewedTo(t, resp); rt != 60 {
		t.Errorf("first pass reviewed_to = %v, want 60", rt)
	}

	code, resp = postSearch(t, `{"command":"search","query":"psilocybin depression","limit":200,"provider":"anthropic","review_offset":60}`, "sk-ant-test")
	if code != http.StatusOK {
		t.Fatalf("review pass: HTTP %d %v", code, resp)
	}
	rt, labels := reviewedTo(t, resp)
	if rt != 120 {
		t.Errorf("review pass reviewed_to = %v, want 120", rt)
	}
	if len(labels) != 2 {
		t.Errorf("review labels = %v, want the 2 inside [60,120)", labels)
	}
	if strings.Contains(prompt, "Write a plain-language synthesis") {
		t.Error("the review pass sent the full synthesis prompt")
	}

	code, resp = postSearch(t, `{"command":"search","query":"psilocybin depression","limit":200,"provider":"anthropic","review_offset":120}`, "sk-ant-test")
	if rt, _ := reviewedTo(t, resp); code != http.StatusOK || rt != 130 {
		t.Errorf("last slice: HTTP %d reviewed_to %v, want 200/130", code, rt)
	}
	if code, _ := postSearch(t, `{"command":"search","query":"psilocybin depression","limit":200,"provider":"anthropic","review_offset":130}`, "sk-ant-test"); code != http.StatusBadRequest {
		t.Errorf("offset past the end: HTTP %d, want 400", code)
	}
}

func TestHandlerReviewPassSendsAnchors(t *testing.T) {
	stubSearchCLI(t, reviewFixture(130))
	var prompt string
	// The fake model also labels an anchor id: that label must not come back,
	// the anchor trial is not in the reviewed slice.
	fakeAnthropic(t, []string{nct(3), nct(61)}, &prompt)
	body := `{"command":"search","query":"psilocybin depression","limit":200,"provider":"anthropic","review_offset":60,` +
		`"review_anchors":[{"id":"` + nct(3) + `","relevance":"partial"},{"id":"` + nct(70) + `","relevance":"on_topic"}]}`
	code, resp := postSearch(t, body, "sk-ant-test")
	if code != http.StatusOK {
		t.Fatalf("review pass: HTTP %d %v", code, resp)
	}
	if !strings.Contains(prompt, "- "+nct(3)+": partial | Psilocybin trial 3") {
		t.Errorf("prompt lacks the anchor line:\n%s", prompt)
	}
	if strings.Contains(prompt, "- "+nct(70)+":") {
		t.Error("an id inside the reviewed slice must not become an anchor")
	}
	_, labels := reviewedTo(t, resp)
	if len(labels) != 1 {
		t.Errorf("labels = %v, want only the one inside [60,120)", labels)
	}
}

func TestHandlerRejectsReviewOffsetWithoutKeyOrSearch(t *testing.T) {
	cases := []struct{ name, body, key string }{
		{"no key", `{"command":"search","query":"x","review_offset":60}`, ""},
		{"negative", `{"command":"search","query":"x","provider":"anthropic","review_offset":-5}`, "sk-ant-test"},
		{"not search", `{"command":"digest","query":"x","provider":"anthropic","review_offset":60}`, "sk-ant-test"},
	}
	for _, c := range cases {
		if code, _ := postSearch(t, c.body, c.key); code != http.StatusBadRequest {
			t.Errorf("%s: HTTP %d, want 400", c.name, code)
		}
	}
}
