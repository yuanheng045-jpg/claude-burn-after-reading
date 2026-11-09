// Files: finding Claude Code transcripts, burning one safely, backups, live-session check, image numbering.
import { readFileSync, writeFileSync, renameSync, statSync, lstatSync, chmodSync, openSync, fsyncSync, closeSync, existsSync, mkdirSync, readdirSync, unlinkSync, appendFileSync, rmdirSync, realpathSync, utimesSync } from 'node:fs'
import { join, basename, dirname, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { burnLines, withoutMedia } from './burn.js'
import { configDir, configDirOf, dataDir, parentOf } from './paths.js'
import { loadSettings, withEnv, checkValue } from './settings.js'
export { configDir, configDirOf, dataDir, parentOf }
/** Claude Code names a project's transcript folder after its path, with every non-alphanumeric character turned into "-". */
export const projectDirName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')
/** The session a transcript belongs to (for a subagent's transcript, its session's). */
export const sessionIdOf = (file) => basename(parentOf(file) ?? file).replace(/\.jsonl$/, '')
/** "agent-<id>" for a subagent's transcript, null for a main one. */
export const agentOf = (file) => (parentOf(file) ? basename(file).replace(/\.jsonl$/, '') : null)
/** The transcripts of the subagents a session ran (Claude Code keeps them in <project>/<session>/subagents/). */
export function subagentFiles(file) {
  if (parentOf(file)) return []
  const dir = join(dirname(file), sessionIdOf(file), 'subagents')
  try { return readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort().map(n => join(dir, n)) } catch { return [] }
}

const BACKUP_DAYS = 30
const BACKUPS_PER_SESSION = 3
const TMP_TAG = '.burn-after-reading.'
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Write `body` to `target` atomically: temp file in the same folder, fsync, rename over. Permissions: those of the
 * file `modeFrom` (by default the target itself), or `modeFrom` itself if it is a number.
 * `guard`, if given, is asked right before the rename; if it says no, nothing is replaced and false is returned.
 */
export function atomicWrite(target, body, modeFrom = target, guard = null) {
  const tmp = join(dirname(target), `.${basename(target)}${TMP_TAG}${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
  const mode = typeof modeFrom === 'number' ? modeFrom : null
  try {
    writeFileSync(tmp, body, mode === null ? undefined : { mode })
    try { chmodSync(tmp, mode ?? (statSync(modeFrom).mode & 0o7777)) } catch { /* no original yet: default permissions */ }
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

/** Backups are named <key>.<YYYYMMDDTHHMMSS>.jsonl.bak, key = session id (plus ".agent-<id>" for a subagent). */
function pruneBackups(dir, key) {
  try {
    const cutoff = Date.now() - BACKUP_DAYS * 86400_000
    const mine = []
    for (const n of readdirSync(dir)) {
      const f = join(dir, n)
      if (statSync(f).mtimeMs < cutoff) { unlinkSync(f); continue }
      if (n.startsWith(key + '.') && /^\d{8}T\d{6}\.jsonl\.bak$/.test(n.slice(key.length + 1))) mine.push(n)
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

// ---- the archive: copies of burned things that Claude can read again ("archive" mode) ----
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' }
const archiveRoot = (cfg) => join(dataDir(cfg), 'archive')
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')
/**
 * A function burnLines can call to keep a copy; returns the copy's path, or null if it couldn't be saved.
 * The copy is written atomically before the transcript is, and an existing file is reused only if its content is
 * exactly this item (a run killed half-way must never leave a broken copy that a later run trusts).
 */
function archiver(cfg, sessionId, dryRun) {
  return (item) => {
    try {
      const dir = join(archiveRoot(cfg), sessionId.replace(/[^A-Za-z0-9._-]/g, '_'))
      const body = item.kind === 'text' ? Buffer.from(item.text, 'utf8') : Buffer.from(item.data, 'base64')
      const ext = item.kind === 'text' ? 'txt' : EXT[item.mediaType] ?? (item.kind === 'pdf' ? 'pdf' : 'img')
      const hash = sha1(body)
      const label = item.label ? '-' + String(item.label).replace(/[^0-9]/g, '') : ''
      const path = join(dir, `${item.kind}${label}-${hash.slice(0, 12)}.${ext}`)
      if (dryRun) return path
      let same = false
      try { same = sha1(readFileSync(path)) === hash } catch { /* not there yet */ }
      if (same) {
        const now = new Date()
        utimesSync(path, now, now)   // in use again: the archive's clock starts over
        return path
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      atomicWrite(path, body, 0o600)
      return path
    } catch { return null }
  }
}
function pruneArchive(cfg, days) {
  const cutoff = Date.now() - days * 86400_000
  try {
    for (const d of readdirSync(archiveRoot(cfg))) {
      const dir = join(archiveRoot(cfg), d)
      let left = 0
      for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).mtimeMs < cutoff) unlinkSync(f); else left++ }
      if (!left) rmdirSync(dir)
    }
  } catch { /* best effort */ }
}
/**
 * Claude Code's own file of an attached image (it tells Claude "[Image: source: <path>]"), for example
 * /tmp/claude-1000/<project>/<session>/images/1.png or %TEMP%\claude\<project>\<session>\images\1.png.
 * Deleted only if it really is one: an absolute path to a regular file (not a link) of ours, with an image extension,
 * whose real folder is "<session>/images" inside the real temp folder.
 */
export function removeTempCopy(path, sessionId) {
  if (typeof path !== 'string' || !isAbsolute(path) || !/^[A-Za-z0-9-]{8,}$/.test(String(sessionId))) return false
  if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return false
  try {
    const st = lstatSync(path)
    if (!st.isFile()) return false
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
    const dir = realpathSync.native(dirname(path))
    if (basename(dir) !== 'images' || basename(dirname(dir)) !== sessionId) return false
    const roots = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].flatMap(t => { try { return [realpathSync.native(t)] } catch { return [] } })
    if (!roots.some(t => dir.startsWith(t.endsWith(sep) ? t : t + sep))) return false
    unlinkSync(join(dir, basename(path)))
    return true
  } catch { return false }
}

const KINDS = ['user', 'screenshot', 'file', 'text']
const wholeAtLeast = (v, name, min) => {
  if (v === undefined || v === null) return undefined
  if (!Number.isInteger(v) || v < min) throw new Error(`${name} must be a whole number of at least ${min}`)
  return v
}
/**
 * The options a burn of a transcript in `cfg` runs with: saved settings, then environment, then what the caller passes.
 * What the caller passes is checked: a typo throws instead of quietly doing something else.
 */
export function resolveOptions(cfg, opts = {}, env = process.env) {
  const s = withEnv(loadSettings(cfg), env)
  const modes = { user: s.user, screenshot: s.screenshot, file: s.file, text: s.text }
  for (const [k, v] of Object.entries(opts.modes ?? {})) {
    if (!KINDS.includes(k)) throw new Error(`unknown kind "${k}" in modes (the kinds are ${KINDS.join(', ')})`)
    try { modes[k] = checkValue(k, v) } catch (e) { throw new Error(`modes.${k}: ${e.message}`) }
  }
  // asking for a length for this run turns long text on, unless the settings already archive or burn it
  if (opts.textOver != null && opts.modes?.text === undefined && modes.text === 'keep') modes.text = 'burn'
  return {
    modes,
    textOver: wholeAtLeast(opts.textOver, 'textOver', 1) ?? s.textOver,
    keep: wholeAtLeast(opts.keep, 'keep', 0) ?? s.keepLatest,
    lang: opts.lang == null ? s.lang : checkValue('lang', opts.lang),
    backup: opts.backup == null ? s.backup : checkValue('backup', opts.backup),
    archiveDays: wholeAtLeast(opts.archiveDays, 'archiveDays', 1) ?? s.archiveDays,
    labels: s.labels,
  }
}

/**
 * Burn one transcript file (a session's, or one of its subagents'), with the saved settings unless `opts` says otherwise.
 * @param {string} file
 * @param {{ dryRun?: boolean, force?: boolean, hookMode?: boolean, modes?: object, keep?: number, textOver?: number, lang?: string, backup?: boolean, archiveDays?: number, env?: object }} [opts]
 */
export function burnFile(file, opts = {}) {
  const cfg = configDirOf(file)
  const sessionId = sessionIdOf(file)
  const agent = agentOf(file)
  const o = resolveOptions(cfg, opts, opts.env ?? process.env)
  const report = { file, sessionId, agent, burned: [], skipped: [], kept: 0, unseen: 0, elsewhere: {}, bytesBefore: 0, bytesAfter: 0, written: false, backupFile: null, archiveDir: null, tempCopiesRemoved: 0, refused: null }
  if (!opts.force) {
    const why = liveReason(cfg, sessionId, !!opts.hookMode)
    if (why) { report.refused = why; return report }
  }
  if (!opts.dryRun) {
    removeStaleTemps(dirname(file))
    pruneArchive(cfg, o.archiveDays)
  }
  const before = statSync(file)
  const bytes = readFileSync(file)
  const parts = splitBytes(bytes)
  const lines = parts.map(b => b.toString('utf8'))
  const frozen = new Set()
  lines.forEach((l, i) => { if (Buffer.byteLength(l) !== parts[i].length || !Buffer.from(l).equals(parts[i])) frozen.add(i) })
  // in a subagent's transcript every row is a "sidechain" one, so its answers count there
  const r = burnLines(lines, { modes: o.modes, textOver: o.textOver, keep: o.keep, lang: o.lang, frozen, sidechain: !!agent, labelsByFingerprint: readLabels(cfg, sessionId), archive: archiver(cfg, sessionId, !!opts.dryRun) })
  const changed = r.lines.map((l, i) => l !== lines[i])
  const outParts = parts.map((b, i) => (changed[i] ? Buffer.from(r.lines[i]) : b))
  const size = outParts.reduce((s, b) => s + b.length, 0) + outParts.length - 1
  Object.assign(report, { burned: r.burned, skipped: r.skipped, kept: r.kept, unseen: r.unseen, elsewhere: r.elsewhere, bytesBefore: bytes.length, bytesAfter: size })
  if (r.burned.some(b => b.archived)) report.archiveDir = dirname(r.burned.find(b => b.archived).archived)
  if (!changed.some(Boolean) || opts.dryRun) return report
  const body = Buffer.concat(outParts.flatMap((b, i) => (i ? [Buffer.from('\n'), b] : [b])))
  if (o.backup !== false) {
    const dir = join(dataDir(cfg), 'backups')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
    const key = agent ? `${sessionId}.${agent}` : sessionId
    report.backupFile = join(dir, `${key}.${stamp}.jsonl.bak`)
    const bakLines = withoutMedia(lines)
    atomicWrite(report.backupFile, Buffer.concat(parts.flatMap((b, i) => { const x = bakLines[i] === lines[i] ? b : Buffer.from(bakLines[i]); return i ? [Buffer.from('\n'), x] : [x] })), file)
    pruneBackups(dir, key)
  }
  // nothing may have been appended while we worked: checked again right before the file is replaced
  const unchanged = () => { const now = statSync(file); return now.size === before.size && now.mtimeMs === before.mtimeMs }
  if (!atomicWrite(file, body, file, unchanged)) {
    report.refused = 'the transcript changed while it was being burned (is Claude Code still writing to it?); nothing was changed'
    return report
  }
  report.written = true
  // Claude Code's own saved files of the burned attached images go too (in archive mode the archive holds the copy)
  for (const p of r.tempCopies) if (removeTempCopy(p, sessionId)) report.tempCopiesRemoved++
  return report
}

/**
 * Burn a session: its transcript, then the transcripts of the subagents it ran (they hold what those subagents
 * looked at). Returns the session's report with the subagents' reports in `subagents`.
 * @param {string} file the session's transcript (a subagent's transcript is burned on its own)
 * @param {Parameters<typeof burnFile>[1]} [opts]
 */
export function burnSession(file, opts = {}) {
  const report = burnFile(file, opts)
  report.subagents = []
  if (report.refused) return report
  for (const f of subagentFiles(file)) {
    try { report.subagents.push(burnFile(f, opts)) } catch (e) {
      report.subagents.push({ file: f, sessionId: report.sessionId, agent: agentOf(f), burned: [], skipped: [], refused: null, error: String(e?.message ?? e) })
    }
  }
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
