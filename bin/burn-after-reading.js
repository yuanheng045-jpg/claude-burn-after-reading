#!/usr/bin/env node
// burn-after-reading: once Claude has seen an image, PDF or huge tool output, take it out of the Claude Code transcript.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { burnSession, projectSessions, findSession, atomicWrite } from '../src/transcript.js'
import { runHook } from '../src/hook.js'
import { configDir, dataDir } from '../src/paths.js'
import { loadSettings, saveSettings, withEnv, settingsFile, KEYS, DEFAULTS, MODES } from '../src/settings.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const HELP = `burn-after-reading ${VERSION}
Take images, PDFs (and, if you choose, very long tool outputs) that Claude has already seen out of a Claude Code
transcript, leaving a short placeholder. The next --resume / --continue no longer re-sends them.

Usage:
  burn-after-reading [options] <transcript.jsonl | session-id>...
  burn-after-reading [options] --latest      the most recent session of the project in this folder
  burn-after-reading [options] --all         every session of the project in this folder
                                             (a session's subagents are burned with it)
  burn-after-reading settings                show what is burned, archived or kept, and what happened lately
  burn-after-reading settings key=value...   change it, e.g. settings user=burn text=archive lang=zh
  burn-after-reading settings reset          back to the defaults
  burn-after-reading hook                    for Claude Code hooks (PostToolUse, SessionEnd); reads the event on stdin

Options (for this run only; the saved settings are used otherwise):
  -n, --dry-run          show what would be burned; change nothing
  --keep <n>             leave the n most recent seen images/PDFs in place
  --text-over <chars>    also shorten text tool results longer than this
  --lang <en|zh>         language of the placeholders
  --no-backup            don't keep the text-only backup (backups never contain the images)
  --force                burn even if the session is open in Claude Code right now
  --json                 print the report as JSON
  -q, --quiet            print nothing unless something goes wrong
  -h, --help             this help
  -v, --version          the version

Exit status: 0 done (or nothing to do), 1 error, 2 refused (session open, or it changed while burning).`

function parseArgs(argv) {
  const o = { targets: [], dryRun: false, json: false, quiet: false, latest: false, all: false, force: false, run: {} }
  const num = (v, name, min = 0) => {
    if (v === undefined || !/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} needs a whole number${min ? ` of at least ${min}` : ''}`)
    return Number(v)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-n' || a === '--dry-run') o.dryRun = true
    else if (a === '--keep') o.run.keep = num(argv[++i], '--keep')
    else if (a === '--text-over') o.run.textOver = num(argv[++i], '--text-over', 1)   // turns long text on if it is set to keep
    else if (a === '--lang') { o.run.lang = argv[++i]; if (!['en', 'zh'].includes(o.run.lang)) throw new Error('--lang is en or zh') }
    else if (a === '--no-backup') o.run.backup = false
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

// ---- settings, in the words of the chosen language ----
const WORDS = {
  en: {
    title: 'burn-after-reading settings',
    rows: { user: 'Images attached to a message', screenshot: 'Images and PDFs from tools (screenshots…)', file: 'Images and PDFs read from files', text: 'Very long text results' },
    mode: { keep: 'keep: leave it in the conversation', archive: 'archive: burn it, keep a copy Claude can read again', burn: 'burn: destroy it' },
    longer: (n) => `("very long" = more than ${n.toLocaleString('en-US')} characters)`,
    other: (s) => [`Archive copies are deleted after ${s.archiveDays} days`, `Newest seen images left in place: ${s.keepLatest}`, `Placeholder language: ${s.lang}`,
      `Tell Claude each image's number when it sees it: ${s.labels ? 'on' : 'off'}`, `Text-only backups: ${s.backup ? 'on' : 'off'}`],
    recent: 'Recently:', none: '(nothing yet: it runs when a Claude Code session ends)',
    env: 'Set by environment variables (these win over the saved settings):',
    change: 'Change with: burn-after-reading settings user=burn|archive|keep screenshot=… file=… text=… text-over=20000 archive-days=30 keep-latest=0 lang=en|zh labels=on|off backup=on|off',
  },
  zh: {
    title: '阅后即焚 设置',
    rows: { user: '跟着消息一起发来的图', screenshot: '工具拿回来的图和 PDF（截图等）', file: '从文件读进来的图和 PDF', text: '很长的文字结果' },
    mode: { keep: '不动：留在对话里', archive: '存档：烧掉，但留一份 Claude 能再翻的', burn: '销毁：彻底烧掉' },
    longer: (n) => `（"很长" = 超过 ${n} 个字）`,
    other: (s) => [`存档 ${s.archiveDays} 天后自动删除`, `最近看过的图先留几张：${s.keepLatest}`, `说明用的语言：${s.lang}`,
      `Claude 看图时告诉它编号：${s.labels ? '开' : '关'}`, `纯文字备份：${s.backup ? '开' : '关'}`],
    recent: '最近：', none: '（还没有：Claude Code 的对话结束时才会运行）',
    env: '下面这些被环境变量改过（以环境变量为准）：',
    change: '修改：burn-after-reading settings user=burn|archive|keep screenshot=… file=… text=… text-over=20000 archive-days=30 keep-latest=0 lang=en|zh labels=on|off backup=on|off',
  },
}
/** The settings in effect: saved ones, with environment variables on top (as the hooks see them). */
const effective = (cfg) => withEnv(loadSettings(cfg), process.env)
function showSettings(cfg) {
  const saved = loadSettings(cfg)
  const s = withEnv(saved, process.env)
  const w = WORDS[s.lang] ?? WORDS.en
  const out = [`${w.title}  (${settingsFile(cfg)})`, '']
  for (const k of ['user', 'screenshot', 'file', 'text']) out.push(`  ${w.rows[k]}  [${k}=${s[k]}]`, `      ${w.mode[s[k]]}${k === 'text' ? '  ' + w.longer(s.textOver) : ''}`)
  out.push('', ...w.other(s).map(x => '  ' + x))
  const fromEnv = Object.entries(KEYS).filter(([, key]) => s[key] !== saved[key]).map(([name, key]) => `  BURN_AFTER_READING_${name.toUpperCase().replace(/-/g, '_')}: ${name}=${s[key]}`)
  if (fromEnv.length) out.push('', w.env, ...fromEnv)
  out.push('', w.recent)
  let log = []
  try { log = readFileSync(join(dataDir(cfg), 'hook.log'), 'utf8').trim().split('\n').filter(Boolean).slice(-5) } catch {}
  out.push(...(log.length ? log.map(l => '  ' + l) : ['  ' + w.none]), '', w.change)
  return out.join('\n')
}
function settingsCommand(args) {
  const cfg = configDir()
  if (args[0] === '--json') { process.stdout.write(JSON.stringify(effective(cfg), null, 2) + '\n'); return 0 }
  const write = (f, body) => atomicWrite(f, body, f)
  if (args[0] === 'reset') saveSettings(cfg, { ...DEFAULTS }, write)
  else if (args.length) {
    const patch = {}
    for (const a of args) {
      const m = /^([a-z-]+)=(.+)$/.exec(a)
      const key = m && KEYS[m[1]]
      if (!key) { process.stderr.write(`burn-after-reading: "${a}" is not a setting (settings are ${Object.keys(KEYS).join(', ')}; modes are ${MODES.join(', ')})\n`); return 1 }
      patch[key] = m[2]
    }
    try { saveSettings(cfg, patch, write) } catch (e) { process.stderr.write(`burn-after-reading: ${e.message}\n`); return 1 }
  }
  process.stdout.write(showSettings(cfg) + '\n')
  return 0
}

const mb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
/** A session's report, with its subagents' below it (only those where something happened). */
function describe(r, dryRun) {
  const out = [describeOne(r, dryRun)]
  for (const s of r.subagents ?? []) {
    if (s.error) out.push(`  subagent ${s.agent}: error: ${s.error}`)
    else if (s.refused || s.burned.length || s.skipped.length) out.push(describeOne(s, dryRun).replace(/^/gm, '  '))
  }
  return out.join('\n')
}
function describeOne(r, dryRun) {
  const name = r.agent ? `subagent ${r.agent}` : r.sessionId
  if (r.refused) return `${name}: not burned: ${r.refused}`
  const count = (k) => r.burned.filter(b => b.kind === k).length
  const parts = [['image', 'image', 'images'], ['pdf', 'PDF', 'PDFs'], ['text', 'long text result', 'long text results']]
    .map(([k, one, many]) => [count(k), one, many]).filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
  const lines = []
  if (!parts.length) lines.push(`${name}: nothing to burn`)
  else {
    const tokens = r.burned.reduce((s, b) => s + (b.tokens ?? 0), 0)
    lines.push(`${name}: ${dryRun ? 'would burn' : 'burned'} ${parts.join(', ')} (${mb(r.bytesBefore)} -> ${mb(r.bytesAfter)}${tokens ? `, about ${tokens.toLocaleString('en-US')} fewer input tokens on every later request` : ''})`)
  }
  const archived = r.burned.filter(b => b.archived).length
  if (archived) lines.push(`  ${archived} ${dryRun ? 'would be kept' : 'kept'} in the archive (Claude can read them again): ${r.archiveDir}`)
  const left = []
  if (r.unseen) left.push(`${r.unseen} Claude has not answered yet`)
  if (r.kept) left.push(`${r.kept} kept by your settings`)
  if (left.length) lines.push(`  left in place: ${left.join(', ')}`)
  for (const s of r.skipped) lines.push(`  line ${s.line + 1} left unchanged: ${s.reason}`)
  if (r.tempCopiesRemoved) lines.push(`  ${r.tempCopiesRemoved} of Claude Code's own saved copies removed`)
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
  if (argv[0] === 'settings') return settingsCommand(argv.slice(1))
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
      const r = burnSession(f, { ...o.run, dryRun: o.dryRun, force: o.force })
      reports.push(r)
      if (r.subagents.some(s => s.error)) status = Math.max(status, 1)
      if (r.refused || r.subagents.some(s => s.refused)) status = Math.max(status, 2)
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
