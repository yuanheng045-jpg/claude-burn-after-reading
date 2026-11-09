import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { burnLines, withoutMedia, checkLine, fingerprint } from '../src/burn.js'
import * as h from './helpers.js'
import { placeholderKind, mediaPlaceholder } from '../src/text.js'

beforeEach(() => h.reset())
const J = (l) => JSON.parse(l)
const B64 = 'iVBORw0KGgo'

test('burns an image Claude has answered; everything outside the content stays the same', () => {
  const lines = [h.userText('look'), h.toolUse('t1', 'Read', { file_path: '/home/me/shot.png' }), h.readImageResult('t1'), h.say('a cat'), '']
  const r = burnLines(lines)
  assert.equal(r.burned.length, 1)
  assert.equal(r.lines.length, lines.length)
  const before = J(lines[2]), after = J(r.lines[2])
  for (const k of ['uuid', 'parentUuid', 'sessionId', 'timestamp', 'type']) assert.equal(after[k], before[k])
  const text = after.message.content[0].content[0].text
  assert.match(text, /^\[image burned after reading · Read \/home\/me\/shot\.png · \d{4}-\d\d-\d\d \d\d:\d\d · read the file again if you need it\]$/)
  assert.equal(after.toolUseResult.file.base64, '')           // Claude Code's private copy is emptied too
  assert.equal(after.toolUseResult.file.type, 'image/png')    // but keeps its shape
  assert.ok(!r.lines.join('\n').includes(B64))
  for (const i of [0, 1, 3, 4]) assert.equal(r.lines[i], lines[i])
  assert.equal(r.burned[0].tokens, 6)                          // 64×64 px ≈ 6 tokens
})

test('an image Claude has not answered yet stays', () => {
  const lines = [h.userText('look'), h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1')]
  const r = burnLines(lines)
  assert.equal(r.burned.length, 0)
  assert.equal(r.unseen, 1)
  assert.deepEqual(r.lines, lines)
})

test('--keep leaves the newest seen images', () => {
  const lines = [h.toolUse('a', 'Read', { file_path: '/1.png' }), h.readImageResult('a'), h.say('one'),
    h.toolUse('b', 'Read', { file_path: '/2.png' }), h.readImageResult('b'), h.say('two')]
  const r = burnLines(lines, { keep: 1 })
  assert.equal(r.burned.length, 1)
  assert.equal(r.kept, 1)
  assert.equal(r.burned[0].path, '/1.png')
  assert.ok(r.lines[4].includes(B64))
})

test('an image the user attached: replaced in place, the message keeps its text', () => {
  const lines = [h.userBlocks([{ type: 'text', text: 'what is this?' }, h.image()]), h.say('a cat')]
  const r = burnLines(lines)
  assert.equal(r.burned.length, 1)
  const c = J(r.lines[0]).message.content
  assert.equal(c[0].text, 'what is this?')
  assert.match(c[1].text, /^\[image burned after reading · attached by the user · .+ · ask for it again if you need it\]$/)
})

test('a message that was only an image never becomes empty', () => {
  const r = burnLines([h.userBlocks([h.image()]), h.say('ok')])
  const c = J(r.lines[0]).message.content
  assert.equal(c.length, 1)
  assert.equal(c[0].type, 'text')
})

test('PDFs are burned too', () => {
  const lines = [h.toolUse('p', 'Read', { file_path: '/doc.pdf' }), h.toolResult('p', [h.pdf()]), h.say('read it')]
  const r = burnLines(lines)
  assert.equal(r.burned[0].kind, 'pdf')
  assert.match(J(r.lines[1]).message.content[0].content[0].text, /^\[PDF burned after reading · Read \/doc\.pdf/)
})

test('numbers from the PostToolUse hook end up in the placeholder, one per image', () => {
  const lines = [h.toolUse('m', 'mcp__browser__screenshot'),
    h.toolResult('m', [{ type: 'text', text: 'saved to https://x/y.png' }, h.image(), h.image()]),
    h.label('m', '[burn-after-reading] These images are #7, #8. After this turn they are removed'),
    h.say('two pages')]
  const r = burnLines(lines)
  const c = J(r.lines[1]).message.content[0].content
  assert.equal(c[0].text, 'saved to https://x/y.png')   // the tool's own text stays
  assert.match(c[1].text, /^\[image #7 burned after reading · mcp__browser__screenshot · .+ · call the tool again if you need it\]$/)
  assert.match(c[2].text, /^\[image #8 /)
  assert.deepEqual(r.burned.map(b => b.label), ['7', '8'])
})

test('running it again changes nothing', () => {
  const lines = [h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.say('ok')]
  const once = burnLines(lines).lines
  const twice = burnLines(once)
  assert.equal(twice.burned.length, 0)
  assert.deepEqual(twice.lines, once)
})

test('a line burned earlier but still carrying the private copy gets the copy emptied', () => {
  const data = h.pngBase64()
  const lines = [h.toolUse('t1', 'Read', { file_path: '/a.png' }),
    h.toolResult('t1', [{ type: 'text', text: '[image burned after reading · Read /a.png]' }], { type: 'image', file: { base64: data, type: 'image/png' } }),
    h.say('ok')]
  const r = burnLines(lines)
  assert.equal(J(r.lines[1]).toolUseResult.file.base64, '')
  assert.deepEqual(J(r.lines[1]).message, J(lines[1]).message)
})

test('placeholders in Chinese', () => {
  const lines = [h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.label('t1', '[burn-after-reading] 这张图是 #3。这一轮之后'), h.say('好')]
  const r = burnLines(lines, { lang: 'zh' })
  assert.match(J(r.lines[1]).message.content[0].content[0].text, /^〔图 #3 已阅后即焚 · Read \/a\.png · .+ · 要再看就重新读这个文件〕$/)
})

test('long text results: shortened only when asked, start kept, a kept image in the same result untouched, not shortened twice', () => {
  const long = '一'.repeat(50) + '😀' + 'x'.repeat(5000)
  const lines = [h.toolUse('b', 'Bash'), h.toolResult('b', [{ type: 'text', text: long }, h.image()]), h.say('done')]
  assert.equal(burnLines(lines).burned.length, 1)                         // off by default: only the image
  const r = burnLines(lines, { textOver: 1000, textKeep: 51, keep: 1 })  // keep the image, shorten the text
  const c = J(r.lines[1]).message.content[0].content
  assert.equal(c[0].text, '一'.repeat(50) + '😀')                        // never splits the emoji
  assert.equal(c[1].type, 'image')
  assert.match(c[2].text, /^\[5,000 more characters burned after reading · Bash/)
  assert.equal(burnLines(r.lines, { textOver: 10, textKeep: 51 }).burned.filter(b => b.kind === 'text').length, 0)
})

test('checkLine refuses edits that would break the transcript', () => {
  const l = h.toolResult('t1', [h.image()])
  const o = J(l)
  const edit = (f) => { const x = structuredClone(o); f(x); return JSON.stringify(x) }
  assert.equal(checkLine(l, edit(x => { x.message.content[0].content = [{ type: 'text', text: 'ok' }] })), null)
  assert.match(checkLine(l, edit(x => { x.uuid = 'other' })), /outside the message/)
  assert.match(checkLine(l, edit(x => { x.message.content[0].tool_use_id = 't2' })), /pairing/)
  assert.match(checkLine(l, edit(x => { x.message.content = [] })), /empty|pairing/)
  assert.match(checkLine(l, edit(x => { x.message.content[0].content = [{ type: 'text', text: 'half \ud83d' }] })), /half of a character/)
  const withText = h.userBlocks([{ type: 'text', text: 'hello' }, h.image()])
  const t = J(withText); t.message.content[0].text = 'changed'
  assert.match(checkLine(withText, JSON.stringify(t)), /existing text/)
})

test('lines it does not understand are left alone', () => {
  const lines = ['not json', h.meta({ type: 'queue-operation', operation: 'enqueue' }), h.toolUse('t1', 'Read'), h.readImageResult('t1'), h.say('ok')]
  const r = burnLines(lines)
  assert.equal(r.lines[0], 'not json')
  assert.equal(r.lines[1], lines[1])
  assert.equal(r.burned.length, 1)
})

test('backups keep text and structure, never any image (seen or not)', () => {
  const lines = [h.userBlocks([{ type: 'text', text: 'hi' }, h.image()]), h.toolUse('t1', 'Read'), h.readImageResult('t1')]
  const b = withoutMedia(lines)
  assert.equal(b.length, lines.length)
  assert.ok(!b.join('\n').includes(B64))
  assert.equal(J(b[0]).message.content[0].text, 'hi')
})

test('the copy Claude Code 2.1.3xx keeps in api-request-blob rows loses exactly the burned images', () => {
  const seenImg = h.pngBase64(64, 64), keptImg = h.pngBase64(32, 32)
  const blob = (img) => h.meta({ type: 'api-request-blob', hash: 'abc', message: { role: 'user', content: [{ type: 'text', text: 'what?' }, h.image(img)] } })
  const lines = [h.userBlocks([{ type: 'text', text: 'what?' }, h.image(seenImg)]), blob(seenImg), h.say('a cat'),
    h.userBlocks([{ type: 'text', text: 'and this?' }, h.image(keptImg)]), blob(keptImg)]
  const r = burnLines(lines)
  assert.equal(r.burned.length, 1)
  const b1 = J(r.lines[1])
  assert.equal(b1.hash, 'abc')
  assert.equal(b1.message.content[0].text, 'what?')
  assert.match(b1.message.content[1].text, /attached by the user/)
  assert.equal(r.lines[4], lines[4])               // not answered yet: its copy stays too
  assert.deepEqual(r.elsewhere, {})
})

test('reports image data left in record types it does not edit', () => {
  const lines = [h.meta({ type: 'some-future-record', payload: { content: [h.image()] } }), h.say('ok')]
  assert.deepEqual(burnLines(lines).elsewhere, { 'some-future-record': 1 })
})

// ---- what to do per kind: keep / archive / burn ----
test('each kind follows its own setting; archived ones point Claude at the copy', () => {
  const lines = [
    h.userBlocks([{ type: 'text', text: 'my cat' }, h.image()]),                               // user
    h.toolUse('s', 'mcp__browser__screenshot'), h.toolResult('s', [h.image(h.pngBase64(32, 32))]),  // screenshot
    h.toolUse('r', 'Read', { file_path: '/a.png' }), h.readImageResult('r', h.pngBase64(16, 16)),  // file
    h.say('seen'),
  ]
  const asked = []
  const archive = (item) => { asked.push(item); return `/archive/${item.category}.png` }
  const r = burnLines(lines, { modes: { user: 'archive', screenshot: 'keep', file: 'burn' }, archive })
  assert.deepEqual(r.burned.map(b => [b.category, b.archived]), [['user', '/archive/user.png'], ['file', null]])
  assert.equal(r.kept, 1)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].mediaType, 'image/png')
  assert.ok(asked[0].data.startsWith('iVBORw0KGgo'))
  assert.match(J(r.lines[0]).message.content[1].text, /attached by the user · .+ · a copy is kept at \/archive\/user\.png, read it if you need it\]$/)
  assert.equal(r.lines[2], lines[2])                                                         // screenshot kept
  assert.match(J(r.lines[4]).message.content[0].content[0].text, /read the file again if you need it\]$/)
})

test('if an archive copy cannot be saved, that item stays where it is', () => {
  const lines = [h.userBlocks([h.image()]), h.say('ok')]
  const r = burnLines(lines, { modes: { user: 'archive' }, archive: () => null })
  assert.equal(r.burned.length, 0)
  assert.deepEqual(r.lines, lines)
  assert.match(r.skipped[0].reason, /archive copy could not be saved/)
  assert.equal(burnLines(lines, { modes: { user: 'archive' } }).burned.length, 0)   // no archive function: same
})

test('long text can be archived too: the whole text goes to the copy, the start stays', () => {
  const lines = [h.toolUse('b', 'Bash'), h.toolResult('b', 'z'.repeat(30000)), h.say('ok')]
  let saved = ''
  const r = burnLines(lines, { modes: { text: 'archive' }, archive: (it) => { saved = it.text; return '/archive/t.txt' } })
  assert.equal(saved.length, 30000)
  assert.match(J(r.lines[1]).message.content[0].content[1].text, /29,600 more characters burned after reading · Bash · .+ · a copy is kept at \/archive\/t\.txt/)
})

test("finds Claude Code's own saved file of each burned attached image", () => {
  const meta = JSON.stringify({ type: 'user', isMeta: true, uuid: 'm', sessionId: h.SID, message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/claude-1/p/s/images/1.png]\n[Image: source: /tmp/claude-1/p/s/images/2.png]' }] } })
  const lines = [h.userBlocks([{ type: 'text', text: 'two' }, h.image(h.pngBase64(8, 8)), h.image(h.pngBase64(9, 9))]), h.meta({ type: 'attachment', attachment: { type: 'x' } }), meta, h.say('ok')]
  assert.deepEqual(burnLines(lines).tempCopies, ['/tmp/claude-1/p/s/images/1.png', '/tmp/claude-1/p/s/images/2.png'])
  assert.deepEqual(burnLines(lines, { keep: 1 }).tempCopies, ['/tmp/claude-1/p/s/images/1.png'])
})

// ---- review findings (2026-11-09) ----
test('an API error Claude Code wrote itself is not an answer: the image stays', () => {
  const err = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, uuid: 'e1', sessionId: h.SID, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } })
  const side = JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'e2', sessionId: h.SID, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } })
  const r = burnLines([h.userBlocks([{ type: 'text', text: 'look' }, h.image()]), err, side])
  assert.equal(r.burned.length, 0)
  assert.equal(r.unseen, 1)
})

test('--text-over: never makes a result bigger, never keeps more than the threshold', () => {
  const small = [h.toolUse('b', 'Bash'), h.toolResult('b', 'x'.repeat(250)), h.say('ok')]
  const r1 = burnLines(small, { textOver: 100 })
  assert.equal(r1.burned.length, 0)
  assert.deepEqual(r1.lines, small)
  const big = [h.toolUse('b', 'Bash'), h.toolResult('b', 'y'.repeat(1000)), h.say('ok')]
  const r2 = burnLines(big, { textOver: 100 })
  assert.equal(r2.burned.length, 1)
  assert.ok(r2.lines[1].length < big[1].length)
  assert.equal(J(r2.lines[1]).message.content[0].content[0].text, 'y'.repeat(100))
})

test('--text-over shortens only the output in the private copy, never other fields or image data', () => {
  const tur = { type: 'update', originalFile: 'o'.repeat(5000), stdout: 's'.repeat(5000) }
  const lines = [h.toolUse('b', 'Bash'), h.toolResult('b', 's'.repeat(5000), tur), h.say('ok')]
  const c = J(burnLines(lines, { textOver: 2000 }).lines[1]).toolUseResult
  assert.equal(c.originalFile.length, 5000)
  assert.ok(c.stdout.length < 1000)
})

test('with --keep, the private copy of the burned image is emptied and the kept one is not', () => {
  const a = h.pngBase64(64, 64), b = h.pngBase64(32, 32)
  const lines = [h.toolUse('m', 'mcp__x__shot'),
    h.toolResult('m', [h.image(a), h.image(b)], [{ type: 'image', data: a, mimeType: 'image/png' }, { type: 'image', data: b, mimeType: 'image/png' }]),
    h.say('ok')]
  const o = J(burnLines(lines, { keep: 1 }).lines[1])
  assert.equal(o.toolUseResult[0].data, '')
  assert.equal(o.toolUseResult[1].data, b)
  assert.equal(o.message.content[0].content[1].source.data, b)
})

test('copies inside tool results in api-request-blob rows are replaced too', () => {
  const img = h.pngBase64(64, 64)
  const blob = h.meta({ type: 'api-request-blob', hash: 'h', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [h.image(img)] }] } })
  const r = burnLines([h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1', img), blob, h.say('ok')])
  assert.ok(!r.lines[2].includes(img.slice(0, 40)))
  assert.deepEqual(r.elsewhere, {})
})

test('numbers: matched by fingerprint; by position only when the counts agree, else no number rather than a wrong one', () => {
  const a = h.pngBase64(64, 64)
  const lines = [h.toolUse('m', 'mcp__x__shot'), h.toolResult('m', [h.image(a)]), h.label('m', '[burn-after-reading] These images are #7, #8.'), h.say('ok')]
  assert.equal(burnLines(lines).burned[0].label, null)
  assert.equal(burnLines(lines, { labelsByFingerprint: new Map([[fingerprint(a), '8']]) }).burned[0].label, '8')
})

test('lines that are frozen (not valid UTF-8) are never edited', () => {
  const lines = [h.toolUse('t1', 'Read'), h.readImageResult('t1'), h.say('ok')]
  const r = burnLines(lines, { frozen: new Set([1]) })
  assert.equal(r.burned.length, 0)
  assert.equal(r.lines[1], lines[1])
  assert.match(r.skipped[0].reason, /UTF-8/)
})

test('backups drop image data wherever it sits, including MCP-shaped copies and unknown records', () => {
  const lines = [
    h.meta({ type: 'attachment', attachment: { type: 'queued_command', prompt: [h.image()] } }),
    h.meta({ type: 'something-new', blocks: [{ type: 'image', data: h.pngBase64(), mimeType: 'image/png' }] }),
  ]
  const b = withoutMedia(lines)
  assert.ok(!b.join('\n').includes('iVBORw0KGgo'))
  assert.deepEqual(burnLines(lines).elsewhere, { attachment: 1, 'something-new': 1 })
})

// ---- second review (2026-11-09) ----
const sourceRow = (paths) => JSON.stringify({ type: 'user', isMeta: true, uuid: 'm', sessionId: h.SID, message: { role: 'user', content: [{ type: 'text', text: paths.map(p => `[Image: source: ${p}]`).join('\n') }] } })

test("Claude Code's own files: none are picked when there isn't exactly one source line per image", () => {
  // the first image has no source line: by position, the kept second image's file would be taken for the first one's
  const lines = [h.userBlocks([h.image(h.pngBase64(8, 8)), h.image(h.pngBase64(9, 9))]), sourceRow(['/tmp/c/p/s/images/2.png']), h.say('ok')]
  const r = burnLines(lines, { keep: 1 })
  assert.equal(r.burned.length, 1)
  assert.deepEqual(r.tempCopies, [])
})

test("Claude Code's own files: a later run still finds the right file when earlier images are already burned", () => {
  const lines = [h.userBlocks([h.image(h.pngBase64(8, 8)), h.image(h.pngBase64(9, 9))]), sourceRow(['/tmp/c/p/s/images/1.png', '/tmp/c/p/s/images/2.png']), h.say('ok')]
  const first = burnLines(lines, { keep: 1 })
  assert.deepEqual(first.tempCopies, ['/tmp/c/p/s/images/1.png'])
  const second = burnLines(first.lines, { keep: 0 })
  assert.equal(second.burned.length, 1)
  assert.deepEqual(second.tempCopies, ['/tmp/c/p/s/images/2.png'])
  // the same in Chinese placeholders
  const zh = burnLines(burnLines(lines, { keep: 1, lang: 'zh' }).lines, { lang: 'zh' })
  assert.deepEqual(zh.tempCopies, ['/tmp/c/p/s/images/2.png'])
})

test('an unknown mode touches nothing', () => {
  const lines = [h.userBlocks([h.image()]), h.say('ok')]
  const r = burnLines(lines, { modes: { user: 'archived' } })
  assert.equal(r.burned.length, 0)
  assert.deepEqual(r.lines, lines)
  assert.equal(r.kept, 1)
})

test("in a subagent's transcript (all sidechain rows) its answers count", () => {
  const side = (l) => JSON.stringify({ ...J(l), isSidechain: true, agentId: 'abc' })
  const lines = [h.userText('look at it'), h.toolUse('t1', 'Read', { file_path: '/a.png' }), h.readImageResult('t1'), h.say('a cat')].map(side)
  assert.equal(burnLines(lines).burned.length, 0)                      // as a main transcript: no main answer, left alone
  const r = burnLines(lines, { sidechain: true })
  assert.equal(r.burned.length, 1)
  assert.ok(!r.lines.join('\n').includes(B64))
})

test('placeholders tell images from PDFs, with or without a number, in both languages', () => {
  for (const lang of ['en', 'zh']) {
    for (const label of [null, '7']) {
      assert.equal(placeholderKind(mediaPlaceholder({ kind: 'image', label, fromUser: true, time: '2026-11-09 14:32' }, lang)), 'image')
      assert.equal(placeholderKind(mediaPlaceholder({ kind: 'pdf', label, tool: 'Read', path: '/a.pdf' }, lang)), 'pdf')
    }
  }
  assert.equal(placeholderKind('[image of my cat] burned after reading · later'), null)
  assert.equal(placeholderKind('look at this image'), null)
})
