# burn-after-reading for Claude Code

[![CI](https://github.com/yuanheng045-jpg/claude-burn-after-reading/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanheng045-jpg/claude-burn-after-reading/actions/workflows/ci.yml)

[中文说明](README.zh-CN.md)

Once Claude has seen an image or a PDF (and, if you want, a huge tool output), this takes it out of the Claude Code
transcript and leaves a one-line note in its place. Resumed sessions stop sending it again on every request.

```
before   {"type":"image","source":{"type":"base64","data":"iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4CAIAAA…  (1.2 MB)
after    [image #7 burned after reading · Read /home/me/shot.png · 2026-11-09 14:32 · read the file again if you need it]
```

## Why

- **Tokens.** Every image Claude has looked at goes out again with every later request of that conversation:
  each time you `--resume` or `--continue`, and on every turn in apps that resume a session per message.
  A screenshot is about 1,500 input tokens each time.
- **Privacy.** Screenshots, scans and documents stay in `~/.claude/projects/…` indefinitely, and Claude Code keeps a
  second copy of each one next to it.
- **Size.** A few screenshots turn a transcript into megabytes, and very large transcripts are slow, or fail, to resume.

Claude Code has no way to drop one image from a conversation (`/compact` summarises everything). This does only that.

## How it works

1. **Claude is told the number.** When a tool returns an image or PDF, a `PostToolUse` hook adds a note next to it:
   *"This image is #7. After this turn it is removed from the conversation and only "image #7" stays here, so if you
   will want to remember what it shows, say it in your reply."* Claude writes down what matters in its own words, once.
2. **The session ends, the image goes.** A `SessionEnd` hook rewrites the transcript: every image or PDF that Claude has
   already answered becomes a placeholder with its number, where it came from and when. Claude Code's private copy
   of the same data is emptied too. Anything Claude hasn't answered yet is left alone.
3. **The next resume is clean.** `claude --resume` / `--continue` loads the placeholder instead of the image.

## Install

Needs Node.js 18.17 or newer on your `PATH`.

### As a Claude Code plugin (recommended)

In Claude Code:

```
/plugin marketplace add yuanheng045-jpg/claude-burn-after-reading
/plugin install burn-after-reading@burn-after-reading
```

That installs both hooks. Nothing else to set up.

### By hand

```bash
npm install -g github:yuanheng045-jpg/claude-burn-after-reading
```

Then add the hooks to `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Read|mcp__.*", "hooks": [{ "type": "command", "command": "burn-after-reading hook", "timeout": 10 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "burn-after-reading hook", "timeout": 30 }] }
    ]
  }
}
```

Leave out the `PostToolUse` part if you don't want images numbered.

### Hook options

Set these in the `"env"` block of the same settings file:

| Variable | Default | |
|---|---|---|
| `BURN_AFTER_READING_LANG` | `en` | `zh` for Chinese placeholders and notes |
| `BURN_AFTER_READING_KEEP` | `0` | leave the newest *n* seen images/PDFs in place |
| `BURN_AFTER_READING_TEXT_OVER` | off | also shorten text tool results longer than this many characters (the start is kept) |
| `BURN_AFTER_READING_LABELS` | on | `0`: don't number images |
| `BURN_AFTER_READING_BACKUP` | on | `0`: don't keep the text-only backup |

## Command line

Burn sessions yourself, for example old ones from before you installed the hooks:

```bash
burn-after-reading --latest --dry-run       # what would go, from the newest session of this folder's project
burn-after-reading --all                    # every session of this folder's project
burn-after-reading 0f0f0f0f-1111-4222-8333-444444444444
burn-after-reading ~/.claude/projects/-home-me-app/0f0f0f0f-….jsonl --keep 2 --text-over 20000
```

Without installing: `npx github:yuanheng045-jpg/claude-burn-after-reading --latest --dry-run`.

| Option | |
|---|---|
| `-n, --dry-run` | show what would be burned; change nothing |
| `--keep <n>` | leave the newest *n* seen images/PDFs |
| `--text-over <chars>` | also shorten text tool results longer than this |
| `--lang <en\|zh>` | placeholder language |
| `--no-backup` | don't keep the text-only backup |
| `--force` | burn a session even though it is open in Claude Code |
| `--json` | machine-readable report |
| `-q, --quiet` | print only problems |

Exit status: `0` done or nothing to do, `1` error, `2` refused (session open, or the file changed while burning).

## What it guarantees

- **Only what Claude has answered.** An image counts as seen once Claude has replied after it. API error messages
  that Claude Code writes itself (overloaded, usage limit…) don't count as a reply.
- **It never edits a session that is open.** The command line refuses a session that Claude Code has open (it checks
  Claude Code's own list of running sessions). The hook runs as the session closes; if the same session is also open
  in another window, it waits for that one to close. (An open session keeps the conversation in memory and would not
  see the change anyway.)
- **Only the data goes.** The number and order of lines, every id and link, the pairing of tool calls and results,
  and every word you or Claude wrote stay exactly as they were. Each edited line is checked against that before it
  is written; a line that fails the check is left untouched and reported. Lines it doesn't edit are written back
  byte for byte.
- **Safe writes.** Temp file, `fsync`, atomic rename, original file permissions kept. If the transcript changes while
  it is being burned, nothing is written.
- **Backups, without the images.** The last three versions before a burn are kept per session in
  `~/.claude/burn-after-reading/backups/` for 30 days, with all image and PDF data taken out: enough to undo a
  mistake, never a copy of what you wanted gone.
- **Idempotent.** Running it again changes nothing.
- **Tested against the real thing.** Besides unit tests, the test suite drives the real Claude Code CLI (2.1.281 and
  2.1.319 tested) against a local stand-in for the API, so no account and no network are needed: a burned
  session resumes, and its next request carries the placeholder and not the image. This also runs in CI.

## Limits

- **It takes effect on the next load.** Claude Code keeps an open conversation in memory, so within one long open
  session the image stays until the session is resumed (or compacted). Apps that run `claude -p --resume` per
  message benefit from the next message on.
- **One prompt-cache rebuild.** Changing earlier messages means the next request rebuilds the cache from the first
  burned spot. Burning at session end means that usually happens after a pause, when the cache has expired anyway.
- **The transcript format is not documented** and changes between Claude Code versions. This tool edits only what it
  recognises, and says so if image data turns up in a kind of record it doesn't know: please open an issue then.
- Images attached to a message (the way SDK apps send them, tested) are burned too, but not numbered: the
  placeholder says "attached by the user". Pasting into the interactive terminal is not covered by the tests yet.

## For app developers

If your app keeps a Claude Code process running (stream-json input), stop it, burn, and resume:

```js
import { burnFile } from 'claude-burn-after-reading'   // npm i github:yuanheng045-jpg/claude-burn-after-reading

const report = burnFile(transcriptPath, { keep: 0, lang: 'en' })   // { burned, skipped, bytesBefore, bytesAfter, … }
```

`burnLines(lines, options)` is the same thing without any file access.

## Related

[cozempic](https://github.com/Ruya-AI/cozempic) prunes Claude Code context with many strategies, images among them.
burn-after-reading does one thing: removes what Claude has already seen, automatically, at the moment it is safe to.

## License

MIT
