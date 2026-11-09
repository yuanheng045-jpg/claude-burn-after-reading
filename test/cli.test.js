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

test('hook mode reads the event on stdin and never fails the session', () => {
  const { root, file } = h.tempConfig(session())
  const ok = run(['hook'], { CLAUDE_CONFIG_DIR: root }, JSON.stringify({ hook_event_name: 'SessionEnd', session_id: h.SID, transcript_path: file }))
  assert.equal(ok.status, 0)
  assert.ok(!readFileSync(file, 'utf8').includes('iVBORw0KGgo'))
  const garbage = run(['hook'], { CLAUDE_CONFIG_DIR: root }, 'not json')
  assert.equal(garbage.status, 0)
  assert.match(garbage.stderr, /burn-after-reading hook/)
})
