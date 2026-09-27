import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldSurface, deriveEventMessage } from '../deepseek-harness/packages/core/session/lib/types/surface.js'
import { currentSessionMessageProjections } from '../deepseek-harness/packages/session/session-format-catalog/lib/types/message-projections.js'
import { scanZstdFrames, createZstdFrameDecoder } from '../deepseek-harness/packages/session/session-persistence-jsonl/lib/types/zstd.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions'))
const port = Number(process.env.DSH_TRACE_PORT ?? 3091)
const token = process.env.DSH_TRACE_TOKEN ?? randomBytes(24).toString('base64url')
const dshWebOrigin = process.env.DSH_WEB_ORIGIN ?? 'http://127.0.0.1:3080'
const cache = new Map()

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(JSON.stringify(value))
}

async function sessionFiles() {
  const found = new Map()
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const directory = join(root, project.name, session.name)
      const files = await readdir(directory)
      const candidate = files.flatMap(name => {
        const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/u.exec(name)
        return match === null ? [] : [{ name, version: Number(match[1]), compressed: Boolean(match[2]) }]
      }).sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))[0]
      if (candidate === undefined) continue
      found.set(session.name, join(directory, candidate.name))
    }
  }
  return found
}

async function decodeLog(path) {
  const bytes = await readFile(path)
  let content
  if (path.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(bytes)
    const decoder = createZstdFrameDecoder()
    try {
      const parts = []
      for (const frame of decoder.decode(bytes, frames)) parts.push(frame.toString('utf8'))
      content = parts.join('')
    } finally {
      decoder.close()
    }
  } else {
    content = bytes.toString('utf8')
  }
  const rows = content.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const [header, ...events] = rows
  if (header?.type !== 'session' || !Number.isInteger(header.version)) {
    throw new Error('会话文件缺少有效 header')
  }
  if (header.version !== 4) throw new Error(`暂不支持 Session 格式 v${header.version}`)
  for (const [index, event] of events.entries()) {
    if (event.seq !== index) throw new Error(`Event 序号不连续：期望 ${index}，收到 ${event.seq}`)
  }
  return { header, events }
}

async function loadSession(path) {
  const info = await stat(path)
  const revision = `${info.size}-${info.mtimeMs}`
  const cached = cache.get(path)
  if (cached?.revision === revision) return cached.value
  const value = await decodeLog(path)
  cache.set(path, { revision, value })
  return value
}

function messageHistory(events, settlementIndex) {
  const prefix = events.slice(0, settlementIndex)
  const folded = foldSurface(prefix, currentSessionMessageProjections)
  return folded.nodes.flatMap(seq => {
    const event = prefix[seq]
    const message = event === undefined ? null : deriveEventMessage(event, folded.projectedMessages)
    return message === null ? [] : [{ seq, eventType: event.type, message }]
  })
}

function requestAt(events, index) {
  const event = events[index]
  const prefix = events.slice(0, index)
  const header = prefix.findLast(row => row.type === 'request/header')
  const context = prefix.findLast(row => row.type === 'request/context')
  try {
    return {
      seq: event.seq,
      type: event.type,
      time: event.time,
      header: header?.data?.header ?? null,
      requestContext: context?.data ?? null,
      messages: messageHistory(events, index),
      stream: event.data?.stream ?? [],
      response: event.type === 'assistant/message' ? event.data.message : null,
      usage: event.data?.usage ?? null,
    }
  } catch (error) {
    return {
      seq: event.seq, type: event.type, time: event.time,
      error: error instanceof Error ? error.message : String(error),
      stream: event.data?.stream ?? [],
      response: event.type === 'assistant/message' ? event.data.message : null,
    }
  }
}

function buildSteps(events) {
  const steps = []
  let active = null
  for (const [index, event] of events.entries()) {
    if (event.type === 'step/start') {
      active = {
        key: `${event.data.turn}-${event.data.step}`,
        turn: event.data.turn,
        step: event.data.step,
        startSeq: event.seq,
        endSeq: null,
        startTime: event.time,
        endTime: null,
        requests: [],
        tools: [],
        children: [],
        eventSeqs: [],
      }
      steps.push(active)
    }
    if (active === null) continue
    active.eventSeqs.push(event.seq)
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      active.requests.push(requestAt(events, index))
    }
    if (event.type === 'tool/call') {
      active.tools.push({
        seq: event.seq,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
        result: null,
        resultSeq: null,
        error: null,
      })
    }
    if (event.type === 'tool/result') {
      const call = active.tools.findLast(tool => tool.callId === String(event.data.message.toolCallId))
      if (call !== undefined) {
        call.result = event.data.message
        call.resultSeq = event.seq
        call.error = event.data.error ?? null
      }
    }
    if (event.type === 'subagent/catalog') {
      active.children.push({ seq: event.seq, ...event.data })
    }
    if (event.type === 'step/end') {
      active.endSeq = event.seq
      active.endTime = event.time
      active = null
    }
  }
  return steps
}

async function listSessions(files) {
  const summaries = await Promise.all([...files.entries()].map(async ([id, path]) => {
    try {
      const { header, events } = await loadSession(path)
      const title = events.filter(event => event.type === 'session/title').at(-1)?.data?.title
        ?? events.find(event => event.type === 'user/message')?.data?.content?.find(block => block.type === 'text')?.text?.slice(0, 60)
        ?? id
      return {
        id, title, cwd: header.cwd ?? '', createdAt: header.createdAt,
        parentSession: header.parentSession ?? null,
        isSeeded: header.isSeeded ?? false,
        eventCount: events.length,
        lastTime: events.at(-1)?.time ?? header.createdAt,
      }
    } catch (error) {
      return { id, title: id, error: error instanceof Error ? error.message : String(error) }
    }
  }))
  return summaries.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0))
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/app.js' || url.pathname === '/style.css') {
      const name = url.pathname.slice(1)
      const content = await readFile(join(here, name))
      response.writeHead(200, {
        'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      })
      response.end(content)
      return
    }
    if (url.pathname === '/api/launch-info') {
      if (request.headers.origin !== dshWebOrigin) {
        json(response, 403, { error: '不允许的页面来源' })
        return
      }
      json(response, 200, { url: `http://127.0.0.1:${port}/?token=${token}` }, {
        'access-control-allow-origin': dshWebOrigin,
        'vary': 'Origin',
      })
      return
    }
    if (url.searchParams.get('token') !== token) {
      json(response, 401, { error: '需要本地访问令牌' })
      return
    }
    if (url.pathname === '/') {
      const content = await readFile(join(here, 'index.html'))
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
      })
      response.end(content)
      return
    }
    const files = await sessionFiles()
    if (url.pathname === '/api/sessions') {
      json(response, 200, { sessions: await listSessions(files) })
      return
    }
    if (url.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/session/'.length))
      const path = files.get(id)
      if (path === undefined) {
        json(response, 404, { error: '会话不存在' })
        return
      }
      const { header, events } = await loadSession(path)
      json(response, 200, {
        header,
        events,
        steps: buildSteps(events),
        title: events.filter(event => event.type === 'session/title').at(-1)?.data?.title ?? id,
        loadedAt: Date.now(),
      })
      return
    }
    json(response, 404, { error: '路径不存在' })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`DSH 轨迹分析器：http://127.0.0.1:${port}/?token=${token}\n`)
  process.stdout.write(`只读日志目录：${root}\n`)
})
