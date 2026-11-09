// Builders for synthetic Claude Code transcripts (shaped like what Claude Code 2.1.x writes).
import * as zlib from 'node:zlib'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { deflateSync } = zlib
const crc = (buf) => (typeof zlib.crc32 === 'function' ? zlib.crc32(buf) : crcFallback(buf))   // zlib.crc32 is Node 20.15+
function crcFallback(buf) {
  let c, crcv = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crcv ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcv = (crcv >>> 8) ^ c
  }
  return (crcv ^ 0xffffffff) >>> 0
}
/** A real PNG of the given size, as base64 (big enough to look like a screenshot to the tool). */
export function pngBase64(w = 64, h = 64) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td) >>> 0)
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
  return png.toString('base64')
}
export const PDF_B64 = Buffer.from('%PDF-1.4\n' + 'x'.repeat(3000) + '\n%%EOF').toString('base64')

export const SID = '0f0f0f0f-1111-4222-8333-444444444444'
let u = 0
const base = (o) => ({ parentUuid: u ? 'uuid-' + u : null, isSidechain: false, sessionId: SID, timestamp: '2026-11-09T06:32:00.000Z', uuid: 'uuid-' + (++u), ...o })
export const reset = () => { u = 0 }
export const image = (data = pngBase64()) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
export const pdf = () => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 } })
export const userText = (text) => JSON.stringify(base({ type: 'user', message: { role: 'user', content: text } }))
export const userBlocks = (content) => JSON.stringify(base({ type: 'user', message: { role: 'user', content } }))
export const say = (text) => JSON.stringify(base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }))
export const toolUse = (id, name, input = {}) => JSON.stringify(base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }))
export const toolResult = (id, content, toolUseResult) => JSON.stringify(base({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...(toolUseResult !== undefined ? { toolUseResult } : {}) }))
export const readImageResult = (id, data = pngBase64()) => toolResult(id, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }], { type: 'image', file: { base64: data, type: 'image/png', originalSize: data.length } })
export const label = (toolUseID, text) => JSON.stringify(base({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text], hookName: 'PostToolUse:Read', toolUseID, hookEvent: 'PostToolUse' } }))
export const meta = (o) => JSON.stringify({ sessionId: SID, ...o })

// every temporary folder a test makes is removed when its test file is done
const made = []
process.on('exit', () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })
/** A new empty folder in the temp folder, removed afterwards. */
export function tempDir(prefix = 'bar-test-') {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}

/** A temporary CLAUDE_CONFIG_DIR with the transcript lines written into a project folder. */
export function tempConfig(lines, sid = SID) {
  const root = tempDir('bar-test-')
  const dir = join(root, 'projects', '-tmp-proj')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, sid + '.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return { root, dir, file }
}
