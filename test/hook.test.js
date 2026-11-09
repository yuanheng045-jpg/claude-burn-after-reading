import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runHook, countMedia } from '../src/hook.js'
import { resolveOptions } from '../src/transcript.js'
import * as h from './helpers.js'

const saved = process.env.CLAUDE_CONFIG_DIR
beforeEach(() => h.reset())
afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved })

test('PostToolUse: images get numbers, other results get nothing', () => {
  const { root } = h.tempConfig([])
  process.env.CLAUDE_CONFIG_DIR = root
  const read = { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_use_id: 't1', tool_response: { type: 'image', file: { base64: h.pngBase64() } } }
  const first = JSON.parse(runHook(read, {}))
  assert.equal(first.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(first.hookSpecificOutput.additionalContext, /^\[burn-after-reading\] This image is #1\./)
  const mcp = { ...read, tool_name: 'mcp__x__shot', tool_response: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'image', data: 'BBBB', mimeType: 'image/png' }] }
  assert.match(JSON.parse(runHook(mcp, {})).hookSpecificOutput.additionalContext, /These images are #2, #3\./)
  assert.equal(runHook({ ...read, tool_response: { type: 'text', file: { content: 'hello' } } }, {}), '')
  assert.equal(runHook(read, { BURN_AFTER_READING_LABELS: '0' }), '')
  assert.match(JSON.parse(runHook(read, { BURN_AFTER_READING_LANG: 'zh' })).hookSpecificOutput.additionalContext, /^\[burn-after-reading\] 这张图是 #4。/)
  const pdfRead = { ...read, tool_response: { type: 'pdf', file: { base64: 'JVBER' } } }
  assert.match(JSON.parse(runHook(pdfRead, {})).hookSpecificOutput.additionalContext, /This PDF is #5\./)
  assert.match(JSON.parse(runHook(pdfRead, { BURN_AFTER_READING_LANG: 'zh' })).hookSpecificOutput.additionalContext, /这份 PDF 是 #6。/)
})

test('SessionEnd: burns the transcript it is given', () => {
  const lines = [h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.say('ok')]
  const { root, file } = h.tempConfig(lines)
  process.env.CLAUDE_CONFIG_DIR = root
  assert.equal(runHook({ hook_event_name: 'SessionEnd', session_id: h.SID, transcript_path: file, reason: 'other' }, { BURN_AFTER_READING_LANG: 'zh' }), '')
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes('iVBORw0KGgo'))
  assert.ok(text.includes('已阅后即焚'))
  assert.match(readFileSync(`${root}/burn-after-reading/hook.log`, 'utf8'), /SessionEnd .* 1 burned/)
})

test('other events and odd input are ignored', () => {
  assert.equal(runHook({ hook_event_name: 'Stop' }, {}), '')
  assert.equal(runHook({ hook_event_name: 'SessionEnd', transcript_path: 42 }, {}), '')
  assert.equal(runHook(null, {}), '')
})

test('countMedia, and options: defaults, then the settings file, then environment variables', () => {
  assert.equal(countMedia({ type: 'image', file: { base64: 'x' } }), 1)
  assert.equal(countMedia({ content: [{ type: 'image', source: { type: 'base64', data: 'x' } }, { type: 'document', source: {} }] }), 2)
  assert.equal(countMedia('text'), 0)
  const { root } = h.tempConfig([])
  assert.deepEqual(resolveOptions(root, {}, {}), { modes: { user: 'archive', screenshot: 'burn', file: 'burn', text: 'keep' }, textOver: 20000, keep: 0, lang: 'en', backup: true, archiveDays: 30, labels: true })
  mkdirSync(join(root, 'burn-after-reading'), { recursive: true })
  writeFileSync(join(root, 'burn-after-reading', 'settings.json'), JSON.stringify({ user: 'burn', text: 'archive', lang: 'zh', archiveDays: 'nonsense' }))
  const o = resolveOptions(root, {}, { BURN_AFTER_READING_KEEP: '2', BURN_AFTER_READING_SCREENSHOT: 'keep', BURN_AFTER_READING_LANG: 'xx' })
  assert.deepEqual(o.modes, { user: 'burn', screenshot: 'keep', file: 'burn', text: 'archive' })
  assert.equal(o.lang, 'zh')         // a bad env value is ignored
  assert.equal(o.archiveDays, 30)    // a bad saved value falls back to the default
  assert.equal(o.keep, 2)
})

// ---- second review (2026-11-09) ----
test('PostToolUse: no number for a kind that is set to keep (it stays, so nothing to say)', () => {
  const { root } = h.tempConfig([])
  process.env.CLAUDE_CONFIG_DIR = root
  const read = { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_use_id: 't1', tool_response: { type: 'image', file: { base64: h.pngBase64() } } }
  const shot = { ...read, tool_name: 'mcp__browser__screenshot', tool_response: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }
  assert.equal(runHook(read, { BURN_AFTER_READING_FILE: 'keep' }), '')
  assert.match(runHook(shot, { BURN_AFTER_READING_FILE: 'keep' }), /This image is #1/)
  assert.equal(runHook(shot, { BURN_AFTER_READING_SCREENSHOT: 'keep' }), '')
  assert.match(runHook(read, { BURN_AFTER_READING_FILE: 'archive' }), /This image is #2/)
})

test("SessionEnd: the session's subagents are burned too, and the log says so", () => {
  const { root, dir, file } = h.tempConfig([h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.say('ok')])
  process.env.CLAUDE_CONFIG_DIR = root
  const subDir = join(dir, h.SID, 'subagents')
  mkdirSync(subDir, { recursive: true })
  const side = (l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true })
  const sub = join(subDir, 'agent-x1.jsonl')
  writeFileSync(sub, [h.toolUse('s1', 'Read', { file_path: '/b.png' }), h.readImageResult('s1', h.pngBase64(50, 50)), h.say('seen')].map(side).join('\n') + '\n')
  runHook({ hook_event_name: 'SessionEnd', session_id: h.SID, transcript_path: file, reason: 'other' }, {})
  assert.ok(!readFileSync(sub, 'utf8').includes('iVBORw0KGgo'))
  assert.match(readFileSync(join(root, 'burn-after-reading', 'hook.log'), 'utf8'), /2 burned, 1 of them in subagents/)
})
