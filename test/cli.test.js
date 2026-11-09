import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from './helpers.js'

const BIN = fileURLToPath(new URL('../bin/burn-after-reading.js', import.meta.url))
const run = (args, env = {}, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } })
beforeEach(() => h.reset())
const session = () => [h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.say('ok')]

test('help, version, bad options', () => {
  assert.match(run(['--help']).stdout, /Usage:/)
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/)
  const bad = run(['--nope'])
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown option/)
  assert.equal(run(['--keep', 'x', 'f.jsonl']).status, 1)
})

test('dry run, then the real thing, by path and by session id', () => {
  const { root, file } = h.tempConfig(session())
  const env = { CLAUDE_CONFIG_DIR: root }
  const dry = run(['--dry-run', file], env)
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /would burn 1 image/)
  assert.ok(readFileSync(file, 'utf8').includes('iVBORw0KGgo'))
  const real = run([h.SID, '--json'], env)
  assert.equal(real.status, 0)
  const report = JSON.parse(real.stdout)
  assert.equal(report.written, true)
  assert.equal(report.burned[0].path, '/a.png')
  assert.ok(!readFileSync(file, 'utf8').includes('iVBORw0KGgo'))
  assert.match(run([file], env).stdout, /nothing to burn/)
})

test('an open session is refused with exit status 2', () => {
  const { root, file } = h.tempConfig(session())
  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: h.SID }))
  const r = run([file], { CLAUDE_CONFIG_DIR: root })
  assert.equal(r.status, 2)
  assert.match(r.stdout, /open in Claude Code/)
  assert.equal(run([file, '--force', '-q'], { CLAUDE_CONFIG_DIR: root }).status, 0)
})

test('settings: shown in plain words, changed with key=value, bad input refused, reset', () => {
  const { root } = h.tempConfig([])
  const env = { CLAUDE_CONFIG_DIR: root }
  const show = run(['settings'], env)
  assert.equal(show.status, 0)
  assert.match(show.stdout, /Images attached to a message {2}\[user=archive\]/)
  assert.match(show.stdout, /nothing yet/)
  const set = run(['settings', 'user=burn', 'text=archive', 'lang=zh'], env)
  assert.equal(set.status, 0)
  assert.match(set.stdout, /跟着消息一起发来的图 {2}\[user=burn\]/)
  assert.equal(JSON.parse(run(['settings', '--json'], env).stdout).text, 'archive')
  const bad = run(['settings', 'user=maybe'], env)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /keep, archive, burn/)
  assert.equal(run(['settings', 'colour=red'], env).status, 1)
  run(['settings', 'reset'], env)
  assert.equal(JSON.parse(run(['settings', '--json'], env).stdout).user, 'archive')
})

test('hook mode reads the event on stdin and never fails the session', () => {
  const { root, file } = h.tempConfig(session())
  const ok = run(['hook'], { CLAUDE_CONFIG_DIR: root }, JSON.stringify({ hook_event_name: 'SessionEnd', session_id: h.SID, transcript_path: file }))
  assert.equal(ok.status, 0)
  assert.ok(!readFileSync(file, 'utf8').includes('iVBORw0KGgo'))
  const garbage = run(['hook'], { CLAUDE_CONFIG_DIR: root }, 'not json')
  assert.equal(garbage.status, 0)
  assert.match(garbage.stderr, /burn-after-reading hook/)
})

// ---- second review (2026-11-09) ----
test('--text-over turns long text on, but leaves text=archive archiving', () => {
  const { root, file } = h.tempConfig([h.toolUse('b', 'Bash'), h.toolResult('b', 'z'.repeat(30000)), h.say('ok')])
  const env = { CLAUDE_CONFIG_DIR: root }
  assert.equal(run(['--text-over', '0', file], env).status, 1)
  const once = JSON.parse(run(['--dry-run', '--json', '--text-over', '5000', file], env).stdout)
  assert.equal(once.burned[0].kind, 'text')
  assert.equal(once.burned[0].archived, null)          // text=keep in the settings: this run burns
  run(['settings', 'text=archive'], env)
  const r = JSON.parse(run(['--json', '--text-over', '5000', file], env).stdout)
  assert.equal(r.burned[0].kind, 'text')
  assert.ok(r.burned[0].archived, 'archived, not destroyed')
  assert.equal(readFileSync(r.burned[0].archived, 'utf8').length, 30000)
})

test('settings shows what environment variables changed, as the hooks see it', () => {
  const { root } = h.tempConfig([])
  const env = { CLAUDE_CONFIG_DIR: root, BURN_AFTER_READING_USER: 'burn' }
  const show = run(['settings'], env)
  assert.match(show.stdout, /\[user=burn\]/)
  assert.match(show.stdout, /BURN_AFTER_READING_USER: user=burn/)
  assert.equal(JSON.parse(run(['settings', '--json'], env).stdout).user, 'burn')
  assert.doesNotMatch(run(['settings'], { CLAUDE_CONFIG_DIR: root }).stdout, /environment variables/)
})

test("the command line burns a session's subagents with it", () => {
  const { root, dir, file } = h.tempConfig(session())
  const subDir = join(dir, h.SID, 'subagents')
  mkdirSync(subDir, { recursive: true })
  const side = (l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true })
  writeFileSync(join(subDir, 'agent-q.jsonl'), [h.toolUse('s1', 'Read', { file_path: '/b.png' }), h.readImageResult('s1', h.pngBase64(50, 50)), h.say('seen')].map(side).join('\n') + '\n')
  writeFileSync(join(subDir, 'agent-empty.jsonl'), h.say('nothing here') + '\n')
  const r = run([file], { CLAUDE_CONFIG_DIR: root })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /burned 1 image/)
  assert.match(r.stdout, /\n {2}subagent agent-q: burned 1 image/)
  assert.doesNotMatch(r.stdout, /agent-empty/)          // nothing happened there: not mentioned
  assert.equal(JSON.parse(run([file, '--json'], { CLAUDE_CONFIG_DIR: root }).stdout).subagents.length, 2)
})
