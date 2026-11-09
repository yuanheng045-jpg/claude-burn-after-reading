# burn-after-reading

[![CI](https://github.com/yuanheng045-jpg/claude-burn-after-reading/actions/workflows/ci.yml/badge.svg)](https://github.com/yuanheng045-jpg/claude-burn-after-reading/actions/workflows/ci.yml)

[中文说明](README.zh-CN.md)

**Images and PDFs that Claude has already looked at are taken out of the conversation when it ends, leaving one
line in their place.** For [Claude Code](https://claude.com/claude-code).

```
before   a screenshot (1.2 MB of image data)
after    [image #7 burned after reading · Read /home/me/shot.png · 2026-11-09 14:32 · read the file again if you need it]
```

## What it does for you

**1. Fewer tokens: less of your plan's usage, or less money on the API**
Every time Claude Code sends a message, it sends the whole conversation again, every image included.
A screenshot is about 1,500 tokens; the line that replaces it is about 30.
Say you come back to a conversation that had 10 screenshots and send 100 more messages: about 1.5 million fewer
tokens sent. (Most of what is sent again is read from Claude's prompt cache, which costs about a tenth as much,
so the money or usage saved is smaller than that number. The room saved, point 2, is not.)

**2. Longer conversations**
Images take up room in the conversation. When it fills up, Claude Code compresses the earlier part into a summary
and details are lost. With the images gone there is more room, so that happens later.

**3. Privacy**
Screenshots, ID photos, scans: Claude Code keeps several copies of each on your computer, with no end date: in the
conversation file, in the files of any helper Claude ("subagent") that looked at them, and in its temp folder.
This removes them. What you choose to archive is kept as an ordinary file (not encrypted) in
`~/.claude/burn-after-reading/archive/` for 30 days; for photos you'd rather not keep at all, set attached images to burn.

**4. Smaller files that resume reliably**
A few screenshots make a conversation file several megabytes. Smaller files resume faster and don't fail for being too big.

## Install (two steps)

**Step 1: check that Node.js is on your computer**

Open a terminal (on Windows "Command Prompt" or "PowerShell", on a Mac "Terminal"), type this and press Enter:

```
node --version
```

- If you see `v18` or higher (for example `v22.11.0`): fine, go to step 2.
- If it says the command isn't found: download the LTS version from [nodejs.org](https://nodejs.org), install it like any
  other program, and try this step again.

**Step 2: type two lines in Claude Code**

Open Claude Code, type the first line and press Enter; when it says it worked, type the second and press Enter:

```
/plugin marketplace add yuanheng045-jpg/claude-burn-after-reading
```
```
/plugin install burn-after-reading@burn-after-reading
```

That's it, nothing else to set up. It starts working the next time a conversation ends.

**Want to see that it works?** Type `/burn-after-reading:settings` in Claude Code; the "Recently" part at the bottom
lists what it has burned.

## What happens, step by step

1. **When a tool brings Claude an image or PDF** (a file it reads, a screenshot…), it tells Claude: "This image is #7.
   After this turn it is removed from the conversation and only "image #7" stays here, so if you will want to remember
   what it shows, say it in your reply." So Claude notes what matters, in its own words, once.
   (Images you attach yourself don't get a number; by default they are archived, so Claude can look again.)
2. **When the conversation ends**, images and PDFs Claude has answered are handled as you chose: burned, archived, or kept.
   Anything Claude hasn't answered yet is left alone. The same goes for what its helpers (subagents) looked at.
3. **The next time you continue the conversation**, Claude reads that one line instead of the image.

## Change what it does

Type this in Claude Code:

```
/burn-after-reading:settings
```

Claude shows you a few checkbox questions, one per kind of thing, and saves your answers. You can change them any time.

| Kind | Default | Why |
|---|---|---|
| Images attached to a message (ones you paste or send) | **archive** | otherwise Claude could never get them back |
| Images and PDFs from tools (web page screenshots…) | **burn** | they can be taken again |
| Images and PDFs read from files | **burn** | the file is still on your computer |
| Very long text results (logs of tens of thousands of characters…) | **keep** | Claude may still need the details |

The three choices:
- **keep**: leave it in the conversation.
- **archive**: take it out of the conversation but save a copy that Claude reads when it wants to look again.
  Copies older than 30 days are deleted the next time it runs.
- **burn**: take it out and delete it, including Claude Code's own extra copies.

(The backups it keeps never contain images or PDFs. A long text you burn does stay in the text-only backup for
30 days; turn backups off with `backup=off` if you don't want that.)

## When Claude wants to look again

The line it leaves says where the thing came from:

- **Archived**: the line says where the copy is; Claude reads that file.
- **Read from a file**: the file is still there; Claude reads it again.
- **A tool screenshot**: Claude takes it again (and sees what is there now).
- **Something you sent, burned**: you would have to send it again.

And what Claude wrote in its reply when it saw the image is always still there; usually that is enough.

## Questions

**Can it break my conversations?**
No. It only swaps image data for a line of text and changes nothing else; every edit is checked first and skipped if
anything doesn't match. It also keeps the file as it was before, minus the images and PDFs, for 30 days, in case text
ever has to be put back by hand. All of this is tested against the real Claude Code; see "For the technically minded" below.

**Why is the image still there while a conversation is open?**
Claude Code keeps an open conversation in memory, which no outside tool can change. So it burns when the
conversation closes, and the next time you continue it, it is clean.

**Claude asks me whether it may read the archive?**
The archive lives in Claude Code's settings folder, not in your project, so Claude Code may ask first. Allow it.

**Does the archive keep growing?**
No. Copies older than 30 days are deleted the next time it runs. You can change the number of days in the settings.

**What are subagents, and are their images handled?**
For some tasks Claude starts helpers (subagents) that do part of the work; Claude Code keeps what each one did in a
file of its own, images included. Those files are handled too, the same way, when the conversation ends.

**Does it work with a Claude subscription and with an API key?**
Both. On the API, what it saves is real money.

**How do I uninstall it?**
Type `/plugin uninstall burn-after-reading@burn-after-reading` in Claude Code. Its own files (settings, archive,
backups) are in `~/.claude/burn-after-reading/`; delete that folder if you don't want them.

## For the technically minded

### Hooks without the plugin

```bash
npm install -g github:yuanheng045-jpg/claude-burn-after-reading
```

Then add to `~/.claude/settings.json` (all projects) or `.claude/settings.json` (one project):

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

### Command line

```bash
burn-after-reading --latest --dry-run       # what would go, from the newest conversation of this folder's project
burn-after-reading --all                    # every conversation of this project (older ones, for example), subagents included
burn-after-reading <session id or path to the .jsonl>
burn-after-reading settings                 # the settings and what happened lately
burn-after-reading settings user=burn text=archive text-over=30000 lang=zh
```

Without installing: `npx github:yuanheng045-jpg/claude-burn-after-reading --latest --dry-run`.

Settings: `user` `screenshot` `file` `text` (each `keep` / `archive` / `burn`), `text-over` (characters that count as
very long, default 20000), `archive-days` (default 30), `keep-latest` (leave the newest n, default 0), `lang` (`en` / `zh`),
`labels` (numbering on/off), `backup` (on/off). They are saved in `~/.claude/burn-after-reading/settings.json`;
environment variables `BURN_AFTER_READING_<NAME>` override them, e.g. `BURN_AFTER_READING_LANG=zh` (`settings` shows
which ones are in effect).

One-run options: `--dry-run`, `--keep <n>`, `--text-over <chars>`, `--lang <en|zh>`, `--no-backup`, `--force`, `--json`, `--quiet`.
Exit status: `0` done or nothing to do, `1` error, `2` refused (conversation open, or the file changed while burning).

### What it guarantees

- **Only what Claude has answered.** Something counts as seen once Claude has replied after it; API error messages
  that Claude Code writes itself don't count.
- **Never an open conversation.** The command line refuses a session Claude Code has open (it checks Claude Code's own
  list of running sessions); the hook runs as the session closes, and waits if the same session is open in another window.
- **Only the data goes.** Line count and order, every id and link, tool call/result pairing and every word stay as they
  were; each edited line is checked and left untouched if the check fails; lines it doesn't edit are written back byte for byte.
- **All the copies.** The one in the conversation, Claude Code's private ones (`toolUseResult`, `api-request-blob`),
  the ones in the transcripts of the subagents the conversation ran (`<session>/subagents/`), and the image file Claude
  Code saves in the temp folder for an attached image. That file is deleted only when it is certain which image it
  belongs to (exactly one `[Image: source: …]` line per image of the message) and it really is Claude Code's: a regular
  file of yours, in `<session>/images/` inside the temp folder, after resolving links. Otherwise it is left.
- **Safe writes.** Temp file, `fsync`, atomic rename, file permissions kept; nothing is written if the file changes
  meanwhile. Archive copies are written the same way first (on macOS and Linux readable only by you), and an existing copy is reused only
  if its content is exactly the same.
- **Backups without images.** The last three versions before a burn, per conversation, in `~/.claude/burn-after-reading/backups/`, for 30 days.
- **Idempotent**, also after a partial run (for example after `--keep`).
- **A dry run changes nothing**, not even the archive's clean-up.
- **The settings command can only change settings.** Its permission covers its own `settings` command and nothing else.
- **Tested against the real thing.** Besides unit tests, the suite drives the real Claude Code CLI against a local
  stand-in for the API, so no account and no network are needed. It checks that burned conversations resume and the
  resumed request carries the placeholder and not the image; that an attached image is archived, Claude Code's temp copy
  is deleted and Claude can read the archive back; PDFs; images a subagent looked at; and the plugin: installed, it
  numbers images, burns at the end, and its settings command shows the settings and saves a change. CI runs this on
  Linux, macOS and Windows with Claude Code 2.1.281 and the latest, on every change and weekly, to catch Claude Code
  format changes early.

### Limits

- It takes effect the next time a conversation is loaded (see the questions above). Apps that run `claude -p --resume`
  per message benefit from the next message on.
- Changing earlier messages means the next request rebuilds the prompt cache from the first burned spot. Burning when a
  conversation ends means that usually happens after a pause, when the cache has expired anyway.
- The transcript format isn't documented and changes between versions. It edits only what it recognises, and tells you
  if image data shows up somewhere it doesn't know; please open an issue then.
- Images you attach to a message aren't numbered when Claude sees them (no hook gets to see them); they are archived
  by default instead.
- Pasting into the interactive terminal isn't covered by the automated tests yet (images sent with a message are).

### For developers

```js
import { burnSession, burnFile, burnLines } from 'claude-burn-after-reading'   // npm i github:yuanheng045-jpg/claude-burn-after-reading

const report = burnSession(transcriptPath)   // saved settings; or pass { modes: { user: 'burn' }, lang: 'zh', dryRun: true }
```

`burnSession` burns a conversation and its subagents (`report.subagents`); `burnFile` one transcript file. Options are
checked: a wrong value throws instead of doing something else. If your app keeps a Claude Code process running, stop
it, burn, and resume. `burnLines(lines, options)` does the same without touching files.

### Related

[cozempic](https://github.com/Ruya-AI/cozempic) prunes Claude Code context with many strategies, images among them.
This one does one thing: removes what Claude has already seen, automatically, when it is safe to.

## License

MIT
