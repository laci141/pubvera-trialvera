package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Live 2026-11-24: deepseek-v4-pro ran past the AI time budget and the reader
// saw "read response: context deadline exceeded". A provider slower than the
// deadline must now produce the plain timeout message naming the model.
func TestSlowModelTimeoutMessage(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush() // headers out, body never finishes
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	spec := providers["deepseek"]
	orig := spec
	spec.BaseURL = srv.URL
	providers["deepseek"] = spec
	defer func() { providers["deepseek"] = orig }()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, err := llmSynthesize(ctx, "deepseek", "sk-test-key", "deepseek-v4-pro", "search", []string{"Long COVID"}, []byte(`{"results":[]}`))
	if err == nil {
		t.Fatal("want a timeout error, got success")
	}
	msg := err.Error()
	if strings.Contains(msg, "context deadline exceeded") {
		t.Errorf("raw Go error reached the reader: %q", msg)
	}
	if !strings.Contains(msg, "deepseek-v4-pro did not answer within 60 seconds") || !strings.Contains(msg, "deepseek-flash") {
		t.Errorf("timeout message not actionable: %q", msg)
	}
}
