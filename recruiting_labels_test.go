package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Live 2026-11-26: recruiting "long covid" with an AI key gave a summary but
// no per-trial labels, while its list held clear off-topic trials (healthy
// volunteers, allopurinol, a dysphagia registry). recruiting returns a trial
// list for a free-text query just like search, so it gets the same labels and
// the same "Review next" passes.

// recruitingFixture is the recruiting CLI shape: the list is "trials", not "results".
func recruitingFixture(n int) []byte {
	rows := make([]string, n)
	for i := range rows {
		rows[i] = fmt.Sprintf(`{"id":"NCT%08d","title":"Long covid trial %d","conditions":["Long COVID"],"status":"RECRUITING"}`, 10000000+i, i)
	}
	return []byte(`{"query":"long covid","total_matching":` + fmt.Sprint(n) + `,"returned":` + fmt.Sprint(n) + `,"trials":[` + strings.Join(rows, ",") + `]}`)
}

func TestRelevanceCmdsAreSearchAndRecruiting(t *testing.T) {
	if len(relevanceCmds) != 2 || !relevanceCmds["search"] || !relevanceCmds["recruiting"] {
		t.Errorf("relevanceCmds = %v, want exactly search and recruiting", relevanceCmds)
	}
	raw := recruitingFixture(3)
	if p := synthesisPrompt("recruiting", []string{"long covid"}, raw); !strings.Contains(p, relevanceRule) || !strings.Contains(p, `"trial_relevance"`) {
		t.Error("recruiting prompt lacks relevanceRule or the trial_relevance field")
	}
	if p := synthesisPrompt("risk", []string{"NCT10000000"}, raw); strings.Contains(p, relevanceRule) || strings.Contains(p, `"trial_relevance"`) {
		t.Error("risk prompt must not ask for trial_relevance")
	}
}

func TestSliceResultsReadsTrialsList(t *testing.T) {
	raw := recruitingFixture(130)
	if n := resultsLen(raw); n != 130 {
		t.Errorf("resultsLen = %d, want 130", n)
	}
	out, total, ok := sliceResults(raw, 120)
	if !ok || total != 130 {
		t.Fatalf("sliceResults ok=%v total=%d, want true/130", ok, total)
	}
	if n := resultsLen(out); n != 10 {
		t.Errorf("slice holds %d trials, want 10", n)
	}
}

func postRecruiting(t *testing.T, body, key string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/recruiting-watch", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("X-LLM-Key", key)
	}
	rec := httptest.NewRecorder()
	handleGroup(rec, req, "recruiting-watch")
	return rec.Code, rec.Body.String()
}

func TestReviewOffsetValidationAcceptsRecruitingOnly(t *testing.T) {
	// A missing CLI makes the accepted request fail later; only the
	// validation message matters here.
	t.Setenv("CLI_BIN", "/nonexistent/trialvera-cli")
	_, body := postRecruiting(t, `{"command":"recruiting","condition":"long covid","provider":"anthropic","review_offset":60}`, "sk-ant-test")
	if strings.Contains(body, "review_offset needs") {
		t.Errorf("recruiting review_offset rejected by validation: %s", body)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/trial-analysis", strings.NewReader(`{"command":"risk","nctid":"NCT10000000","provider":"anthropic","review_offset":60}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-LLM-Key", "sk-ant-test")
	rec := httptest.NewRecorder()
	handleGroup(rec, req, "trial-analysis")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "review_offset needs") {
		t.Errorf("risk review_offset: HTTP %d %s, want 400 review_offset needs…", rec.Code, rec.Body.String())
	}
}

func TestHandlerRecruitingReviewPass(t *testing.T) {
	stubSearchCLI(t, recruitingFixture(130))
	var prompt string
	fakeAnthropic(t, []string{nct(0), nct(60), nct(61)}, &prompt)
	code, body := postRecruiting(t, `{"command":"recruiting","condition":"long covid","limit":200,"provider":"anthropic"}`, "sk-ant-test")
	var resp map[string]any
	_ = json.Unmarshal([]byte(body), &resp)
	if code != http.StatusOK {
		t.Fatalf("first pass: HTTP %d %s", code, body)
	}
	if rt, _ := reviewedTo(t, resp); rt != 60 {
		t.Errorf("first pass reviewed_to = %v, want 60", rt)
	}
	code, body = postRecruiting(t, `{"command":"recruiting","condition":"long covid","limit":200,"provider":"anthropic","review_offset":60}`, "sk-ant-test")
	resp = nil
	_ = json.Unmarshal([]byte(body), &resp)
	if code != http.StatusOK {
		t.Fatalf("review pass: HTTP %d %s", code, body)
	}
	if rt, labels := reviewedTo(t, resp); rt != 120 || len(labels) != 2 {
		t.Errorf("review pass reviewed_to=%v labels=%v, want 120 and 2", rt, labels)
	}
}
