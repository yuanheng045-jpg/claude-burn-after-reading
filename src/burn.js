// The core: given the lines of a Claude Code transcript, replace what Claude has already seen with short placeholders.
// Pure (no file access), so it can be tested on its own and reused by other tools.
//
// What counts as "seen": an image/PDF/long text with a real answer from Claude after it in the file. API error
// messages and other rows Claude Code makes up itself (model "<synthetic>") and sidechain rows don't count.
// Anything after the last real answer is left alone.
//
// What is never changed: the number and order of lines, every field outside message.content and toolUseResult
// (uuid, parentUuid, sessionId, timestamps…), the pairing of tool_use and tool_result, and every existing text block.
// Each changed line is checked against that before it is accepted; a line that fails stays exactly as it was.

import { createHash } from 'node:crypto'
import { imageSize, imageTokens } from './media.js'
import { localTime, mediaPlaceholder, textPlaceholder, parseLabel, isOurPlaceholder, placeholderKind } from './text.js'

/**
 * @typedef {object} BurnOptions
 * @property {number} [keep]       how many of the most recent seen images/PDFs to leave in place (default 0; not used for text)
 * @property {number} [textOver]   also shorten text tool results longer than this many characters (default 0 = off)
 * @property {number} [textKeep]   characters to keep from the start of a shortened text result (default 400, never more than textOver)
 * @property {string} [lang]       placeholder language: 'en' (default) or 'zh'
 * @property {Set<number>} [frozen]   line indexes that must not be edited (for example lines that are not valid UTF-8)
 * @property {Map<string,string>} [labelsByFingerprint]  image fingerprint -> number, as recorded by the PostToolUse hook
 * @property {{ user?: Mode, screenshot?: Mode, file?: Mode, text?: Mode }} [modes]  what to do per category (default: burn
 *   images and PDFs of every category, leave text; `textOver` > 0 alone also turns text on)
 * @property {(item: object) => string|null} [archive]  saves a copy for 'archive' mode and returns where; null = couldn't
 * @property {boolean} [sidechain]  the lines are a subagent's transcript: its (sidechain) answers count as answers
 *
 * @typedef {'keep'|'archive'|'burn'} Mode
 *
 * @typedef {object} BurnedItem
 * @property {'image'|'pdf'|'text'} kind
 * @property {number} line          0-based line index
 * @property {string|null} tool      tool name, or null for something the user attached
 * @property {string|null} path      file path for Read, if known
 * @property {string|null} label     the number a PostToolUse hook gave it, if any
 * @property {number} bytes          size of the data that was removed
 * @property {number|null} tokens    estimated input tokens it cost on every request (images only)
 */

const MIN_SAVING = 200   // don't shorten a text result unless it saves at least this many characters
export const isB64Media = (b) => (b?.type === 'image' || b?.type === 'document') && b?.source?.type === 'base64' && typeof b.source.data === 'string'
export const fingerprint = (data) => createHash('sha1').update(data).digest('hex')
const mediaKind = (b) => (b.type === 'document' ? 'pdf' : 'image')
const MEDIA_MIME = /^(image\/|application\/pdf)/
const IMAGE_SOURCE_RE = /\[Image: source: ([^\]\n]+)\]/g
const LONE_ESCAPE = /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g
const loneSurrogates = (line) => (line.match(LONE_ESCAPE) || []).length

function parse(line) {
  if (!line || line.length < 2 || line[0] !== '{') return null
  try { return JSON.parse(line) } catch { return null }
}
/** A real answer from Claude (not an API error Claude Code wrote itself; a sidechain one only in a subagent's transcript). */
const isRealAnswer = (o, sidechain) => o?.type === 'assistant' && !o.isApiErrorMessage && (sidechain || !o.isSidechain) && o.message?.model !== '<synthetic>'
const MODES = new Set(['keep', 'archive', 'burn'])
const hasMediaIn = (content) => Array.isArray(content) && content.some(b => isB64Media(b) || (b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some(isB64Media)))

/** Text of a tool_result's content (string or array of blocks), leaving out placeholders this tool put there. */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string' && !isOurPlaceholder(b.text)).map(b => b.text).join('\n')
}
/** Cut by code point so an emoji is never split in half. */
function cut(s, n) {
  const a = Array.from(s)
  return a.length <= n ? s : a.slice(0, n).join('')
}
const charLen = (s) => Array.from(s).length
/** Keep the first `keepChars` characters of a tool result's text, drop the rest, append `tail`. Other blocks stay where they are. */
function shortenResult(content, keepChars, tail) {
  if (typeof content === 'string') return [{ type: 'text', text: cut(content, keepChars) }, { type: 'text', text: tail }]
  let budget = keepChars
  const out = []
  for (const x of content) {
    if (x?.type !== 'text' || typeof x.text !== 'string' || isOurPlaceholder(x.text)) { out.push(x); continue }
    if (budget <= 0) continue
    const t = cut(x.text, budget)
    budget -= charLen(t)
    out.push({ ...x, text: t })
  }
  out.push({ type: 'text', text: tail })
  return out
}
const TEXT_CUT_RE = /more characters burned after reading|个字已阅后即焚/
const alreadyShortened = (content) => Array.isArray(content) && content.some(x => x?.type === 'text' && TEXT_CUT_RE.test(x.text ?? ''))

// ---- Claude Code's private copy of a tool result (toolUseResult): shown in its UI, never sent to Claude ----
const isDataKey = (k, x) => k === 'base64' || (k === 'data' && (x.type === 'base64' || MEDIA_MIME.test(String(x.mimeType ?? x.media_type ?? ''))))
/** Empty long base64 strings in `v`; with `only`, just those whose fingerprint is in it. Keeps the structure. */
function blankData(v, only = null) {
  let removed = 0
  const visit = (x) => {
    if (Array.isArray(x)) { x.forEach(visit); return }
    if (!x || typeof x !== 'object') return
    for (const k of Object.keys(x)) {
      const y = x[k]
      if (typeof y === 'string' && y.length >= 1000 && isDataKey(k, x) && (!only || only.has(fingerprint(y)))) { removed += y.length; x[k] = '' }
      else if (y && typeof y === 'object') visit(y)
    }
  }
  visit(v)
  return removed
}
// Only the copies of the output itself are shortened (Bash stdout/stderr, Read's file content, MCP text blocks),
// never other fields such as an Edit's originalFile, and never image data.
const OUTPUT_KEYS = new Set(['stdout', 'stderr', 'output', 'content', 'text'])
function shortenCopy(v, over, keepChars, tail) {
  const visit = (x) => {
    if (Array.isArray(x)) { x.forEach(visit); return }
    if (!x || typeof x !== 'object') return
    for (const k of Object.keys(x)) {
      const y = x[k]
      if (typeof y === 'string' && y.length > over && OUTPUT_KEYS.has(k) && !isDataKey(k, x)) x[k] = cut(y, keepChars) + '\n' + tail
      else if (y && typeof y === 'object') visit(y)
    }
  }
  visit(v)
}

const stripForCompare = (o) => JSON.stringify({ ...o, message: o.message ? { ...o.message, content: null } : o.message, toolUseResult: null })
function idsOf(o) {
  const ids = []
  const c = o?.message?.content
  if (Array.isArray(c)) for (const b of c) {
    if (b?.type === 'tool_use') ids.push('u:' + b.id)
    if (b?.type === 'tool_result') ids.push('r:' + b.tool_use_id)
  }
  return ids.join(',')
}
const textsOf = (c) => (Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : [])
  .filter(b => b?.type === 'text' && !isOurPlaceholder(b.text)).map(b => b.text)

/** Is the edited line safe to write in place of the original? Returns null if yes, or the reason it isn't. */
export function checkLine(oldLine, newLine) {
  const a = parse(oldLine), b = parse(newLine)
  if (!a || !b) return 'not valid JSON'
  if (newLine.includes('\n')) return 'line break inside the line'
  if (stripForCompare(a) !== stripForCompare(b)) return 'a field outside the message content changed'
  if (idsOf(a) !== idsOf(b)) return 'tool_use / tool_result pairing changed'
  if (JSON.stringify(textsOf(a.message?.content)) !== JSON.stringify(textsOf(b.message?.content))) return 'an existing text block changed'
  const c = b.message?.content
  if (Array.isArray(c) && c.length === 0) return 'the message would be empty'
  if (loneSurrogates(newLine) > loneSurrogates(oldLine)) return 'it would contain half of a character'
  return null
}

/** Count image/PDF data anywhere in a value (content blocks, MCP-style {data, mimeType}, base64 fields). */
function countData(v, skip = null) {
  let n = 0
  const visit = (x) => {
    if (Array.isArray(x)) { x.forEach(visit); return }
    if (!x || typeof x !== 'object') return
    if (isB64Media(x)) { if (x.source.data.length >= 1000 && !(skip && skip.has(fingerprint(x.source.data)))) n++; return }
    for (const k of Object.keys(x)) {
      const y = x[k]
      if (typeof y === 'string' && y.length >= 1000 && isDataKey(k, x)) { if (!(skip && skip.has(fingerprint(y)))) n++ }
      else if (y && typeof y === 'object') visit(y)
    }
  }
  visit(v)
  return n
}

/**
 * Plan and apply a burn to transcript lines.
 * @param {string[]} lines lines of the .jsonl file (as split on '\n')
 * @param {BurnOptions} [opts]
 * @returns {{ lines: string[], burned: BurnedItem[], skipped: Array<{ line: number, reason: string }>, kept: number, unseen: number, elsewhere: Record<string, number>, tempCopies: string[] }}
 *   `elsewhere`: image data still present in record types this tool doesn't edit (a hint that Claude Code changed its format)
 *   `tempCopies`: Claude Code's own saved files of the burned attached images (the caller decides whether to delete them)
 */
export function burnLines(lines, opts = {}) {
  const keep = Math.max(0, Math.floor(opts.keep ?? 0))
  // what to do with each kind of thing: 'keep' (leave it), 'archive' (burn, keep a copy Claude can read), 'burn' (destroy)
  const modes = { user: 'burn', screenshot: 'burn', file: 'burn', text: opts.textOver > 0 ? 'burn' : 'keep', ...(opts.modes ?? {}) }
  for (const k of Object.keys(modes)) if (!MODES.has(modes[k])) modes[k] = 'keep'   // something unknown: touch nothing
  const textOver = modes.text !== 'keep' ? Math.max(1, Math.floor(opts.textOver || 20000)) : 0
  const keepChars = Math.min(Math.max(0, Math.floor(opts.textKeep ?? 400)), textOver || Infinity)
  const lang = opts.lang ?? 'en'
  const frozen = opts.frozen ?? new Set()
  const byFp = opts.labelsByFingerprint ?? new Map()
  const archive = typeof opts.archive === 'function' ? opts.archive : null

  // 1. one cheap pass: tool names, the last real answer, hook labels, and the lines worth parsing
  const tools = new Map()   // tool_use id -> { name, path }
  const labels = new Map()  // tool_use id -> [numbers]
  let lastAnswer = -1
  const candidates = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l) continue
    const maybeAssistant = l.includes('"assistant"')
    const maybeLabel = l.includes('hook_additional_context') && l.includes('[burn-after-reading]')
    const maybeMedia = l.includes('"base64"') || (textOver > 0 && l.includes('"tool_result"') && l.length > textOver)
    if (!maybeAssistant && !maybeLabel && !maybeMedia) continue
    const o = parse(l)
    if (!o) continue
    if (o.type === 'assistant') {
      if (isRealAnswer(o, !!opts.sidechain)) lastAnswer = i
      const c = o.message?.content
      if (Array.isArray(c)) for (const b of c) {
        if (b?.type === 'tool_use' && b.id) tools.set(b.id, { name: String(b.name ?? ''), path: typeof b.input?.file_path === 'string' ? b.input.file_path : null })
      }
    } else if (o.type === 'attachment' && o.attachment?.type === 'hook_additional_context' && o.attachment.toolUseID) {
      const nos = [].concat(o.attachment.content ?? []).flatMap(parseLabel)
      if (nos.length) labels.set(o.attachment.toolUseID, nos)
    } else if (o.type === 'user' && maybeMedia) candidates.push(i)
  }

  // 2. everything seen, in order, so the newest `keep` can be left alone. Each thing has a category:
  //    'user' (attached to a message), 'file' (an image/PDF read with Read), 'screenshot' (any other tool), 'text'
  /** @type {Array<{ line: number, kind: 'image'|'pdf'|'text', category: string, at: number[], nth?: number, of?: number, ord?: number }>} */
  const found = []
  let unseen = 0, keptBySettings = 0
  const parsed = new Map()
  const imageSlots = new Map()   // line -> how many images the message has, burned ones (placeholders) included
  for (const i of candidates) {
    const o = parse(lines[i])
    const c = o?.message?.content
    if (!Array.isArray(c)) continue
    parsed.set(i, o)
    const seen = i < lastAnswer
    let ord = 0   // which attached image of this message it is (Claude Code saves them in this order)
    c.forEach((b, j) => {
      if (b?.type === 'text' && placeholderKind(b.text) === 'image') ord++   // burned by an earlier run: still a slot
      else if (isB64Media(b)) {
        const f = { line: i, kind: mediaKind(b), category: 'user', at: [j], ord: b.type === 'image' ? ord++ : -1 }
        if (!seen) unseen++
        else if (modes.user === 'keep') keptBySettings++
        else found.push(f)
      } else if (b?.type === 'image') ord++   // an image that isn't inline data: counted, so the count can't match by luck
      else if (b?.type === 'tool_result') {
        const category = tools.get(b.tool_use_id)?.name === 'Read' ? 'file' : 'screenshot'
        const of = Array.isArray(b.content) ? b.content.filter(isB64Media).length : 0
        let nth = 0   // which image of this tool result it is (the hook numbers them in this order)
        if (Array.isArray(b.content)) b.content.forEach((x, k) => {
          if (!isB64Media(x)) return
          if (!seen) unseen++
          else if (modes[category] === 'keep') keptBySettings++
          else found.push({ line: i, kind: mediaKind(x), category, at: [j, k], nth, of })
          nth++
        })
        const len = textOver > 0 && seen && !alreadyShortened(b.content) ? charLen(resultText(b.content)) : 0
        if (len > textOver && len - keepChars >= MIN_SAVING) found.push({ line: i, kind: 'text', category: 'text', at: [j] })
      }
    })
    imageSlots.set(i, ord)
  }
  // `keep` is about images/PDFs; long text results (opt-in) are all shortened once Claude has answered them
  const media = found.filter(f => f.kind !== 'text'), texts = found.filter(f => f.kind === 'text')
  const burnSet = new Set([...media.slice(0, Math.max(0, media.length - keep)), ...texts])
  const kept = found.length - burnSet.size + keptBySettings

  // 3. edit line by line; a line is written only if it passes checkLine
  const out = lines.slice()
  /** @type {BurnedItem[]} */
  const burned = []
  const skipped = []
  const burnedText = new Map()   // fingerprint -> placeholder, for copies elsewhere in the file
  const tempCopies = []          // Claude Code's own files of burned attached images
  const byLine = new Map()
  for (const f of found) if (burnSet.has(f)) { if (!byLine.has(f.line)) byLine.set(f.line, []); byLine.get(f.line).push(f) }
  for (const [i, fs] of byLine) {
    if (frozen.has(i)) { skipped.push({ line: i, reason: 'the line is not valid UTF-8, so it is left byte for byte' }); continue }
    const o = structuredClone(parsed.get(i))
    const time = localTime(o.timestamp)
    const items = []
    const fps = new Set()
    const ords = []
    let textTail = null
    // asks for an archive copy; if one is wanted but can't be made, the item stays where it is
    const keepCopy = (f, payload) => {
      if (modes[f.category] !== 'archive') return { ok: true, path: null }
      const path = archive ? archive({ ...payload, kind: f.kind, category: f.category, line: i, timestamp: o.timestamp }) : null
      if (!path) skipped.push({ line: i, reason: 'an archive copy could not be saved, so it was left in place' })
      return { ok: !!path, path }
    }
    // images first, long text after: shortening a result must not lose the placeholder of an image burned from it
    for (const f of [...fs.filter(f => f.kind !== 'text'), ...fs.filter(f => f.kind === 'text')]) {
      const c = o.message.content
      if (f.kind === 'text') {
        const b = c[f.at[0]]
        const tool = tools.get(b.tool_use_id)?.name ?? null
        const full = resultText(b.content)
        const copy = keepCopy(f, { text: full, label: null })
        if (!copy.ok) continue
        const tail = textPlaceholder(charLen(full) - keepChars, tool, time, lang, copy.path)
        textTail = tail
        c[f.at[0]] = { ...b, content: shortenResult(b.content, keepChars, tail) }
        items.push({ kind: 'text', category: 'text', line: i, tool, path: tools.get(b.tool_use_id)?.path ?? null, label: null, archived: copy.path, bytes: full.length, tokens: null })
        continue
      }
      const owner = f.at.length === 2 ? c[f.at[0]] : null
      const block = owner ? owner.content[f.at[1]] : c[f.at[0]]
      const t = owner ? tools.get(owner.tool_use_id) : null
      const fp = fingerprint(block.source.data)
      // the number: matched by fingerprint (recorded by the hook); by position only if the counts agree exactly
      let label = byFp.get(fp) ?? null
      if (!label && owner) { const nos = labels.get(owner.tool_use_id) ?? []; if (nos.length === f.of) label = nos[f.nth] ?? null }
      const copy = keepCopy(f, { data: block.source.data, mediaType: block.source.media_type, label })
      if (!copy.ok) continue
      const item = {
        kind: f.kind, category: f.category, line: i, tool: owner ? (t?.name ?? 'tool') : null, path: owner ? (t?.path ?? null) : null, label,
        archived: copy.path, bytes: block.source.data.length, tokens: f.kind === 'image' ? imageTokens(imageSize(block.source.data)) : null,
      }
      const text = mediaPlaceholder({ kind: f.kind, label, tool: item.tool, path: item.path, time, fromUser: !owner, archived: copy.path }, lang)
      if (owner) owner.content[f.at[1]] = { type: 'text', text }
      else c[f.at[0]] = { type: 'text', text }
      if (!owner && f.ord >= 0) ords.push(f.ord)
      fps.add(fp)
      burnedText.set(fp, text)
      items.push(item)
    }
    if (!items.length) continue
    if (o.toolUseResult !== undefined) {
      // nothing in the message holds image data any more: empty all of the copy's; otherwise only the burned ones
      if (!hasMediaIn(o.message.content)) blankData(o.toolUseResult)
      else if (fps.size) blankData(o.toolUseResult, fps)
      if (textTail) shortenCopy(o.toolUseResult, textOver, keepChars, textTail)
    }
    const line = JSON.stringify(o)
    const why = checkLine(lines[i], line)
    if (why) { skipped.push({ line: i, reason: why }); for (const fp of fps) burnedText.delete(fp); continue }
    out[i] = line
    burned.push(...items)
    // Claude Code also saves each image attached to a message as a file and tells Claude where:
    // "[Image: source: /tmp/claude-…/<session>/images/1.png]" in the rows right after it, one per image, in order.
    // Collect the burned ones, but only if there is exactly one such line per image: otherwise which file is whose
    // can't be told for sure, and a file that belongs to an image still in use must never be deleted.
    if (ords.length) {
      const paths = []
      for (let k = i + 1; k < lines.length; k++) {
        const m = parse(lines[k])
        if (!m) continue
        if (m.type === 'assistant' || (m.type === 'user' && m.isMeta !== true)) break
        if (m.type === 'user') for (const t of textsOf(m.message?.content)) for (const x of t.matchAll(IMAGE_SOURCE_RE)) paths.push(x[1].trim())
      }
      if (paths.length === imageSlots.get(i)) for (const n of ords) tempCopies.push(paths[n])
    }
  }

  // 4. lines burned by an earlier run (or by hand) may still carry the image copy in toolUseResult
  for (const i of candidates) {
    if (byLine.has(i) || frozen.has(i)) continue
    const o = parsed.get(i) ?? parse(lines[i])
    if (!o || o.toolUseResult === undefined || hasMediaIn(o.message?.content)) continue
    const copy = structuredClone(o)
    if (!blankData(copy.toolUseResult)) continue
    const line = JSON.stringify(copy)
    if (!checkLine(lines[i], line)) out[i] = line
  }

  // 5. Claude Code 2.1.3xx also records copies of sent messages in "api-request-blob" rows (an image attached to the
  //    first message ends up there). Resuming doesn't rebuild requests from them (tested), but the image would still
  //    sit on disk: replace exactly the images burned above, also inside tool results, nothing else.
  if (burnedText.size) {
    for (let i = 0; i < out.length; i++) {
      const l = out[i]
      if (!l || frozen.has(i) || !l.includes('"api-request-blob"') || !l.includes('"base64"')) continue
      const o = parse(l)
      if (o?.type !== 'api-request-blob' || !Array.isArray(o.message?.content)) continue
      let hit = false
      const swap = (b) => {
        if (!isB64Media(b)) return b
        const text = burnedText.get(fingerprint(b.source.data))
        if (!text) return b
        hit = true
        return { type: 'text', text }
      }
      o.message.content = o.message.content.map(b => (b?.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: b.content.map(swap) } : swap(b)))
      if (!hit) continue
      const line = JSON.stringify(o)
      if (!checkLine(l, line)) out[i] = line
    }
  }

  // 6. say if image data is still sitting in a kind of record this tool doesn't edit
  //    (copies of images that are deliberately still there, unseen or kept, don't count)
  const stillThere = new Set()
  for (const i of candidates) {
    const c = parse(out[i])?.message?.content
    if (Array.isArray(c)) for (const b of c) {
      if (isB64Media(b)) stillThere.add(fingerprint(b.source.data))
      if (b?.type === 'tool_result' && Array.isArray(b.content)) for (const x of b.content) if (isB64Media(x)) stillThere.add(fingerprint(x.source.data))
    }
  }
  const elsewhere = {}
  for (const l of out) {
    if (!l || l.length < 1000) continue
    const o = parse(l)
    if (!o || o.type === 'user' || o.type === 'assistant') continue
    const n = countData(o, stillThere)
    if (n) elsewhere[o.type ?? '?'] = (elsewhere[o.type ?? '?'] ?? 0) + n
  }

  return { lines: out, burned, skipped, kept, unseen, elsewhere, tempCopies }
}

/**
 * The same lines with all image and PDF data taken out, wherever it sits (used for backups: they keep the text and
 * structure, never the media).
 * @param {string[]} lines
 */
export function withoutMedia(lines) {
  return lines.map(l => {
    if (!l || l.length < 1000) return l
    const o = parse(l)
    if (!o) return l
    let n = 0
    const visit = (x) => {
      if (Array.isArray(x)) {
        for (let k = 0; k < x.length; k++) {
          if (isB64Media(x[k])) { x[k] = { type: 'text', text: '[media not kept in backup]' }; n++ }
          else visit(x[k])
        }
        return
      }
      if (!x || typeof x !== 'object') return
      for (const k of Object.keys(x)) {
        const y = x[k]
        if (typeof y === 'string' && y.length >= 1000 && isDataKey(k, x)) { x[k] = ''; n++ }
        else if (y && typeof y === 'object') visit(y)
      }
    }
    visit(o)
    return n ? JSON.stringify(o) : l
  })
}
