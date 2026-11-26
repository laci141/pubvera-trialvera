package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// Live 2026-11-26: ClinicalTrials.gov returns "Sjogren&#39;s Syndrome" for
// NCT04806620 and the CLI passes it through into every export.

func decodedString(t *testing.T, out []byte, key string) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("output is not valid JSON: %v (%s)", err, out)
	}
	s, _ := m[key].(string)
	return s
}

func TestDecodeEntitiesNumeric(t *testing.T) {
	if got := decodedString(t, decodeEntities([]byte(`{"c":"Sjogren&#39;s Syndrome"}`)), "c"); got != "Sjogren's Syndrome" {
		t.Errorf("got %q, want Sjogren's Syndrome", got)
	}
}

func TestDecodeEntitiesNamed(t *testing.T) {
	if got := decodedString(t, decodeEntities([]byte(`{"c":"A &amp; B"}`)), "c"); got != "A & B" {
		t.Errorf("got %q, want A & B", got)
	}
}

func TestDecodeEntitiesSinglePass(t *testing.T) {
	if got := decodedString(t, decodeEntities([]byte(`{"c":"x &amp;amp; y"}`)), "c"); got != "x &amp; y" {
		t.Errorf("got %q, want x &amp; y", got)
	}
}

func TestDecodeEntitiesEscapedAmpersandForm(t *testing.T) {
	if got := decodedString(t, decodeEntities([]byte(`{"c":"Crohn\u0026#39;s Disease"}`)), "c"); got != "Crohn's Disease" {
		t.Errorf("got %q, want Crohn's Disease", got)
	}
}

func TestDecodeEntitiesQuoteStaysValid(t *testing.T) {
	out := decodeEntities([]byte(`{"c":"say &quot;hi&quot;"}`))
	if !json.Valid(out) {
		t.Fatalf("output not valid JSON: %s", out)
	}
	if got := decodedString(t, out, "c"); got != `say "hi"` {
		t.Errorf("got %q, want say \"hi\"", got)
	}
}

func TestDecodeEntitiesKeysUntouched(t *testing.T) {
	out := decodeEntities([]byte(`{"a&amp;b":"x&#39;y"}`))
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["a&amp;b"]; !ok {
		t.Errorf("key was changed: %s", out)
	}
	if m["a&amp;b"] != "x'y" {
		t.Errorf("value not decoded: %s", out)
	}
}

func TestDecodeEntitiesNumbersUnchanged(t *testing.T) {
	out := decodeEntities([]byte(`{"big":12345678901234567890,"n":100500,"c":"&amp;"}`))
	if !bytes.Contains(out, []byte(`12345678901234567890`)) || !bytes.Contains(out, []byte(`100500`)) {
		t.Errorf("numbers changed: %s", out)
	}
}

func TestDecodeEntitiesNoEntitySameBytes(t *testing.T) {
	in := []byte(`{"b":1,  "a":"plain"}`)
	out := decodeEntities(in)
	if !bytes.Equal(in, out) {
		t.Errorf("got %s, want identical %s", out, in)
	}
}

func TestDecodeEntitiesInvalidUnchanged(t *testing.T) {
	in := []byte(`{"c":"&amp;"`)
	if out := decodeEntities(in); !bytes.Equal(in, out) {
		t.Errorf("got %s, want unchanged", out)
	}
}

func TestDecodeEntitiesNoHTMLEscapeInOutput(t *testing.T) {
	out := decodeEntities([]byte(`{"c":"a &lt; b &gt; c"}`))
	if !bytes.Contains(out, []byte(`a < b > c`)) {
		t.Errorf("< or > escaped in output: %s", out)
	}
}

func TestDecodeEntitiesNested(t *testing.T) {
	out := decodeEntities([]byte(`{"trials":[{"conditions":["Sjogren&#39;s Syndrome","Ulcerative Colitis and Crohn&#39;s Disease"]}]}`))
	var m struct {
		Trials []struct {
			Conditions []string `json:"conditions"`
		} `json:"trials"`
	}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Trials) != 1 || len(m.Trials[0].Conditions) != 2 ||
		m.Trials[0].Conditions[0] != "Sjogren's Syndrome" ||
		m.Trials[0].Conditions[1] != "Ulcerative Colitis and Crohn's Disease" {
		t.Errorf("nested not decoded: %s", out)
	}
}

func TestDecodeEntitiesTrailingDataUnchanged(t *testing.T) {
	in := []byte(`{"c":"&amp;"} {"d":1}`)
	if out := decodeEntities(in); !bytes.Equal(in, out) {
		t.Errorf("got %s, want unchanged", out)
	}
}

func TestHandlerRecruitingDecodesEntities(t *testing.T) {
	stubSearchCLI(t, []byte(`{"query":"sjogren","total_matching":1,"returned":1,"trials":[{"id":"NCT04806620","title":"Sjogren trial","conditions":["Sjogren&#39;s Syndrome"],"status":"RECRUITING"}]}`))
	code, body := postRecruiting(t, `{"command":"recruiting","condition":"sjogren","limit":10}`, "")
	if code != 200 {
		t.Fatalf("HTTP %d %s", code, body)
	}
	var resp map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}
	res := string(resp["result"])
	if !strings.Contains(res, "Sjogren's Syndrome") || strings.Contains(res, "&#39;") {
		t.Errorf("result not decoded: %s", res)
	}
}

func TestDecodeEntitiesKeepsKeyOrder(t *testing.T) {
	got := decodeEntities([]byte(`{"id":"NCT1","title":"A&amp;B","status":"S","phase":"P"}`))
	want := `{"id":"NCT1","title":"A&B","status":"S","phase":"P"}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestDecodeEntitiesKeepsNestedKeyOrder(t *testing.T) {
	got := decodeEntities([]byte(`{"z":{"z":"a&#39;b","a":1,"m":[{"z":"c&#39;d","a":true,"m":null}]},"a":[{"z":2,"a":"e&#39;f","m":"g"}],"m":"h"}`))
	want := `{"z":{"z":"a'b","a":1,"m":[{"z":"c'd","a":true,"m":null}]},"a":[{"z":2,"a":"e'f","m":"g"}],"m":"h"}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestDecodeEntitiesEntityKeyKeepsTextAndOrder(t *testing.T) {
	got := decodeEntities([]byte(`{"z":"1","a&amp;b":"x&amp;y","b":"2"}`))
	want := `{"z":"1","a&amp;b":"x&y","b":"2"}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

func TestDecodeEntitiesNumberLiteralText(t *testing.T) {
	got := decodeEntities([]byte(`{"p":1.50,"e":1e3,"c":"&amp;"}`))
	want := `{"p":1.50,"e":1e3,"c":"&"}`
	if string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}
