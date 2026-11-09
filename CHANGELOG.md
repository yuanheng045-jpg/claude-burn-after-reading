# Changelog

## 0.1.0 (2026-11-09)

First release.

- Burn images and PDFs Claude has already answered from a Claude Code transcript, including Claude Code's private
  copies (`toolUseResult`, and the `api-request-blob` copy in 2.1.3xx).
- `PostToolUse` hook numbers images and PDFs when Claude sees them; the number stays in the placeholder.
- `SessionEnd` hook burns automatically when a session closes.
- Optional shortening of long text tool results (`--text-over`).
- Refuses sessions that are open in Claude Code (the hook also waits if the session is open in another window);
  atomic writes; lines it doesn't edit are written back byte for byte; text-only backups (last three per session,
  30 days).
- API error rows don't count as Claude having seen something.
- English and Chinese placeholders.
- Packaged as a Claude Code plugin; also a CLI and a library.
- End-to-end tests against the real Claude Code CLI (2.1.281, 2.1.319) with a local fake API.
