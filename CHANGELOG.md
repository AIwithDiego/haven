# Changelog

## Unreleased (case study)
- README rewritten as a case study: what Haven is, what it got right, and why I deleted it 21 days after the first commit.
- How-it-works diagram (`docs/how-it-works.svg`) and a cover image; screenshots moved to `docs/assets/` and named for what they show.
- CONTRIBUTING, issue and PR templates added; SECURITY kept.
- Status changed from "a personal project I use every day" to retired (12 October 2026). The code stays as published in 0.5.0.

## v0.5.0 · 24 September 2026
- First public release: a calm macOS workspace for Claude Code, Codex and real terminals as named tasks, after a full security review (approval card, scoped reads, folder trust, Electron fuses, link checks).
- CI on macOS with unit tests, typecheck, build and a full-history gitleaks scan; Dependabot updates grouped (#11).
