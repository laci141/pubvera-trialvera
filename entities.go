package main

import (
	"bytes"
	"encoding/json"
	"html"
	"io"
)

// decodeEntities decodes HTML entities (&#39;, &amp;, &quot;, ...) in every
// JSON string value of raw, once. ClinicalTrials.gov returns registry text
// HTML-escaped and the CLI passes it through. Keys, numbers and other types
// are kept. Best-effort: any error returns raw unchanged.
func decodeEntities(raw []byte) []byte {
	if !bytes.Contains(raw, []byte("&")) && !bytes.Contains(raw, []byte(`\u0026`)) {
		return raw
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return raw
	}
	if _, err := dec.Token(); err != io.EOF {
		return raw
	}
	v = unescapeValues(v)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return raw
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func unescapeValues(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			t[k] = unescapeValues(val)
		}
		return t
	case []any:
		for i, val := range t {
			t[i] = unescapeValues(val)
		}
		return t
	case string:
		return html.UnescapeString(t)
	default:
		return v
	}
}
