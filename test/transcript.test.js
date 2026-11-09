import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, existsSync, utimesSync, readdirSync, mkdtempSync, symlinkSync, realpathSync, rmSync, rmdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { loadSettings, saveSettings, DEFAULTS } from '../src/settings.js'
import { spawn } from 'node:child_process'
import { burnFile, burnSession, projectSessions, findSession, liveSessionIds, projectDirName, nextLabels, removeTempCopy, resolveOptions, sessionIdOf, configDirOf, subagentFiles } from '../src/transcript.js'
import * as h from './helpers.js'

const saved = process.env.CLAUDE_CONFIG_DIR
beforeEach(() => h.reset())
afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved })
const session = () => [h.userText('look'), h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.say('ok')]

test('burns the file in place, keeps its permissions, writes a backup without the image', () => {
  const { root, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = root
  chmodSync(file, 0o600)
  const r = burnFile(file)
  assert.equal(r.written, true)
  assert.equal(r.burned.length, 1)
  assert.ok(r.bytesAfter < r.bytesBefore)
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes('iVBORw0KGgo'))
  assert.equal(text.split('\n').length, 5)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  const bak = readFileSync(r.backupFile, 'utf8')
  assert.ok(!bak.includes('iVBORw0KGgo'))
  assert.equal(bak.split('\n').length, 5)
  assert.ok(r.backupFile.startsWith(join(root, 'burn-after-reading', 'backups')))
})

test('dry run changes nothing; nothing to burn writes nothing', () => {
  const { root, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = root
  const before = readFileSync(file, 'utf8')
  const r = burnFile(file, { dryRun: true })
  assert.equal(r.burned.length, 1)
  assert.equal(r.written, false)
  assert.equal(readFileSync(file, 'utf8'), before)
  burnFile(file)
  const again = burnFile(file)
  assert.equal(again.written, false)
  assert.equal(again.burned.length, 0)
})

test('refuses a session that is open in Claude Code, unless allowed', () => {
  const { root, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = root
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: h.SID }))
  assert.ok(liveSessionIds().has(h.SID))
  const r = burnFile(file)
  assert.match(r.refused, /open in Claude Code/)
  assert.ok(readFileSync(file, 'utf8').includes('iVBORw0KGgo'))
  assert.equal(burnFile(file, { force: true }).written, true)
  // a stale entry (process gone) does not count as open
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: 2147483646, sessionId: h.SID }))
  assert.ok(!liveSessionIds().has(h.SID))
})

test('finds sessions by id and by project folder', () => {
  const { root, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = root
  assert.equal(findSession(h.SID), file)
  assert.equal(findSession('nope'), null)
  assert.equal(projectDirName('/tmp/proj'), '-tmp-proj')
  assert.equal(projectDirName('C:\\Users\\me\\my proj'), 'C--Users-me-my-proj')
  assert.deepEqual(projectSessions('/tmp/proj'), [file])
  assert.deepEqual(projectSessions('/elsewhere'), [])
})

test('image numbers stay unique when many hooks ask at once', async () => {
  const { root } = h.tempConfig([])
  const mod = new URL('../src/transcript.js', import.meta.url).href
  const code = `import(${JSON.stringify(mod)}).then(m => console.log(m.nextLabels('s1', ['a', 'b', 'c', 'd', 'e']).join(' ')))`
  const runs = Array.from({ length: 12 }, () => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', code], { env: { ...process.env, CLAUDE_CONFIG_DIR: root } })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('exit', c => (c === 0 ? res(out.trim().split(' ')) : rej(new Error('exit ' + c))))
  }))
  const all = (await Promise.all(runs)).flat().map(Number).sort((a, b) => a - b)
  assert.deepEqual(all, Array.from({ length: 60 }, (_, i) => i + 1))
  process.env.CLAUDE_CONFIG_DIR = root
  assert.deepEqual(nextLabels('s1', ['x', 'y']), ['61', '62'])
  assert.ok(existsSync(join(root, 'burn-after-reading', 'labels', 's1.log')))
})

// ---- the archive and Claude Code's own copies ----
test("default settings: an attached image is archived, Claude Code's own copy is removed, the archive is pruned", () => {
  const sid = h.SID
  const tmpRoot = h.tempDir('claude-')
  const own = join(tmpRoot, 'proj', sid, 'images', '1.png')
  mkdirSync(dirname(own), { recursive: true })
  writeFileSync(own, 'x')
  const outside = join(tmpRoot, 'proj', 'elsewhere.png')   // not shaped like Claude Code's copy: never touched
  writeFileSync(outside, 'x')
  const img = h.pngBase64(20, 20)
  const meta = JSON.stringify({ type: 'user', isMeta: true, uuid: 'm', sessionId: sid, message: { role: 'user', content: [{ type: 'text', text: `[Image: source: ${own}]\n[Image: source: ${outside}]` }] } })
  const { root, file } = h.tempConfig([h.userBlocks([{ type: 'text', text: 'look' }, h.image(img), h.image(h.pngBase64(21, 21))]), meta, h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  const oldDir = join(root, 'burn-after-reading', 'archive', 'old-session')
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, 'image-x.png'), 'x')
  const old = new Date(Date.now() - 40 * 86400_000)
  utimesSync(join(oldDir, 'image-x.png'), old, old)
  const r = burnFile(file)
  assert.equal(r.written, true)
  assert.equal(r.burned.length, 2)
  const copy = r.burned[0].archived
  assert.ok(copy.startsWith(join(root, 'burn-after-reading', 'archive', sid)))
  assert.deepEqual(readFileSync(copy), Buffer.from(img, 'base64'))
  assert.ok(readFileSync(file, 'utf8').includes(`a copy is kept at ${JSON.stringify(copy).slice(1, -1)}`))
  assert.ok(!existsSync(own))
  assert.ok(existsSync(outside))
  assert.equal(r.tempCopiesRemoved, 1)
  assert.ok(!existsSync(oldDir))                                  // older than 30 days: gone
})

test('a dry run says where the archive copy would go but writes nothing', () => {
  const { root, file } = h.tempConfig([h.userBlocks([h.image()]), h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  const r = burnFile(file, { dryRun: true })
  assert.ok(r.burned[0].archived)
  assert.ok(!existsSync(r.burned[0].archived))
})

test('settings: saved, checked, and used', () => {
  const { root, file } = h.tempConfig([h.userBlocks([h.image()]), h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  const write = (f, s) => writeFileSync(f, s)
  assert.equal(saveSettings(root, { user: 'burn', textOver: '30000', labels: 'off' }, write).user, 'burn')
  assert.deepEqual(loadSettings(root), { ...DEFAULTS, user: 'burn', textOver: 30000, labels: false })
  assert.throws(() => saveSettings(root, { user: 'sometimes' }, write), /keep, archive, burn/)
  assert.throws(() => saveSettings(root, { archiveDays: 0 }, write), /at least 1/)
  const r = burnFile(file)
  assert.equal(r.burned[0].archived, null)   // user=burn now: destroyed, not archived
})

// ---- review findings (2026-11-09) ----
test('the session-end hook burns its own session but not one also open in another window', () => {
  const { root, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = root
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: h.SID }))
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'])
  try {
    writeFileSync(join(root, 'sessions', `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: h.SID }))
    const r = burnFile(file, { hookMode: true })
    assert.ok(r.refused)
    if (process.platform !== 'win32') assert.match(r.refused, /another Claude Code window/)
    writeFileSync(join(root, 'sessions', `${other.pid}.json`), '{}')
    assert.equal(burnFile(file, { hookMode: true }).written, true)   // only its own process left
  } finally { other.kill() }
})

test('bytes it does not edit stay byte for byte, even invalid UTF-8', () => {
  const { root, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = root
  const broken = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe4, 0xb8])   // {"a":"<half a character>  (a crash-truncated line)
  writeFileSync(file, Buffer.concat([readFileSync(file), broken]))
  assert.equal(burnFile(file).written, true)
  const after = readFileSync(file)
  assert.ok(after.subarray(after.length - broken.length).equals(broken))
  assert.ok(!after.includes('iVBORw0KGgo'))
})

test('keeps at most three backups per session; cleans up temp files left by a killed run', () => {
  const lines = session()
  const { root, file, dir } = h.tempConfig(lines)
  process.env.CLAUDE_CONFIG_DIR = root
  const stale = join(dir, `.${h.SID}.jsonl.burn-after-reading.1.abc.tmp`)
  writeFileSync(stale, 'x')
  const old = new Date(Date.now() - 2 * 3600_000)
  utimesSync(stale, old, old)
  const backups = join(root, 'burn-after-reading', 'backups')
  mkdirSync(backups, { recursive: true })
  for (const d of ['20260101T000000', '20260102T000000', '20260103T000000', '20260104T000000']) writeFileSync(join(backups, `${h.SID}.${d}.jsonl.bak`), 'old')
  assert.equal(burnFile(file).written, true)
  const left = readdirSync(backups).filter(n => n.startsWith(h.SID)).sort()
  assert.equal(left.length, 3)
  assert.ok(!left.includes(`${h.SID}.20260101T000000.jsonl.bak`))
  assert.ok(!existsSync(stale))
})

// ---- second review (2026-11-09) ----
test('a broken archive copy (a run killed half-way) is never trusted: it is written again', () => {
  const img = h.pngBase64(30, 30)
  const { root, file } = h.tempConfig([h.userBlocks([h.image(img)]), h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  const where = burnFile(file, { dryRun: true }).burned[0].archived
  mkdirSync(dirname(where), { recursive: true })
  writeFileSync(where, 'only half')                    // left by a run killed while writing
  const r = burnFile(file)
  assert.equal(r.burned[0].archived, where)
  assert.deepEqual(readFileSync(where), Buffer.from(img, 'base64'))
  if (process.platform !== 'win32') assert.equal(statSync(where).mode & 0o777, 0o600)
})

test('an archive copy used again starts its 30 days over; a dry run deletes nothing', () => {
  const img = h.pngBase64(31, 31)
  const { root, file } = h.tempConfig([h.userBlocks([h.image(img)]), h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  const where = burnFile(file, { dryRun: true }).burned[0].archived
  mkdirSync(dirname(where), { recursive: true })
  writeFileSync(where, Buffer.from(img, 'base64'))
  const days = (n) => new Date(Date.now() - n * 86400_000)
  utimesSync(where, days(20), days(20))
  const oldDir = join(root, 'burn-after-reading', 'archive', 'old-session')
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, 'image-x.png'), 'x')
  utimesSync(join(oldDir, 'image-x.png'), days(40), days(40))
  burnFile(file, { dryRun: true })
  assert.ok(existsSync(join(oldDir, 'image-x.png')), 'a dry run prunes nothing')
  burnFile(file)
  assert.ok(Date.now() - statSync(where).mtimeMs < 60_000, 'reused, and its clock restarted')
  assert.ok(!existsSync(oldDir))
})

test('options passed in code are checked: a typo throws instead of doing something else', () => {
  const { root, file } = h.tempConfig([h.userBlocks([h.image()]), h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  assert.throws(() => burnFile(file, { modes: { user: 'archived' } }), /modes\.user: use one of keep, archive, burn/)
  assert.throws(() => burnFile(file, { modes: { screenshots: 'keep' } }), /unknown kind "screenshots"/)
  assert.throws(() => burnFile(file, { archiveDays: 0 }), /archiveDays must be a whole number of at least 1/)
  assert.throws(() => burnFile(file, { keep: -1 }), /keep must be/)
  assert.throws(() => burnFile(file, { lang: 'fr' }), /en or zh/)
  assert.ok(readFileSync(file, 'utf8').includes('iVBORw0KGgo'))
  // asking for a length turns long text on, but doesn't turn archive into burn
  assert.equal(resolveOptions(root, { textOver: 5000 }, {}).modes.text, 'burn')
  assert.equal(resolveOptions(root, { textOver: 5000 }, { BURN_AFTER_READING_TEXT: 'archive' }).modes.text, 'archive')
  assert.equal(resolveOptions(root, { textOver: 5000, modes: { text: 'keep' } }, {}).modes.text, 'keep')
})

test("Claude Code's own copy is deleted only if it really is one", () => {
  const sid = '0a0a0a0a-1111-4222-8333-555555555555'
  const tmpRoot = h.tempDir('claude-')
  const images = join(tmpRoot, 'proj', sid, 'images')
  mkdirSync(images, { recursive: true })
  const own = join(images, '1.png')
  writeFileSync(own, 'x')
  assert.equal(removeTempCopy(join('proj', sid, 'images', '1.png'), sid), false)       // relative: no
  assert.equal(removeTempCopy(join(images, '1.txt'), sid), false)                      // not an image: no
  assert.equal(removeTempCopy(own, 'not-this-session'), false)                         // another session: no
  const outside = mkdtempSync(join(notTemp(), 'outside-'))
  const away = join(outside, sid, 'images', '1.png')
  mkdirSync(dirname(away), { recursive: true })
  writeFileSync(away, 'x')
  // (skipped where the repo itself sits inside the temp folder)
  const repoInTemp = realpathSync(outside).startsWith(realpathSync(tmpdir()))
  if (!repoInTemp) assert.equal(removeTempCopy(away, sid), false)                      // outside the temp folder: no
  if (process.platform !== 'win32' && !repoInTemp) {
    // a linked folder on the way that leads out of the temp folder: no; a link instead of a file: no
    symlinkSync(outside, join(tmpRoot, 'linked'))
    assert.equal(removeTempCopy(join(tmpRoot, 'linked', sid, 'images', '1.png'), sid), false)
    symlinkSync(away, join(images, '3.png'))
    assert.equal(removeTempCopy(join(images, '3.png'), sid), false)
    assert.ok(existsSync(away))
  }
  assert.equal(removeTempCopy(own, sid), true)
  assert.ok(!existsSync(own))
  rmSync(outside, { recursive: true, force: true })
  try { rmdirSync(notTemp()) } catch { /* something else is in it */ }
})
/** A folder outside the temp folder: test/.scratch in the repo. */
function notTemp() {
  const d = fileURLToPath(new URL('./.scratch/', import.meta.url))
  mkdirSync(d, { recursive: true })
  return d
}

test("a session's subagents are burned with it; their backups are kept apart", () => {
  const { root: cfg, dir, file } = h.tempConfig(session())
  process.env.CLAUDE_CONFIG_DIR = cfg
  const side = (l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true, agentId: 'abc' })
  const subDir = join(dir, h.SID, 'subagents')
  mkdirSync(subDir, { recursive: true })
  const sub = join(subDir, 'agent-abc.jsonl')
  writeFileSync(sub, [h.userText('look'), h.toolUse('s1', 'Read', { file_path: '/b.png' }), h.readImageResult('s1', h.pngBase64(40, 40)), h.say('a dog')].map(side).join('\n') + '\n')
  assert.equal(sessionIdOf(sub), h.SID)
  assert.equal(configDirOf(sub), cfg)
  assert.deepEqual(subagentFiles(file), [sub])
  assert.deepEqual(subagentFiles(sub), [])
  const backups = join(cfg, 'burn-after-reading', 'backups')
  mkdirSync(backups, { recursive: true })
  for (const d of ['20260101T000000', '20260102T000000', '20260103T000000']) writeFileSync(join(backups, `${h.SID}.${d}.jsonl.bak`), 'old')
  const r = burnSession(file)
  assert.equal(r.burned.length, 1)
  assert.equal(r.subagents.length, 1)
  assert.equal(r.subagents[0].agent, 'agent-abc')
  assert.equal(r.subagents[0].burned.length, 1)
  assert.ok(!readFileSync(sub, 'utf8').includes('iVBORw0KGgo'))
  assert.match(r.subagents[0].backupFile, /agent-abc\.\d{8}T\d{6}\.jsonl\.bak$/)
  const names = readdirSync(backups)
  assert.equal(names.filter(n => /^[^.]+\.\d{8}T\d{6}\.jsonl\.bak$/.test(n)).length, 3)   // the session's own: three
  assert.equal(names.filter(n => n.includes('.agent-abc.')).length, 1)                    // the subagent's: kept apart
  // a subagent of a session that is open counts as open
  mkdirSync(join(cfg, 'sessions'), { recursive: true })
  writeFileSync(join(cfg, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: h.SID }))
  assert.match(burnFile(sub).refused, /open in Claude Code/)
})
