// Settings: what to do with each kind of thing, kept in <config>/burn-after-reading/settings.json.
// Changed with `/burn-after-reading:settings` in Claude Code or `burn-after-reading settings key=value` on the command line.
// Environment variables BURN_AFTER_READING_<KEY> (e.g. BURN_AFTER_READING_USER=burn) override the file.
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths.js'

export const MODES = ['keep', 'archive', 'burn']
export const DEFAULTS = Object.freeze({
  user: 'archive',      // images attached to a message: burn, but keep a copy Claude can read again
  screenshot: 'burn',   // images and PDFs from other tools: they can be taken again
  file: 'burn',         // images and PDFs read with Read: the file is still on disk
  text: 'keep',         // very long text tool results: leave them
  textOver: 20000,      // what "very long" means, in characters
  archiveDays: 30,      // archive copies are deleted after this many days
  keepLatest: 0,        // leave the newest n seen images/PDFs in place
  lang: 'en',           // placeholder language: en | zh
  labels: true,         // tell Claude each image's number when it sees it
  backup: true,         // keep text-only backups
})
// command-line / env names -> setting keys
export const KEYS = { user: 'user', screenshot: 'screenshot', file: 'file', text: 'text', 'text-over': 'textOver', 'archive-days': 'archiveDays', 'keep-latest': 'keepLatest', lang: 'lang', labels: 'labels', backup: 'backup' }

const onOff = (v) => {
  const s = String(v).toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(s)) return true
  if (['off', 'false', '0', 'no'].includes(s)) return false
  throw new Error('use on or off')
}
const whole = (min) => (v) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new Error(`use a whole number of at least ${min}`)
  return n
}
const CHECK = {
  user: (v) => { if (!MODES.includes(v)) throw new Error(`use one of ${MODES.join(', ')}`); return v },
  screenshot: (v) => CHECK.user(v), file: (v) => CHECK.user(v), text: (v) => CHECK.user(v),
  textOver: whole(1000), archiveDays: whole(1), keepLatest: whole(0),
  lang: (v) => { if (!['en', 'zh'].includes(v)) throw new Error('use en or zh'); return v },
  labels: (v) => (typeof v === 'boolean' ? v : onOff(v)), backup: (v) => (typeof v === 'boolean' ? v : onOff(v)),
}
/** A value checked and normalised for a setting key; throws with a plain message if it isn't allowed. */
export function checkValue(key, value) {
  if (!CHECK[key]) throw new Error(`unknown setting ${key}`)
  return CHECK[key](value)
}

export const settingsFile = (cfg) => join(dataDir(cfg), 'settings.json')
/** The saved settings over the defaults (anything unreadable or invalid falls back to its default). */
export function loadSettings(cfg) {
  const s = { ...DEFAULTS }
  let saved = {}
  try { saved = JSON.parse(readFileSync(settingsFile(cfg), 'utf8')) } catch { /* none yet */ }
  for (const [k, v] of Object.entries(saved ?? {})) { try { s[k] = checkValue(k, v) } catch { /* ignore a bad value */ } }
  return s
}
/** Environment variables on top (BURN_AFTER_READING_USER, …_TEXT_OVER, …_LANG, …). */
export function withEnv(s, env = process.env) {
  const out = { ...s }
  for (const [name, key] of Object.entries(KEYS)) {
    const v = env['BURN_AFTER_READING_' + name.toUpperCase().replace(/-/g, '_')]
    if (v === undefined || v === '') continue
    try { out[key] = checkValue(key, v) } catch { /* ignore a bad value */ }
  }
  if (env.BURN_AFTER_READING_KEEP !== undefined && env.BURN_AFTER_READING_KEEP !== '') { try { out.keepLatest = checkValue('keepLatest', env.BURN_AFTER_READING_KEEP) } catch {} }
  return out
}
/** Save changes (setting key -> value). Returns the new settings. */
export function saveSettings(cfg, patch, write) {
  const s = loadSettings(cfg)
  for (const [k, v] of Object.entries(patch)) s[k] = checkValue(k, v)
  mkdirSync(dataDir(cfg), { recursive: true })
  write(settingsFile(cfg), JSON.stringify(s, null, 2) + '\n')
  return s
}
