package main

import (
	"encoding/json"
	"net/http"
)

// appVersion is the CalVer build version (YYYY.MM.DD.N). The release workflow
// stamps it with -ldflags "-X main.appVersion=..." (the linker names the main
// package "main", not its module path); a local or pull request build keeps
// "dev". GET /version reports it and the page footer shows it.
var appVersion = "dev"

// handleVersion returns {"version":"<appVersion>"}. no-store, so the footer
// never shows the version of an image that has since been replaced. GET and
// HEAD only; anything else is a JSON 405 naming both. HEAD sends no body.
func handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"version": appVersion})
}
