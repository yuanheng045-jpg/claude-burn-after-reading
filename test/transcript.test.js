import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { burnFile, projectSessions, findSession, liveSessionIds, projectDirName, nextLabels } from '../src/transcript.js'
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
