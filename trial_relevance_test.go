package main

import (
	"fmt"
	"strings"
	"testing"
)

// Live 2026-11-24: an "intermittent fasting" search kept two cilostazol
// trials because their condition is "Intermittent Claudication". The model
// labels them; these tests pin what survives the cleaning.
const relevanceSource = `{"results":[` +
	`{"id":"NCT00602407","title":"Bioequivalency Study of 50 mg Cilostazol Tablets Under Fasting Conditions"},` +
	`{"id":"NCT04283942","title":"Effect of Intermittent Calorie Restriction on MASLD Patients"}]}`

func TestCleanTrialRelevanceKeepsGroundedLabels(t *testing.T) {
	in := []trialRelevance{
		{ID: "NCT00602407", Relevance: "off_topic", Reason: "Drug bioavailability under fasting conditions, not dietary fasting."},
		{ID: " nct04283942 ", Relevance: "ON_TOPIC", Reason: " Intermittent calorie restriction. "},
	}
	got := cleanTrialRelevance(in, []byte(relevanceSource))
	if len(got) != 2 {
		t.Fatalf("kept %d entries, want 2: %+v", len(got), got)
	}
	if got[0].ID != "NCT00602407" || got[0].Relevance != "off_topic" {
		t.Errorf("entry 0 = %+v", got[0])
	}
	if got[1].ID != "NCT04283942" || got[1].Relevance != "on_topic" || got[1].Reason != "Intermittent calorie restriction." {
		t.Errorf("entry 1 not normalized: %+v", got[1])
	}
}

func TestCleanTrialRelevanceDropsInventedAndInvalid(t *testing.T) {
	in := []trialRelevance{
		{ID: "NCT99999999", Relevance: "on_topic", Reason: "not in the tool output"},
		{ID: "NCT00602407", Relevance: "maybe", Reason: "label outside the three allowed"},
		{ID: "cilostazol", Relevance: "off_topic", Reason: "not an NCT ID"},
		{ID: "NCT04283942", Relevance: "partial", Reason: "first"},
		{ID: "NCT04283942", Relevance: "off_topic", Reason: "duplicate"},
	}
	got := cleanTrialRelevance(in, []byte(relevanceSource))
	if len(got) != 1 || got[0].ID != "NCT04283942" || got[0].Reason != "first" {
		t.Fatalf("got %+v, want only the first NCT04283942 entry", got)
	}
}

func TestCleanTrialRelevanceCapsReason(t *testing.T) {
	long := strings.Repeat("é", maxRelevanceReason+50)
	got := cleanTrialRelevance([]trialRelevance{{ID: "NCT00602407", Relevance: "off_topic", Reason: long}}, []byte(relevanceSource))
	if len(got) != 1 || len([]rune(got[0].Reason)) != maxRelevanceReason {
		t.Fatalf("reason not capped to %d runes: %d", maxRelevanceReason, len([]rune(got[0].Reason)))
	}
}

func TestParseSynthesisReadsTrialRelevance(t *testing.T) {
	syn, err := parseSynthesis(`{"summary":"s","key_points":["a b"],"caveats":[],"trial_relevance":[{"id":"NCT00602407","relevance":"off_topic","reason":"r"}],"not_advice":"n"}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(syn.TrialRelevance) != 1 || syn.TrialRelevance[0].ID != "NCT00602407" {
		t.Fatalf("trial_relevance not parsed: %+v", syn.TrialRelevance)
	}
}

func TestSynthesisPromptAsksRelevanceOnlyForSearch(t *testing.T) {
	src := []byte(relevanceSource)
	search := synthesisPrompt("search", []string{"intermittent fasting"}, src)
	if !strings.Contains(search, `"trial_relevance"`) || !strings.Contains(search, "off_topic") {
		t.Error("search prompt does not ask for trial_relevance")
	}
	other := synthesisPrompt("digest", []string{"asthma"}, src)
	if strings.Contains(other, "trial_relevance") {
		t.Error("non-search prompt asks for trial_relevance")
	}
}

func TestSynthesisPromptAsksWhyStopped(t *testing.T) {
	p := synthesisPrompt("search", []string{"x"}, []byte(relevanceSource))
	if !strings.Contains(p, "why_stopped field, give that stated reason") {
		t.Error("prompt does not ask for the why_stopped reason")
	}
}

// A Limit-200 search must reach the model with 60 trials, so 60 can be
// labelled (live 2026-11-24: 163 of 188 rows said "not reviewed" at 25).
func TestRelevanceCoversSixtyTrials(t *testing.T) {
	if maxEntriesForLLM != 60 || maxTrialRelevance != 60 {
		t.Fatalf("caps = %d/%d, want 60/60", maxEntriesForLLM, maxTrialRelevance)
	}
	var b strings.Builder
	b.WriteString(`{"results":[`)
	for i := 0; i < 200; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"id":"NCT%08d","title":"Trial %d","conditions":["Long COVID"],"interventions":["Drug X"],"status":"COMPLETED"}`, i, i)
	}
	b.WriteString(`]}`)
	p := synthesisPrompt("search", []string{"Long COVID"}, []byte(b.String()))
	if !strings.Contains(p, "NCT00000059") || strings.Contains(p, "NCT00000060") {
		t.Error("prompt does not carry exactly the first 60 trials")
	}
	if strings.Contains(p, "truncated mid-JSON") {
		t.Error("60 trials overflowed the prompt byte cap")
	}
}
