#!/usr/bin/env node
// burn-after-reading: once Claude has seen an image, PDF or huge tool output, take it out of the Claude Code transcript.
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { burnFile, projectSessions, findSession } from '../src/transcript.js'
import { runHook } from '../src/hook.js'
import { SUPPORTED_LANGS } from '../src/text.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const HELP = `burn-after-reading ${VERSION}
Take images, PDFs (and, if you ask, huge tool outputs) that Claude has already seen out of a Claude Code
transcript, leaving a short placeholder. The next --resume / --continue no longer re-sends them.

Usage:
  burn-after-reading [options] <transcript.jsonl | session-id>...
  burn-after-reading [options] --latest      the most recent session of the project in this folder
  burn-after-reading [options] --all         every session of the project in this folder
  burn-after-reading hook                    for Claude Code hooks (PostToolUse, SessionEnd); reads the event on stdin

Options:
  -n, --dry-run          show what would be burned; change nothing
  --keep <n>             leave the n most recent seen images/PDFs in place (default 0)
  --text-over <chars>    also shorten text tool results longer than this (default: off)
  --lang <en|zh>         language of the placeholders (default en)
  --no-backup            don't keep the text-only backup (backups never contain the images)
  --force                burn even if the session is open in Claude Code right now
  --json                 print the report as JSON
  -q, --quiet            print nothing unless something goes wrong
  -h, --help             this help
  -v, --version          the version

Exit status: 0 done (or nothing to do), 1 error, 2 refused (session open, or it changed while burning).`

function parseArgs(argv) {
  const o = { targets: [], dryRun: false, keep: 0, textOver: 0, lang: 'en', backup: true, force: false, json: false, quiet: false, latest: false, all: false }
  const num = (v, name) => {
    if (v === undefined || !/^\d+$/.test(v)) throw new Error(`${name} needs a whole number`)
    return Number(v)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-n' || a === '--dry-run') o.dryRun = true
    else if (a === '--keep') o.keep = num(argv[++i], '--keep')
    else if (a === '--text-over') o.textOver = num(argv[++i], '--text-over')
    else if (a === '--lang') { o.lang = argv[++i]; if (!SUPPORTED_LANGS.includes(o.lang)) throw new Error(`--lang is one of ${SUPPORTED_LANGS.join(', ')}`) }
    else if (a === '--no-backup') o.backup = false
    else if (a === '--force') o.force = true
    else if (a === '--json') o.json = true
    else if (a === '-q' || a === '--quiet') o.quiet = true
    else if (a === '--latest') o.latest = true
    else if (a === '--all') o.all = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (a === '-v' || a === '--version') o.version = true
    else if (a.startsWith('-')) throw new Error(`unknown option ${a} (see --help)`)
    else o.targets.push(a)
  }
  return o
}

const mb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
function describe(r, dryRun) {
  if (r.refused) return `${r.sessionId}: not burned: ${r.refused}`
  const count = (k) => r.burned.filter(b => b.kind === k).length
  const parts = [['image', 'images'], ['pdf', 'PDFs'], ['text', 'long text results']]
    .map(([k, plural]) => [count(k), k === 'image' ? 'image' : k === 'pdf' ? 'PDF' : 'long text result', plural])
    .filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  const lines = []
  if (!parts.length) lines.push(`${r.sessionId}: nothing to burn`)
  else {
    const tokens = r.burned.reduce((s, b) => s + (b.tokens ?? 0), 0)
    lines.push(`${r.sessionId}: ${dryRun ? 'would burn' : 'burned'} ${parts.join(', ')} (${mb(r.bytesBefore)} -> ${mb(r.bytesAfter)}${tokens ? `, about ${tokens.toLocaleString('en-US')} fewer input tokens on every later request` : ''})`)
  }
  const left = []
  if (r.unseen) left.push(`${r.unseen} Claude has not answered yet`)
  if (r.kept) left.push(`${r.kept} kept by --keep`)
  if (left.length) lines.push(`  left in place: ${left.join(', ')}`)
  for (const s of r.skipped) lines.push(`  line ${s.line + 1} left unchanged: ${s.reason}`)
  const other = Object.entries(r.elsewhere ?? {})
  if (other.length) lines.push(`  note: image data is also stored in records this tool doesn't edit (${other.map(([t, n]) => `${n} in "${t}"`).join(', ')}); Claude Code may have changed its format, please open an issue`)
  if (r.backupFile) lines.push(`  backup (text only): ${r.backupFile}`)
  return lines.join('\n')
}

async function readStdin() {
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === 'hook') {
    // a hook must never break the session: errors go to stderr, the exit status stays 0
    try {
      const input = JSON.parse((await readStdin()) || '{}')
      const out = runHook(input)
      if (out) process.stdout.write(out)
    } catch (e) { process.stderr.write(`burn-after-reading hook: ${e?.message ?? e}\n`) }
    return 0
  }
  let o
  try { o = parseArgs(argv) } catch (e) { process.stderr.write(`burn-after-reading: ${e.message}\n`); return 1 }
  if (o.help) { process.stdout.write(HELP + '\n'); return 0 }
  if (o.version) { process.stdout.write(VERSION + '\n'); return 0 }
  const files = []
  if (o.latest || o.all) {
    const all = projectSessions(process.cwd())
    if (!all.length) { process.stderr.write(`burn-after-reading: no Claude Code sessions found for ${process.cwd()}\n`); return 1 }
    files.push(...(o.all ? all : all.slice(0, 1)))
  }
  for (const t of o.targets) {
    const f = t.endsWith('.jsonl') ? resolve(t) : findSession(t)
    if (!f || !existsSync(f)) { process.stderr.write(`burn-after-reading: can't find ${t}\n`); return 1 }
    files.push(f)
  }
  if (!files.length) { process.stderr.write(HELP + '\n'); return 1 }
  let status = 0
  const reports = []
  for (const f of files) {
    try {
      const r = burnFile(f, { dryRun: o.dryRun, keep: o.keep, textOver: o.textOver, lang: o.lang, backup: o.backup, force: o.force })
      reports.push(r)
      if (r.refused) status = Math.max(status, 2)
      if (!o.json && !o.quiet) process.stdout.write(describe(r, o.dryRun) + '\n')
      else if (!o.json && r.refused) process.stderr.write(describe(r, o.dryRun) + '\n')
    } catch (e) {
      process.stderr.write(`burn-after-reading: ${f}: ${e?.message ?? e}\n`)
      status = 1
    }
  }
  if (o.json) process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) + '\n')
  return status
}

main().then(code => { process.exitCode = code })
