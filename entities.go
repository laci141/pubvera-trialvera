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
// are kept, and so is the key order of every object: the web table takes its
// columns from that order (see appendObjectFields), so this rewrites the token
// stream instead of re-encoding through a map. Best-effort: any error returns
// raw unchanged.
func decodeEntities(raw []byte) []byte {
	if !bytes.Contains(raw, []byte("&")) && !bytes.Contains(raw, []byte(`\u0026`)) {
		return raw
	}
	if !json.Valid(raw) {
		return raw
	}
	type frame struct {
		object bool // object (true) or array (false)
		n      int  // tokens written so far: keys and values in an object, elements in an array
	}
	var stack []frame
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	writeString := func(s string) bool {
		if err := enc.Encode(s); err != nil {
			return false
		}
		buf.Truncate(buf.Len() - 1) // Encode appends '\n'
		return true
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	started := false
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return raw
		}
		started = true
		// Separator before this token; a closing delimiter needs none.
		isKey := false
		if d, ok := tok.(json.Delim); !ok || (d != '}' && d != ']') {
			if len(stack) > 0 {
				top := &stack[len(stack)-1]
				switch {
				case top.object && top.n%2 == 0:
					isKey = true
					if top.n > 0 {
						buf.WriteByte(',')
					}
				case top.object:
					buf.WriteByte(':')
				case top.n > 0:
					buf.WriteByte(',')
				}
				top.n++
			}
		}
		switch t := tok.(type) {
		case json.Delim:
			buf.WriteByte(byte(t))
			switch t {
			case '{':
				stack = append(stack, frame{object: true})
			case '[':
				stack = append(stack, frame{})
			default:
				stack = stack[:len(stack)-1]
			}
		case string:
			if !isKey {
				t = html.UnescapeString(t)
			}
			if !writeString(t) {
				return raw
			}
		case json.Number:
			buf.WriteString(t.String())
		case bool:
			if t {
				buf.WriteString("true")
			} else {
				buf.WriteString("false")
			}
		case nil:
			buf.WriteString("null")
		default:
			return raw
		}
	}
	if len(stack) != 0 || !started {
		return raw
	}
	return buf.Bytes()
}
