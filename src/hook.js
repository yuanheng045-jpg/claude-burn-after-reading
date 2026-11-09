// Claude Code hook handler (`burn-after-reading hook`). Reads the hook event from stdin.
//   PostToolUse: if the tool returned images or PDFs, tell Claude their numbers ("This image is #7 …").
//   SessionEnd:  burn what Claude has seen in this session, so the next --resume / --continue starts without it.
// What it does follows the settings (`/burn-after-reading:settings`, or <config>/burn-after-reading/settings.json).
import { burnSession, nextLabels, logLine, resolveOptions } from './transcript.js'
import { configDirOf, configDir } from './paths.js'
import { labelText } from './text.js'
import { fingerprint } from './burn.js'

/**
 * The images/PDFs a tool returned, in order: kind and a fingerprint of the data (Read's {type:'image'|'pdf',
 * file:{base64}}, MCP content blocks {type:'image', data}, API-style blocks {type:'image', source:{data}}).
 */
export function mediaItems(v) {
  const items = []
  const visit = (x, depth) => {
    if (depth > 8 || !x || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach(y => visit(y, depth + 1)); return }
    if (['image', 'document', 'pdf'].includes(x.type) && (x.file || x.source || typeof x.data === 'string')) {
      const data = x.file?.base64 ?? x.source?.data ?? x.data
      items.push({ kind: x.type === 'image' ? 'image' : 'pdf', fp: typeof data === 'string' && data ? fingerprint(data) : null })
      return
    }
    for (const y of Object.values(x)) if (y && typeof y === 'object') visit(y, depth + 1)
  }
  visit(v, 0)
  return items
}
export const countMedia = (v) => mediaItems(v).length

/**
 * @param {any} input the hook event JSON
 * @returns {string} what to print on stdout ('' for nothing)
 */
export function runHook(input, env = process.env) {
  const event = input?.hook_event_name
  const cfg = typeof input?.transcript_path === 'string' ? configDirOf(input.transcript_path) : configDir()
  if (event === 'PostToolUse') {
    const o = resolveOptions(cfg, {}, env)
    if (!o.labels || !input.session_id) return ''
    // set to keep: it stays in the conversation, so there is nothing to tell Claude
    if (o.modes[input.tool_name === 'Read' ? 'file' : 'screenshot'] === 'keep') return ''
    const items = mediaItems(input.tool_response)
    if (!items.length) return ''
    const nos = nextLabels(input.session_id, items.map(i => i.fp), cfg)
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: labelText(nos, o.lang, items.map(i => i.kind)) } })
  }
  if (event === 'SessionEnd') {
    const file = input.transcript_path
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return ''
    const r = burnSession(file, { hookMode: true, env })
    const all = [r, ...r.subagents]
    const burned = all.flatMap(x => x.burned), skipped = all.reduce((n, x) => n + x.skipped.length, 0)
    const archived = burned.filter(b => b.archived).length
    const inSubs = r.subagents.reduce((n, x) => n + x.burned.length, 0)
    const errors = r.subagents.filter(x => x.error).map(x => `${x.agent}: ${x.error}`)
    const what = r.refused ? `not burned: ${r.refused}`
      : `${burned.length} burned${archived ? ` (${archived} archived)` : ''}${inSubs ? `, ${inSubs} of them in subagents` : ''}, ${skipped} skipped, ${r.bytesBefore} -> ${r.bytesAfter} bytes${errors.length ? `; errors: ${errors.join('; ')}` : ''}`
    logLine(`SessionEnd ${r.sessionId} (${input.reason ?? ''}): ${what}`, cfg)
    return ''
  }
  return ''
}
