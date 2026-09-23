# Security policy

## Reporting a vulnerability

Please report security issues privately by email to **diego@aiwithdiego.com**. Do not open a public issue or pull request for a vulnerability.

Include what you found, where (file and line, or the steps in the app), and how to reproduce it. A proof of concept helps. Please test only against your own machine and your own data.

I'll acknowledge your report within 5 working days and keep you updated until it's resolved. If you'd like credit, I'm happy to name you in the fix.

## Scope

Haven is a local desktop app. The most useful reports are about:

- the approval card showing something different from what actually runs
- a way for agent output, a document, a link or a project folder to run code, read files or change permissions without the user's approval
- the renderer reaching the main process outside the IPC actions it is allowed to call
- dictation, capture or the packaged app being usable to borrow Haven's macOS permissions

Bugs in Claude Code, Codex or their MCP servers belong with those projects.

## Supported versions

Only the latest commit on `main` is supported.
