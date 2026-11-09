import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runHook, countMedia, optionsFromEnv } from '../src/hook.js'
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

test('countMedia and options', () => {
  assert.equal(countMedia({ type: 'image', file: { base64: 'x' } }), 1)
  assert.equal(countMedia({ content: [{ type: 'image', source: { type: 'base64', data: 'x' } }, { type: 'document', source: {} }] }), 2)
  assert.equal(countMedia('text'), 0)
  assert.deepEqual(optionsFromEnv({ BURN_AFTER_READING_KEEP: '2', BURN_AFTER_READING_TEXT_OVER: '20000', BURN_AFTER_READING_LANG: 'xx' }),
    { lang: 'en', keep: 2, textOver: 20000, backup: true, labels: true })
})
