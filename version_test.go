package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// /version reports the CalVer build version the release workflow stamps into
// the binary with -ldflags "-X main.appVersion=...". An unstamped build says
// "dev".
//
// Every request goes through newMux(), the route table main() serves, so a
// missing registration fails here. No Authorization header is sent: /version
// is outside /api/, which is all Caddy's forward_auth covers.

func serveMux(t *testing.T, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func TestVersionDefaultDev(t *testing.T) {
	rec := serveMux(t, http.MethodGet, "/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (no auth header sent)", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want application/json; charset=utf-8", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if body := rec.Body.String(); body != "{\"version\":\"dev\"}\n" {
		t.Errorf("body = %q, want {\"version\":\"dev\"} and a newline", body)
	}
}

func TestVersionStamped(t *testing.T) {
	old := appVersion
	appVersion = "2026.10.27.1"
	t.Cleanup(func() { appVersion = old })
	rec := serveMux(t, http.MethodGet, "/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if body["version"] != "2026.10.27.1" || len(body) != 1 {
		t.Errorf("body = %v, want {\"version\":\"2026.10.27.1\"}", body)
	}
}

func TestVersionHead(t *testing.T) {
	rec := serveMux(t, http.MethodHead, "/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("HEAD Cache-Control = %q, want no-store", cc)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD body = %q, want empty", rec.Body.String())
	}
}

func TestVersionRejectsPost(t *testing.T) {
	rec := serveMux(t, http.MethodPost, "/version")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Errorf("Allow = %q, want \"GET, HEAD\"", allow)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] == "" {
		t.Errorf("body %q is not a JSON error", rec.Body.String())
	}
}

// Moving the routes out of main() into newMux() must keep the existing ones.
// A group route answers a GET with handleGroup's 405 "use POST"; a missing
// registration would fall to handleRoot's 404 instead.
func TestRoutesStillRegistered(t *testing.T) {
	rec := serveMux(t, http.MethodGet, "/healthz")
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Errorf("GET /healthz: status = %d body = %q, want 200 \"ok\"", rec.Code, rec.Body.String())
	}
	cases := []struct {
		path string
		want int
	}{
		{"/config.json", http.StatusOK},
		{"/nope", http.StatusNotFound},
		{"/api/search-discovery", http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		if rec := serveMux(t, http.MethodGet, tc.path); rec.Code != tc.want {
			t.Errorf("GET %s: status = %d, want %d", tc.path, rec.Code, tc.want)
		}
	}
}
