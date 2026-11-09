// Everything Claude (or the user) reads from this tool: placeholders left in the transcript and the image labels.
// Placeholders are read by Claude when the session is resumed, so they say what was there and how to get it back.

const pad = (n) => String(n).padStart(2, '0')
/** Local wall-clock time of a transcript timestamp, "YYYY-MM-DD HH:MM", or '' if missing. */
export function localTime(iso) {
  const d = new Date(iso ?? '')
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const LANGS = {
  en: {
    image: 'image', pdf: 'PDF',
    burned: 'burned after reading',
    fromUser: 'attached by the user',
    again: { Read: 'read the file again if you need it', tool: 'call the tool again if you need it', user: 'ask for it again if you need it' },
    archived: (p) => `a copy is kept at ${p}, read it if you need it`,
    textCut: (n) => `${n.toLocaleString('en-US')} more characters burned after reading`,
    label: (nos, noun) => nos.length === 1
      ? `[burn-after-reading] This ${noun.one} is #${nos[0]}. After this turn it is removed from the conversation and only "${noun.one} #${nos[0]}" stays here, so if you will want to remember what it shows, say it in your reply.`
      : `[burn-after-reading] These ${noun.many} are ${nos.map(n => '#' + n).join(', ')}. After this turn they are removed from the conversation and only their numbers stay here, so if you will want to remember what they show, say it in your reply.`,
    nouns: { image: { one: 'image', many: 'images' }, pdf: { one: 'PDF', many: 'PDFs' }, mixed: { one: 'file', many: 'files' } },
  },
  zh: {
    image: '图', pdf: 'PDF',
    burned: '已阅后即焚',
    fromUser: '用户发来的',
    again: { Read: '要再看就重新读这个文件', tool: '要再看就重新调一次工具', user: '要再看请用户再发一次' },
    archived: (p) => `存档在 ${p}，要再看就读这个文件`,
    textCut: (n) => `后面 ${n} 个字已阅后即焚`,
    label: (nos, noun) => nos.length === 1
      ? `[burn-after-reading] 这${noun.one}是 #${nos[0]}。这一轮之后它会从对话里拿掉，这里只留"${noun.short} #${nos[0]}"；之后还想记得里面是什么，就在回复里说一句。`
      : `[burn-after-reading] 这几${noun.unit}是 ${nos.map(n => '#' + n).join('、')}。这一轮之后它们会从对话里拿掉，这里只留编号；之后还想记得里面是什么，就在回复里说一句。`,
    nouns: { image: { one: '张图', unit: '张图', short: '图' }, pdf: { one: '份 PDF ', unit: '份 PDF ', short: 'PDF' }, mixed: { one: '个文件', unit: '个文件', short: '文件' } },
  },
}
export const SUPPORTED_LANGS = Object.keys(LANGS)
const L = (lang) => LANGS[lang] ?? LANGS.en

/**
 * The text that takes the place of one burned image or PDF.
 * @param {{ kind: 'image'|'pdf', label?: string|null, tool?: string|null, path?: string|null, time?: string, fromUser?: boolean, archived?: string|null }} it
 * @param {string} lang
 */
export function mediaPlaceholder(it, lang = 'en') {
  const t = L(lang)
  const what = (it.kind === 'pdf' ? t.pdf : t.image) + (it.label ? ` #${it.label}` : '')
  const parts = [`${what} ${t.burned}`]
  if (it.fromUser) parts.push(t.fromUser)
  else if (it.tool) parts.push(it.path ? `${it.tool} ${it.path}` : it.tool)
  if (it.time) parts.push(it.time)
  parts.push(it.archived ? t.archived(it.archived) : it.fromUser ? t.again.user : it.tool === 'Read' ? t.again.Read : t.again.tool)
  return lang === 'zh' ? `〔${parts.join(' · ')}〕` : `[${parts.join(' · ')}]`
}

/** The tail added after the kept start of a long text tool result. */
export function textPlaceholder(cut, tool, time, lang = 'en', archived = null) {
  const t = L(lang)
  const parts = [t.textCut(cut)]
  if (tool) parts.push(tool)
  if (time) parts.push(time)
  parts.push(archived ? t.archived(archived) : tool === 'Read' ? t.again.Read : t.again.tool)
  return lang === 'zh' ? `〔${parts.join(' · ')}〕` : `[${parts.join(' · ')}]`
}

/** The note a PostToolUse hook adds next to a tool result that carries images or PDFs. `kinds`: 'image' | 'pdf' per item. */
export function labelText(nos, lang = 'en', kinds = []) {
  const t = L(lang)
  const k = kinds.length && kinds.every(x => x === 'pdf') ? 'pdf' : kinds.some(x => x === 'pdf') ? 'mixed' : 'image'
  return t.label(nos, t.nouns[k])
}

// Numbers are read back from the transcript (the hook's note is saved there next to the tool call it belongs to).
const LABEL_RE = /^\[burn-after-reading\][^.。]*/
export function parseLabel(text) {
  if (typeof text !== 'string') return []
  const m = LABEL_RE.exec(text)
  return m ? [...m[0].matchAll(/#(\d+)/g)].map(x => x[1]) : []
}

// Every text this tool inserts starts with one of these, so a later run can tell its own placeholders apart.
export function isOurPlaceholder(text) {
  if (typeof text !== 'string') return false
  return Object.values(LANGS).some(t => text.includes(t.burned))
}
const KIND_RES = Object.values(LANGS).flatMap(t => ['image', 'pdf'].map(k => [k, new RegExp(`^[\\[〔]${t[k]}( #\\d+)? ${t.burned} · `)]))
/** 'image' or 'pdf' if `text` is the placeholder of a burned image or PDF, else null. */
export function placeholderKind(text) {
  if (typeof text !== 'string') return null
  for (const [k, re] of KIND_RES) if (re.test(text)) return k
  return null
}
