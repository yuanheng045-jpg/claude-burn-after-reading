# Changelog

## 0.1.0 (2026-11-09)

First release.

- Burn images and PDFs Claude has already answered from a Claude Code transcript, including Claude Code's private
  copies (`toolUseResult`, and the `api-request-blob` copy in 2.1.3xx) and the transcripts of the subagents a session
  ran (`<session>/subagents/`).
- `PostToolUse` hook numbers images and PDFs when Claude sees them; the number stays in the placeholder.
- `SessionEnd` hook burns automatically when a session closes.
- Per kind of thing (images attached to a message, tool screenshots, files read, very long text), choose
  keep / archive / burn. Archive keeps a copy Claude can read again (written atomically, reused only if identical,
  deleted after 30 days); burn also deletes Claude Code's own saved file of an attached image, when it is certain which
  file belongs to which image. Defaults: archive attached images, burn the rest, keep text.
- `/burn-after-reading:settings` in Claude Code asks with checkboxes and saves (allowed to run its own settings
  command only); `burn-after-reading settings` on the command line shows and changes the same settings, including
  which environment variables override them.
- Options passed in code are checked; a wrong value throws.
- Refuses sessions that are open in Claude Code (the hook also waits if the session is open in another window);
  atomic writes; lines it doesn't edit are written back byte for byte; text-only backups (last three per session,
  30 days).
- API error rows don't count as Claude having seen something.
- English and Chinese placeholders.
- Packaged as a Claude Code plugin; also a CLI and a library.
- End-to-end tests against the real Claude Code CLI with a local fake API, in CI on Linux, macOS and Windows with
  Claude Code 2.1.281 and the latest.
