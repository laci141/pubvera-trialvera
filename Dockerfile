# syntax=docker/dockerfile:1
#
# Stage 1 builds the clinical-trials CLI from one pinned upstream
# printing-press-library commit with go install. It used to be a PRE-BUILT
# linux/amd64 binary (bin/clinical-trials-pp-cli-linux) made by vendor-cli.sh,
# and nothing in the image said which upstream source that binary came from.
# The commit is now stamped on the image as the label org.pubvera.cli.commit.
#
# The pin is 8342ee9 (2026-10-13, upstream #2311: list keys always present; #2298 first_posted on normalized
# trials, used by the BibTeX export). Each app pins its own commit. Between
# 58edea3 and 926bcb7, a control run of the 15 data commands this server calls
# (old vs new binary, same inputs, back to back) gave byte-identical output for
# 12; search, phase3 and recruiting only gained "first_posted" lines, none
# removed. Earlier pins: 58edea3 (2026.9.14), c1b64a3 (2026.9.12, the old
# vendored binary).
#
# PP_LIBRARY_COMMIT is declared before the first FROM so it is global. An ARG
# declared after a FROM exists only in that stage; each stage that needs the
# value re-declares it with a bare ARG and inherits this default. Declaring
# the default inside the builder stage only left the label empty on
# pubvera-recallis (measured 2026-09-24), and CI now fails on that.
#
# Stage 2 builds the web server for linux/amd64 from ./main.go.
ARG PP_LIBRARY_COMMIT=ed2dc468034a913f84c470d9f1339fc901683992

FROM golang:1.27.2-alpine AS cli-builder
ARG PP_LIBRARY_COMMIT
RUN CGO_ENABLED=0 go install -trimpath \
    github.com/mvanhorn/printing-press-library/library/health/clinical-trials/cmd/clinical-trials-pp-cli@${PP_LIBRARY_COMMIT}

FROM golang:1.27.2-alpine AS web-builder
WORKDIR /build
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/server .

# Pinned to the 3.24 branch instead of latest, like Recallis, Retractis,
# Grantvera and Bibliovera. The running image reported 3.24.2 in
# /etc/alpine-release before this change, so the pin keeps the same base
# and only stops a silent jump to the next Alpine release.
FROM alpine:3.24
# ca-certificates: the CLI calls ClinicalTrials.gov / PubMed / OpenAlex / FAERS
# over HTTPS (and LLM providers when a BYOK key is supplied).
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
WORKDIR /app
COPY --from=web-builder /out/server ./server
COPY --from=cli-builder /go/bin/clinical-trials-pp-cli ./bin/clinical-trials-pp-cli
COPY index.html ./index.html
RUN chmod +x ./bin/clinical-trials-pp-cli

# The upstream commit the CLI was built from, readable with docker inspect.
ARG PP_LIBRARY_COMMIT
LABEL org.pubvera.cli.commit=${PP_LIBRARY_COMMIT}

ENV CLI_BIN=/app/bin/clinical-trials-pp-cli
# The server binds 127.0.0.1:8091 unless ADDR or PORT says otherwise. It runs on
# the Hetzner box (pubvera-01) behind Caddy, which terminates HTTPS and applies
# forward_auth — see the pubvera-infra repo. The comment here used to say Render
# sets $PORT; that was true before the move and is not now, and render.yaml,
# deleted alongside this edit, claimed the same thing.
EXPOSE 8091
USER app
CMD ["./server"]
