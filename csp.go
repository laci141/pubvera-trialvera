package main

import "crypto/rand"

// Content-Security-Policy, phase 2: every <script> tag in index.html
// carries nonce="__CSP_NONCE__", and each index response replaces that marker
// with a fresh nonce named in the policy header. The policy is enforced: a
// script without the response's nonce is blocked.
//
// Style phase S2: the one <style> tag carries the same marker, and the same
// enforcing policy names that nonce in style-src. A <style> without the nonce
// and any style= attribute are blocked. No Report-Only header is sent.
const (
	nonceMarker   = "__CSP_NONCE__"
	cspHeaderName = "Content-Security-Policy"
)

// nonceRandRead is the random source for the CSP nonce. It is a variable only
// so a test can make it fail.
var nonceRandRead = rand.Read

// contentSecurityPolicy is the policy for the index page. 'unsafe-inline' and
// https: are the backward-compatibility fallback for browsers that predate
// nonces and 'strict-dynamic'; browsers that understand nonce plus
// 'strict-dynamic' (Chrome 52+, Firefox 52+, Safari 15.4+) ignore both.
// style-src uses the same nonce as script-src; style-src-attr 'none' blocks
// every style= attribute (index.html has none; styles are set via CSSOM).
func contentSecurityPolicy(nonce string) string {
	return "script-src 'nonce-" + nonce + "' 'strict-dynamic' https: 'unsafe-inline'; script-src-attr 'none'; style-src 'nonce-" + nonce + "'; style-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
}
