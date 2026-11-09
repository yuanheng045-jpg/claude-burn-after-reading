// Claude Code hook handler (`burn-after-reading hook`). Reads the hook event from stdin.
//   PostToolUse: if the tool returned images or PDFs, tell Claude their numbers ("This image is #7 …").
//   SessionEnd:  burn what Claude has seen in this session, so the next --resume / --continue starts without it.
// Options come from environment variables (set them in the "env" block of Claude Code's settings.json):
//   BURN_AFTER_READING_LANG=en|zh, BURN_AFTER_READING_KEEP=<n>, BURN_AFTER_READING_TEXT_OVER=<chars>,
//   BURN_AFTER_READING_LABELS=0 (no numbering), BURN_AFTER_READING_BACKUP=0 (no backup).
import { burnFile, nextLabels, logLine, configDirOf, configDir } from './transcript.js'
import { labelText, SUPPORTED_LANGS } from './text.js'
import { fingerprint } from './burn.js'

export function optionsFromEnv(env = process.env) {
  const n = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : undefined)
  const lang = SUPPORTED_LANGS.includes(env.BURN_AFTER_READING_LANG) ? env.BURN_AFTER_READING_LANG : 'en'
  return { lang, keep: n(env.BURN_AFTER_READING_KEEP) ?? 0, textOver: n(env.BURN_AFTER_READING_TEXT_OVER) ?? 0, backup: env.BURN_AFTER_READING_BACKUP !== '0', labels: env.BURN_AFTER_READING_LABELS !== '0' }
}

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
  const opts = optionsFromEnv(env)
  const event = input?.hook_event_name
  const cfg = typeof input?.transcript_path === 'string' ? configDirOf(input.transcript_path) : configDir()
  if (event === 'PostToolUse') {
    if (!opts.labels || !input.session_id) return ''
    const items = mediaItems(input.tool_response)
    if (!items.length) return ''
    const nos = nextLabels(input.session_id, items.map(i => i.fp), cfg)
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: labelText(nos, opts.lang, items.map(i => i.kind)) } })
  }
  if (event === 'SessionEnd') {
    const file = input.transcript_path
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return ''
    const r = burnFile(file, { ...opts, hookMode: true })
    const what = r.refused ? `not burned: ${r.refused}` : `${r.burned.length} burned, ${r.skipped.length} skipped, ${r.bytesBefore} -> ${r.bytesAfter} bytes`
    logLine(`SessionEnd ${r.sessionId} (${input.reason ?? ''}): ${what}`, cfg)
    return ''
  }
  return ''
}
