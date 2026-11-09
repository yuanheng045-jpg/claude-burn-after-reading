// A stand-in for the Anthropic Messages API, so real Claude Code can be driven end to end with no account,
// no cost and no network. It records every request. Scripted replies, based on the last user message:
//   carries a tool_result        -> text reply ("seen it")
//   text contains "AGENT <task>" -> a subagent (Agent / Task tool) is sent to do <task>
//   text contains "READ <path>"  -> a Read tool call for that path
//   the /burn-after-reading:settings prompt with "user=burn" -> runs the save command it describes (Bash)
//   anything else                -> "ok"
import { createServer } from 'node:http'

export function startFakeApi() {
  const requests = []
  let n = 0
  const lastUser = (msgs) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return msgs[i]; return null }
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '')
  function decide(body) {
    const c = lastUser(body.messages || [])?.content
    if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) return { blocks: [{ type: 'text', text: 'seen it' }], stop: 'end_turn' }
    const text = textOf(c)
    const agentTool = (body.tools || []).map(t => t?.name).find(n => n === 'Agent' || n === 'Task')
    const a = /AGENT (.+)/.exec(text)
    if (a && agentTool) return { blocks: [{ type: 'tool_use', id: 'toolu_e2e' + String(++n).padStart(4, '0'), name: agentTool, input: { description: 'look at a file', prompt: a[1].trim(), subagent_type: 'general-purpose' } }], stop: 'tool_use' }
    const save = /node "([^"]+burn-after-reading\.js)" settings user=/.exec(text)
    if (save && text.includes('("user=burn")')) {   // the command's "$ARGUMENTS", filled in
      return { blocks: [{ type: 'tool_use', id: 'toolu_e2e' + String(++n).padStart(4, '0'), name: 'Bash', input: { command: `node "${save[1]}" settings user=burn`, description: 'Save the settings' } }], stop: 'tool_use' }
    }
    const m = /READ (\S+)/.exec(text)
    if (m) return { blocks: [{ type: 'tool_use', id: 'toolu_e2e' + String(++n).padStart(4, '0'), name: 'Read', input: { file_path: m[1] } }], stop: 'tool_use' }
    return { blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn' }
  }
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch {}
      const path = (req.url || '').split('?')[0]
      requests.push({ method: req.method, path, body })
      if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return }
      if (!(req.method === 'POST' && path.endsWith('/v1/messages'))) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"not_found_error","message":"fake"}}'); return }
      const r = decide(body || {}), model = body?.model || 'claude-fake'
      if (!body?.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_e2e', type: 'message', role: 'assistant', model, content: r.blocks, stop_reason: r.stop, stop_sequence: null, usage }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
      r.blocks.forEach((b, i) => {
        ev('content_block_start', { index: i, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} } })
        ev('content_block_delta', { index: i, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
        ev('content_block_stop', { index: i })
      })
      ev('message_delta', { delta: { stop_reason: r.stop, stop_sequence: null }, usage: { output_tokens: 5 } })
      ev('message_stop', {})
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    /** request bodies sent to /v1/messages, in order */
    messages: () => requests.filter(r => r.path.endsWith('/v1/messages')).map(r => r.body),
    clear: () => { requests.length = 0 },
    close: () => new Promise(r => server.close(r)),
  })))
}
