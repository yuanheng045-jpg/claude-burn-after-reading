// Files: finding Claude Code transcripts, burning one safely, backups, live-session check, image numbering.
import { readFileSync, writeFileSync, renameSync, statSync, chmodSync, openSync, fsyncSync, closeSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { burnLines, withoutMedia } from './burn.js'

/** Claude Code's config directory (CLAUDE_CONFIG_DIR, else ~/.claude). */
export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
/** The config directory a transcript belongs to (<config>/projects/<project>/<id>.jsonl), else the default one. */
export function configDirOf(file) {
  const projects = dirname(dirname(file))
  return basename(projects) === 'projects' ? dirname(projects) : configDir()
}
/** Where this tool keeps its own files: backups, image numbers, the hook log. */
export const dataDir = (cfg = configDir()) => join(cfg, 'burn-after-reading')
/** Claude Code names a project's transcript folder after its path, with every non-alphanumeric character turned into "-". */
export const projectDirName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
export const sessionIdOf = (file) => basename(file).replace(/\.jsonl$/, '')

const BACKUP_DAYS = 30
const BACKUPS_PER_SESSION = 3
const TMP_TAG = '.burn-after-reading.'
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Write `body` to `target` atomically: temp file in the same folder, fsync, keep `modeFrom`'s permissions, rename over.
 * `guard`, if given, is asked right before the rename; if it says no, nothing is replaced and false is returned.
 */
export function atomicWrite(target, body, modeFrom = target, guard = null) {
  const tmp = join(dirname(target), `.${basename(target)}${TMP_TAG}${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, body)
    try { chmodSync(tmp, statSync(modeFrom).mode & 0o7777) } catch { /* no original yet: default permissions */ }
    const fd = openSync(tmp, 'r+')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    if (guard && !guard()) { unlinkSync(tmp); return false }
    // Windows: antivirus or the search indexer can hold the file for a moment
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, target); break } catch (e) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code) || attempt >= 9) throw e
        sleep(50 * (attempt + 1))
      }
    }
    return true
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw e
  }
}
/** Temp files left by a burn that was killed half-way (for example a hook that hit its timeout). */
function removeStaleTemps(dir) {
  try {
    const cutoff = Date.now() - 3600_000
    for (const n of readdirSync(dir)) if (n.includes(TMP_TAG) && n.endsWith('.tmp') && statSync(join(dir, n)).mtimeMs < cutoff) unlinkSync(join(dir, n))
  } catch { /* best effort */ }
}

/** Running Claude Code sessions: session id -> pids (Claude Code keeps one <pid>.json per running session in <config>/sessions). */
export function liveSessions(cfg = configDir()) {
  const live = new Map()
  const dir = join(cfg, 'sessions')
  let names = []
  try { names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n)) } catch { return live }
  for (const n of names) {
    try {
      const j = JSON.parse(readFileSync(join(dir, n), 'utf8'))
      if (!j?.sessionId || !Number.isInteger(j.pid)) continue
      let alive = true
      try { process.kill(j.pid, 0) } catch (e) { alive = e?.code === 'EPERM' }
      if (alive) live.set(j.sessionId, [...(live.get(j.sessionId) ?? []), j.pid])
    } catch { /* half-written or not ours */ }
  }
  return live
}
export const liveSessionIds = (cfg) => new Set(liveSessions(cfg).keys())

/** This process and the processes above it (a hook runs under the Claude Code process that is ending). */
function ancestors() {
  const pids = new Set([process.pid, process.ppid])
  let p = process.ppid
  for (let depth = 0; depth < 6 && p > 1; depth++) {
    let parent = 0
    try {
      if (existsSync(`/proc/${p}/stat`)) parent = Number(readFileSync(`/proc/${p}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1])
      else parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8', timeout: 2000 }).trim())
    } catch { break }
    if (!(parent > 0)) break
    pids.add(parent)
    p = parent
  }
  return pids
}
/** Why this session must not be burned now, or null. */
function liveReason(cfg, sessionId, hookMode) {
  const pids = liveSessions(cfg).get(sessionId) ?? []
  if (!pids.length) return null
  if (!hookMode) return 'this session is open in Claude Code right now; it keeps the conversation in memory and would not see the change (close it first, or use --force)'
  // the session that is ending is still listed; any other process with it open means someone may still be writing
  const others = process.platform === 'win32' ? (pids.length > 1 ? pids : []) : pids.filter(p => !ancestors().has(p))
  return others.length ? 'this session is also open in another Claude Code window; burned when that one closes' : null
}

/** All transcripts of the project at `cwd`, newest first. */
export function projectSessions(cwd) {
  const dir = join(configDir(), 'projects', projectDirName(cwd))
  let names = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.jsonl')) } catch { return [] }
  return names.map(n => join(dir, n)).map(f => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).map(x => x.f)
}
/** The transcript file for a session id, searched across all projects; null if there is none. */
export function findSession(id) {
  const root = join(configDir(), 'projects')
  let dirs = []
  try { dirs = readdirSync(root) } catch { return null }
  for (const d of dirs) { const f = join(root, d, id + '.jsonl'); if (existsSync(f)) return f }
  return null
}

function pruneBackups(dir, sessionId) {
  try {
    const cutoff = Date.now() - BACKUP_DAYS * 86400_000
    const mine = []
    for (const n of readdirSync(dir)) {
      const f = join(dir, n)
      if (statSync(f).mtimeMs < cutoff) { unlinkSync(f); continue }
      if (n.startsWith(sessionId + '.') && n.endsWith('.jsonl.bak')) mine.push(n)
    }
    for (const n of mine.sort().slice(0, -BACKUPS_PER_SESSION)) unlinkSync(join(dir, n))
  } catch { /* best effort */ }
}

/** Split a file's bytes into lines (on \n) without decoding, so lines that are not edited are written back byte for byte. */
function splitBytes(buf) {
  const parts = []
  let start = 0
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, start)) { parts.push(buf.subarray(start, i)); start = i + 1 }
  parts.push(buf.subarray(start))
  return parts
}

/**
 * Burn one transcript file.
 * @param {string} file
 * @param {import('./burn.js').BurnOptions & { dryRun?: boolean, backup?: boolean, force?: boolean, hookMode?: boolean }} [opts]
 */
export function burnFile(file, opts = {}) {
  const cfg = configDirOf(file)
  const sessionId = sessionIdOf(file)
  const report = { file, sessionId, burned: [], skipped: [], kept: 0, unseen: 0, elsewhere: {}, bytesBefore: 0, bytesAfter: 0, written: false, backupFile: null, refused: null }
  if (!opts.force) {
    const why = liveReason(cfg, sessionId, !!opts.hookMode)
    if (why) { report.refused = why; return report }
  }
  removeStaleTemps(dirname(file))
  const before = statSync(file)
  const bytes = readFileSync(file)
  const parts = splitBytes(bytes)
  const lines = parts.map(b => b.toString('utf8'))
  const frozen = new Set()
  lines.forEach((l, i) => { if (Buffer.byteLength(l) !== parts[i].length || !Buffer.from(l).equals(parts[i])) frozen.add(i) })
  const r = burnLines(lines, { ...opts, frozen, labelsByFingerprint: readLabels(cfg, sessionId) })
  const changed = r.lines.map((l, i) => l !== lines[i])
  const outParts = parts.map((b, i) => (changed[i] ? Buffer.from(r.lines[i]) : b))
  const size = outParts.reduce((s, b) => s + b.length, 0) + outParts.length - 1
  Object.assign(report, { burned: r.burned, skipped: r.skipped, kept: r.kept, unseen: r.unseen, elsewhere: r.elsewhere, bytesBefore: bytes.length, bytesAfter: size })
  if (!changed.some(Boolean) || opts.dryRun) return report
  const body = Buffer.concat(outParts.flatMap((b, i) => (i ? [Buffer.from('\n'), b] : [b])))
  if (opts.backup !== false) {
    const dir = join(dataDir(cfg), 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
    report.backupFile = join(dir, `${sessionId}.${stamp}.jsonl.bak`)
    const bakLines = withoutMedia(lines)
    atomicWrite(report.backupFile, Buffer.concat(parts.flatMap((b, i) => { const x = bakLines[i] === lines[i] ? b : Buffer.from(bakLines[i]); return i ? [Buffer.from('\n'), x] : [x] })), file)
    pruneBackups(dir, sessionId)
  }
  // nothing may have been appended while we worked: checked again right before the file is replaced
  const unchanged = () => { const now = statSync(file); return now.size === before.size && now.mtimeMs === before.mtimeMs }
  if (!atomicWrite(file, body, file, unchanged)) {
    report.refused = 'the transcript changed while it was being burned (is Claude Code still writing to it?); nothing was changed'
    return report
  }
  report.written = true
  return report
}

const labelFile = (cfg, sessionId) => join(dataDir(cfg), 'labels', String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.log')
/**
 * Hand out new image numbers for a session, one per fingerprint. Several hooks can run at once (parallel tool
 * calls), so each number is one appended line (small O_APPEND writes are atomic) and a number is its line's position.
 */
export function nextLabels(sessionId, fingerprints, cfg = configDir()) {
  const file = labelFile(cfg, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const tokens = fingerprints.map(fp => `${Date.now()} ${process.pid} ${randomBytes(6).toString('hex')} ${fp || '-'}`)
  for (const t of tokens) appendFileSync(file, t + '\n')
  const all = readFileSync(file, 'utf8').split('\n')
  return tokens.map(t => String(all.lastIndexOf(t) + 1))
}
/** fingerprint -> number for a session (the latest number if the same image was seen more than once). */
export function readLabels(cfg, sessionId) {
  const map = new Map()
  let text = ''
  try { text = readFileSync(labelFile(cfg, sessionId), 'utf8') } catch { return map }
  text.split('\n').forEach((l, i) => { const fp = l.split(' ')[3]; if (fp && fp !== '-') map.set(fp, String(i + 1)) })
  return map
}

/** Append one line to the hook log, keeping it short. */
export function logLine(text, cfg = configDir()) {
  try {
    const dir = dataDir(cfg)
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'hook.log')
    appendFileSync(f, `${new Date().toISOString()} ${text}\n`)
    if (statSync(f).size > 256 * 1024) atomicWrite(f, readFileSync(f, 'utf8').split('\n').slice(-500).join('\n'))
  } catch { /* logging must never break a hook */ }
}
