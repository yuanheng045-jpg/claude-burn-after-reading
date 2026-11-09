// End to end with the real Claude Code CLI, talking to a local fake API (no account, no cost, no network).
// Runs when Claude Code is installed: set CLAUDE_BIN, or have `claude` on PATH. Otherwise every test is skipped.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startFakeApi } from './fake-api.js'
import { pngBase64 } from '../helpers.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BIN = join(REPO, 'bin', 'burn-after-reading.js')
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null } catch { return null }
}
const CLAUDE = findClaude()
const skip = CLAUDE ? false : 'Claude Code not installed (set CLAUDE_BIN to run these)'
const B64_START = 'iVBORw0KGgo'

let api, home, proj
before(async () => {
  if (skip) return
  api = await startFakeApi()
  home = mkdtempSync(join(tmpdir(), 'bar-e2e-home-'))
  proj = mkdtempSync(join(tmpdir(), 'bar-e2e-proj-'))
  writeFileSync(join(proj, 'shot.png'), Buffer.from(pngBase64(64, 64), 'base64'))
})
after(async () => { if (api) await api.close() })

// async on purpose: the fake API lives in this process, a blocking spawn would freeze it
function claude(args, extraEnv = {}, stdin = null) {
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ANTHROPIC_API_KEY: 'sk-ant-api03-fake-key-for-local-tests', ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    // anything that does not go to the fake API goes nowhere
    HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_MAX_RETRIES: '0',
    ...extraEnv,
  }
  return new Promise((resolve, reject) => {
    const output = stdin ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']
    const p = spawn(CLAUDE, ['-p', ...args, ...output, '--max-turns', '3', '--allowedTools', 'Read'], { cwd: proj, env })
    if (stdin) p.stdin.end(stdin); else p.stdin.end()
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => p.kill('SIGKILL'), 120_000)
    p.on('error', reject)
    p.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(new Error(`claude exited ${code}: ${err}\n${out}`))
    })
  })
}
const transcriptOf = (sid) => {
  const root = join(home, '.claude', 'projects')
  for (const d of readdirSync(root)) { const f = join(root, d, sid + '.jsonl'); if (existsSync(f)) return f }
  throw new Error('no transcript for ' + sid)
}
const hookCmd = `"${process.execPath}" "${BIN}" hook`
const hookSettings = JSON.stringify({ hooks: {
  PostToolUse: [{ matcher: 'Read|mcp__.*', hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: hookCmd, timeout: 30 }] }],
} })
const lastRequestText = () => JSON.stringify(api.messages().at(-1))

test('burned with the CLI, a resumed session sends the placeholder instead of the image', { skip }, async () => {
  const sid = randomUUID()
  api.clear()
  await claude([`READ ${join(proj, 'shot.png')}`, '--session-id', sid])
  assert.ok(lastRequestText().includes(B64_START), 'Claude saw the image in the first run')
  const file = transcriptOf(sid)
  const r = spawnSync(process.execPath, [BIN, file, '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude') } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).burned.length, 1)
  assert.ok(!readFileSync(file, 'utf8').includes(B64_START))
  api.clear()
  await claude(['hello again', '--resume', sid])
  const sent = lastRequestText()
  assert.ok(!sent.includes(B64_START), 'the image is gone from the resumed request')
  assert.ok(sent.includes('image burned after reading · Read'), 'the placeholder is there instead')
})

test('with the hooks: Claude is told the image number, the session end burns it, the number stays', { skip }, async () => {
  const sid = randomUUID()
  api.clear()
  await claude([`READ ${join(proj, 'shot.png')}`, '--session-id', sid, '--settings', hookSettings])
  assert.match(lastRequestText(), /This image is #1\./, 'the label reached Claude next to the tool result')
  const text = readFileSync(transcriptOf(sid), 'utf8')
  assert.ok(!text.includes(B64_START), 'burned when the session ended')
  assert.ok(text.includes('image #1 burned after reading'))
  api.clear()
  await claude(['hello again', '--resume', sid, '--settings', hookSettings])
  const sent = lastRequestText()
  assert.ok(!sent.includes(B64_START))
  assert.ok(sent.includes('image #1 burned after reading'))
})

test('as a plugin installed from this folder', { skip }, async (t) => {
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), DISABLE_AUTOUPDATER: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }
  const add = spawnSync(CLAUDE, ['plugin', 'marketplace', 'add', REPO], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 })
  if (add.status !== 0 && /unknown command|not a valid command/i.test(add.stderr + add.stdout)) return t.skip('this Claude Code has no plugin command')
  assert.equal(add.status, 0, add.stderr + add.stdout)
  const inst = spawnSync(CLAUDE, ['plugin', 'install', 'burn-after-reading@burn-after-reading'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 })
  assert.equal(inst.status, 0, inst.stderr + inst.stdout)
  const sid = randomUUID()
  api.clear()
  await claude([`READ ${join(proj, 'shot.png')}`, '--session-id', sid])
  assert.match(lastRequestText(), /This image is #1\./)
  assert.ok(!readFileSync(transcriptOf(sid), 'utf8').includes(B64_START))
})

test('an image sent along with the message (stream-json, the way SDK apps send it) is burned too', { skip }, async () => {
  const sid = randomUUID()
  const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'what is in this picture?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64(64, 64) } }] } })
  api.clear()
  await claude(['--session-id', sid, '--settings', hookSettings], {}, msg + '\n')
  assert.ok(JSON.stringify(api.messages()).includes(B64_START), 'Claude saw the image')
  const text = readFileSync(transcriptOf(sid), 'utf8')
  assert.ok(!text.includes(B64_START), 'burned when the session ended')
  assert.ok(text.includes('image burned after reading · attached by the user'))
  api.clear()
  await claude(['hello again', '--resume', sid])
  assert.ok(!lastRequestText().includes(B64_START))
  assert.ok(lastRequestText().includes('what is in this picture?'), 'her words are still there')
})

test('a PDF Claude read is burned', { skip }, async (t) => {
  writeFileSync(join(proj, 'note.pdf'), tinyPdf('burn after reading'))
  const sid = randomUUID()
  api.clear()
  await claude([`READ ${join(proj, 'note.pdf')}`, '--session-id', sid, '--settings', hookSettings])
  const seen = JSON.stringify(api.messages())
  if (!seen.includes('"type":"document"')) return t.skip('this Claude Code sends PDFs as text, not as a document block')
  const text = readFileSync(transcriptOf(sid), 'utf8')
  assert.match(text, /PDF #\d+ burned after reading · Read /)
  assert.match(JSON.stringify(api.messages()), /This PDF is #\d+\./, 'Claude was told the PDF number')
  assert.ok(!/"type":"document","source":\{"type":"base64","media_type":"application\/pdf","data":"[A-Za-z0-9+/]{100}/.test(text))
})

/** A small valid one-page PDF with a line of text. */
function tinyPdf(line) {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>']
  const stream = `BT /F1 18 Tf 30 100 Td (${line}) Tj ET`
  objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
