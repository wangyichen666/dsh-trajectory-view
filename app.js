import { GraphUi } from './graph-ui.mjs'

const token = new URL(location.href).searchParams.get('token')
const content = document.querySelector('#content')
const sessionSelect = document.querySelector('#sessionSelect')
const sessionSummary = document.querySelector('#sessionSummary')
const liveStatus = document.querySelector('#liveStatus')
const tabs = document.querySelectorAll('.nav button')

const state = {
  sessions: [],
  sessionId: new URL(location.href).searchParams.get('session'),
  data: null,
  signature: '',
  requestDetails: new Map(),
  requestErrors: new Map(),
  pendingRequests: new Map(),
  tab: 'overview',
  eventSeq: null,
  stepKey: null,
  attemptIndex: null,
  eventQuery: '',
  eventType: 'all',
  error: null,
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

function fmtTime(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function fmtClock(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
}

function fmtDuration(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '进行中'
  const ms = Math.max(0, end - start)
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

function short(value, limit = 94) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function pretty(value) {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function codeBox(value, maxHeight) {
  const text = typeof value === 'string' ? value : pretty(value)
  return `<div class="codebox"><button class="copy" type="button" data-copy="${escapeHtml(encodeURIComponent(text))}">复制</button><pre${maxHeight ? ` style="max-height:${maxHeight}px"` : ''}>${escapeHtml(text)}</pre></div>`
}

function textOf(message) {
  return (message?.content ?? []).filter(block => typeof block.text === 'string').map(block => block.text).join('\n')
}

function heading(eyebrow, title, subtitle, tools = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p class="subhead">${escapeHtml(subtitle)}</p></div>${tools ? `<div class="page-tools">${tools}</div>` : ''}</div>`
}

function stepTitle(step) {
  return `第 ${step.turn} 轮 · 第 ${step.step} 步`
}

function stepPreview(step) {
  const reply = step.requests.findLast(request => request.response !== null)?.response
  const message = textOf(reply)
  return short(message || step.tools.map(tool => tool.name).join('、') || '等待模型输出', 75)
}

function stepForEvent(seq) {
  return state.data?.steps.find(step => seq >= step.startSeq && seq <= (step.endSeq ?? Number.MAX_SAFE_INTEGER))
}

function setTab(tab) {
  state.tab = tab
  for (const button of tabs) button.classList.toggle('active', button.dataset.tab === tab)
  renderContent()
  if (tab === 'steps') ensureSelectedRequestDetail()
  if (tab === 'graph') graphUi.loadSelectedRequest()
  content.scrollTop = 0
  window.scrollTo({ top: 0, behavior: 'instant' })
}

function renderSummary() {
  const data = state.data
  if (data === null) {
    sessionSummary.innerHTML = '<strong>选择一个会话</strong><p>读取本机 DSH Session 日志。</p>'
    return
  }
  const parent = data.header.parentSession ? `<p>父会话：${escapeHtml(data.header.parentSession)}</p>` : ''
  const seed = data.header.parentSession
    ? `<p>父上下文：${data.header.isSeeded ? '继承已完成轮次前缀' : '独立会话'}</p>` : ''
  sessionSummary.innerHTML = `<strong>${escapeHtml(data.title)}</strong><p>${escapeHtml(short(data.header.cwd ?? '未知工作区', 80))}</p><p>${fmtTime(data.header.createdAt)}</p>${parent}${seed}`
}

function renderOverview() {
  const { events, steps, header } = state.data
  const counts = new Map()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  const tools = steps.flatMap(step => step.tools)
  const children = events.filter(event => event.type === 'subagent/catalog')
  const responses = events.filter(event => event.type === 'assistant/message')
  const topTypes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const maxCount = topTypes[0]?.[1] ?? 1
  return `${heading('SESSION OVERVIEW', state.data.title, `Session ${header.id} · ${header.cwd ?? '未知工作区'}`)}
    <div class="metric-grid">
      <div class="metric"><span>Event 总数</span><strong>${events.length}</strong><small>包含全部持久化事件</small></div>
      <div class="metric"><span>模型步骤</span><strong>${steps.length}</strong><small>${responses.length} 条已组装助手消息</small></div>
      <div class="metric"><span>工具执行</span><strong>${tools.length}</strong><small>${new Set(tools.map(tool => tool.name)).size} 种工具</small></div>
      <div class="metric"><span>子 Agent</span><strong>${children.length}</strong><small>父会话目录记录</small></div>
    </div>
    <div class="notice">Session 日志保存的是送给模型适配器的逻辑消息、适配器标准化后的响应流和组装结果。历史提供方 HTTP 请求体及原始 SSE 帧未被记录，页面不会把推断内容标成原始报文。</div>
    <div class="split" style="margin-top:17px">
      <section class="panel"><div class="panel-head"><h2>步骤概览</h2><span>点击进入 LLM 往返</span></div><div class="step-list">${steps.map(step => `
        <button class="step-row" type="button" data-step="${escapeHtml(step.key)}"><span class="step-number">${step.step}</span><span class="step-main"><strong>${escapeHtml(stepTitle(step))}</strong><small>${escapeHtml(stepPreview(step))}</small></span><span class="step-time">${escapeHtml(fmtDuration(step.startTime, step.endTime))}</span></button>`).join('')}</div></section>
      <section class="panel"><div class="panel-head"><h2>Event 类型分布</h2><span>${counts.size} 类</span></div><div class="panel-body event-type-list">${topTypes.map(([type, count]) => `<div class="type-row"><i class="legend-dot" style="background:${typeColor(type)}"></i><div>${escapeHtml(type)}<div class="bar-track"><i style="width:${Math.max(4, 100 * count / maxCount)}%;background:${typeColor(type)}"></i></div></div><strong>${count}</strong></div>`).join('')}</div></section>
    </div>
    ${children.length === 0 ? '' : `<section class="panel" style="margin-top:17px"><div class="panel-head"><h2>子 Agent 目录</h2><span>${children.length} 个</span></div><div class="panel-body">${children.map(event => { const child = state.sessions.find(session => session.id === event.data.childId); return `<div class="notice" style="margin-bottom:8px"><span class="tag subagent">${escapeHtml(event.data.mode)}</span> <strong>${escapeHtml(event.data.label ?? event.data.childId)}</strong><p>ID：${escapeHtml(event.data.childId)} · Event #${event.seq} · ${child ? `继承父历史：${child.isSeeded ? '是' : '否'}` : '子会话日志尚不可用'}</p>${child ? `<button type="button" class="ghost-button" data-session="${escapeHtml(child.id)}">打开子会话 ↗</button>` : ''}</div>` }).join('')}</div></section>`}`
}

function typeColor(type) {
  if (type.startsWith('assistant/') || type.startsWith('request/')) return '#b393e9'
  if (type.startsWith('tool/')) return '#eda35f'
  if (type.startsWith('subagent/')) return '#56d7a6'
  if (type.startsWith('step/') || type.startsWith('turn/')) return '#76a6f1'
  return '#8093b1'
}

function filteredEvents() {
  const query = state.eventQuery.toLowerCase()
  return state.data.events.filter(event => {
    if (state.eventType !== 'all' && event.type !== state.eventType) return false
    if (!query) return true
    return `${event.seq} ${event.type} ${JSON.stringify(event.data)}`.toLowerCase().includes(query)
  })
}

function eventRows() {
  const events = filteredEvents()
  return events.length === 0 ? '<div class="empty">没有匹配的 Event</div>' : events.map(event => `
    <button class="event-row ${event.seq === state.eventSeq ? 'selected' : ''}" type="button" data-event="${event.seq}"><span class="event-seq">#${event.seq}</span><i class="legend-dot" style="background:${typeColor(event.type)}"></i><span class="event-type">${escapeHtml(event.type)}</span><time>${escapeHtml(fmtClock(event.time))}</time></button>`).join('')
}

function eventDetail() {
  const event = state.data.events.find(row => row.seq === state.eventSeq)
  if (event === undefined) return '<div class="empty">从左侧选择一个 Event。</div>'
  const step = stepForEvent(event.seq)
  const stepButton = step === undefined ? '无关联步骤' : `<button type="button" class="ghost-button" data-step="${escapeHtml(step.key)}">${escapeHtml(stepTitle(step))} ↗</button>`
  return `<div class="panel-head"><h2>Event #${event.seq}</h2><span class="tag" style="border-color:${typeColor(event.type)};color:${typeColor(event.type)}">${escapeHtml(event.type)}</span></div>
    <div class="panel-body detail-scroll"><dl class="meta-list"><dt>类型</dt><dd>${escapeHtml(event.type)}</dd><dt>序号</dt><dd>#${event.seq}</dd><dt>时间</dt><dd>${escapeHtml(fmtTime(event.time))}</dd><dt>关联步骤</dt><dd>${stepButton}</dd><dt>Surface 操作</dt><dd>${escapeHtml(typeof event.surfaceOp === 'string' ? event.surfaceOp : event.surfaceOp ? pretty(event.surfaceOp) : '无')}</dd></dl>
    <div class="section-title"><h2>完整 Event JSON</h2><small>持久化原始字段</small></div>${codeBox(event)}
    ${event.type === 'assistant/message' || event.type === 'assistant/attempt' ? `<div class="notice" style="margin-top:13px">stream 是 DSH 适配器的标准化流，可能包含批量压缩的增量片段。打开“LLM 往返”可与本次请求的上下文和组装结果并排查看。</div>` : ''}</div>`
}

function renderEvents() {
  const types = [...new Set(state.data.events.map(event => event.type))].sort()
  return `${heading('EVENT INSPECTOR', '逐 Event 检查', '每条 Event 保留完整字段、序号与时间戳。搜索同时覆盖类型和数据内容。')}
    <div class="toolbar"><input id="eventSearch" class="search" type="search" placeholder="搜索序号、类型或 Event 内容" value="${escapeHtml(state.eventQuery)}"><select id="eventTypeFilter" class="filter" aria-label="筛选 Event 类型"><option value="all">全部类型</option>${types.map(type => `<option value="${escapeHtml(type)}" ${state.eventType === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}</select><span id="eventCount" class="tag">${filteredEvents().length} / ${state.data.events.length}</span></div>
    <div class="browser-layout"><section class="panel"><div class="panel-head"><h2>事件时间线</h2><span>按日志顺序</span></div><div id="eventList" class="event-list">${eventRows()}</div></section><section id="eventDetail" class="panel">${eventDetail()}</section></div>`
}

function renderStepRail() {
  return `<div class="panel step-rail"><div class="panel-head"><h2>步骤</h2><span>${state.data.steps.length}</span></div><div class="step-list">${state.data.steps.map(step => `
    <button class="step-row ${step.key === state.stepKey ? 'selected' : ''}" type="button" data-step="${escapeHtml(step.key)}"><span class="step-number">${step.step}</span><span class="step-main"><strong>${escapeHtml(stepTitle(step))}</strong><small>${step.requests.length} 次模型尝试 · ${step.tools.length} 个工具</small></span></button>`).join('')}</div></div>`
}

function messageCards(messages) {
  if (messages?.length === 0) return '<div class="empty">本次模型请求没有有序消息。</div>'
  return (messages ?? []).map((item, index) => {
    const preview = short(textOf(item.message) || item.message.content?.map(block => block.type).join('、') || '', 90)
    return `<details ${index === 0 ? 'open' : ''}><summary><span class="tag ${item.message.role === 'assistant' ? 'model' : ''}">${escapeHtml(item.message.role)}</span><span>#${item.seq}</span><span class="summary-muted">${escapeHtml(preview)}</span></summary><div class="detail-inner">${textOf(item.message) ? `<div class="text-preview">${escapeHtml(textOf(item.message))}</div>` : ''}${codeBox(item.message, 390)}</div></details>`
  }).join('')
}

function streamSummary(frame) {
  const chunk = frame.chunk
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return short(chunk.text, 80)
  if (chunk?.type === 'tool-call-delta') return short(`${chunk.name ?? ''} ${chunk.argumentsDelta ?? ''}`, 80)
  if (frame.type === 'text-chunks' || frame.type === 'reasoning-chunks') return short((frame.texts ?? []).join(''), 80)
  return short(pretty(chunk ?? frame), 80)
}

function streamCards(stream) {
  if (!Array.isArray(stream) || stream.length === 0) return '<div class="empty">本次尝试没有持久化流片段。</div>'
  return `<div class="stream-list">${stream.map((frame, index) => `<div class="stream-item"><span>#${index + 1}</span> <strong>${escapeHtml(frame.chunk?.type ?? frame.type ?? 'chunk')}</strong> · ${escapeHtml(fmtClock(frame.time ?? frame.time0))}<br>${escapeHtml(streamSummary(frame))}</div>`).join('')}</div>`
}

function renderStepDetail(step) {
  const index = Math.min(state.attemptIndex ?? step.requests.length - 1, step.requests.length - 1)
  const summary = step.requests[index]
  const request = summary === undefined ? undefined : (state.requestDetails.get(summary.seq) ?? summary)
  const ready = Array.isArray(request?.messages)
  const requestError = summary === undefined ? null : state.requestErrors.get(summary.seq)
  const provider = request?.provider ?? request?.header?.config?.provider ?? '未知'
  const model = request?.model ?? request?.header?.config?.model ?? '未知'
  const contextNotice = '请求消息按该次响应前的 Session 前缀重建，包含当时仍有效的 system、user、assistant 与 tool 消息。assistant/attempt 只记录失败或重试的流，不进入后续对话上下文。'
  return `<div class="detail-stack"><section class="panel"><div class="panel-head"><h2>${escapeHtml(stepTitle(step))}</h2><span>#${step.startSeq}–${step.endSeq ?? '进行中'}</span></div><div class="panel-body"><div class="quick-grid"><div class="quick"><span>模型</span><strong>${escapeHtml(model)}</strong></div><div class="quick"><span>模型尝试</span><strong>${step.requests.length}</strong></div><div class="quick"><span>步骤耗时</span><strong>${escapeHtml(fmtDuration(step.startTime, step.endTime))}</strong></div></div><div class="section-title"><h2>步骤 Event</h2><small>完整时间线</small></div><div class="toolbar">${step.eventSeqs.map(seq => `<button class="ghost-button" type="button" data-event="${seq}">#${seq} ${escapeHtml(state.data.events[seq]?.type ?? '')}</button>`).join('')}</div></div></section>
    <section class="panel"><div class="panel-head"><h2>LLM 请求与响应</h2><span>${escapeHtml(provider)}</span></div><div class="panel-body">${request === undefined ? '<div class="empty">尚无持久化模型尝试。</div>' : `
      <div class="attempt-tabs">${step.requests.map((attempt, attemptIndex) => `<button type="button" data-attempt="${attemptIndex}" class="${attemptIndex === index ? 'active' : ''}">${attempt.type === 'assistant/message' ? '已组装响应' : '未完成尝试'} · #${attempt.seq}</button>`).join('')}</div>
      <div class="notice">${escapeHtml(contextNotice)}</div>
      ${request.error ? `<div class="notice warn" style="margin-top:12px">上下文无法完整重建：${escapeHtml(request.error)}</div>` : !ready ? `<div class="notice ${requestError ? 'warn' : ''}" style="margin-top:12px">${requestError ? `读取失败：${escapeHtml(requestError)}` : '正在按需读取完整逻辑输入与标准化响应流…'}</div>` : `
      <div class="section-title"><h2>发送给模型适配器的输入</h2><small>${request.messages.length} 条有序消息</small></div>
      <details><summary>请求配置与工具 Schema <span class="summary-muted">${escapeHtml(provider)} / ${escapeHtml(model)}</span></summary><div class="detail-inner">${codeBox(request.header)}</div></details>
      <details><summary>请求上下文 <span class="summary-muted">provider / model / context window</span></summary><div class="detail-inner">${codeBox(request.requestContext)}</div></details>
      <div class="section-title"><h2>上下文消息</h2><small>按模型接收顺序</small></div>${messageCards(request.messages)}`}
      <div class="section-title"><h2>模型返回的标准化流</h2><small>${request.stream?.length ?? request.streamCount ?? 0} 条持久化记录</small></div>${ready ? streamCards(request.stream) : '<div class="notice">选中请求后加载流详情。</div>'}
      ${ready ? `<details style="margin-top:9px"><summary>查看完整标准化流 JSON</summary><div class="detail-inner">${codeBox(request.stream)}</div></details>` : ''}
      <div class="section-title"><h2>Harness 组装结果</h2><small>BlockAssembler 结果</small></div>${request.response === null ? '<div class="notice">此尝试只有日志流，没有提交助手消息。</div>' : codeBox(request.response)}
      ${request.usage ? `<details style="margin-top:9px"><summary>Token 用量</summary><div class="detail-inner">${codeBox(request.usage)}</div></details>` : ''}
    `}</div></section>
    <section class="panel"><div class="panel-head"><h2>工具执行</h2><span>${step.tools.length} 次</span></div><div class="panel-body">${step.tools.length === 0 ? '<div class="empty">本步骤没有工具调用。</div>' : step.tools.map(tool => `<details><summary><span class="tag tool">${escapeHtml(tool.name)}</span><span>#${tool.seq}</span><span class="summary-muted">${escapeHtml(short(tool.arguments, 85))}</span></summary><div class="detail-inner"><div class="section-title"><h2>模型给工具的原始入参</h2><small>tool/call #${tool.seq}</small></div>${codeBox(tool.arguments)}<div class="section-title"><h2>返回给模型的结果</h2><small>${tool.resultSeq === null ? '等待结果' : `tool/result #${tool.resultSeq}`}</small></div>${tool.result === null ? '<div class="notice">尚未记录工具结果。</div>' : codeBox(tool.result)}${tool.error ? `<div class="section-title"><h2>工具错误</h2></div>${codeBox(tool.error)}` : ''}</div></details>`).join('')}</div></section>
    <section class="panel"><div class="panel-head"><h2>子 Agent</h2><span>${step.children.length} 个</span></div><div class="panel-body">${step.children.length === 0 ? '<div class="empty">本步骤没有创建子 Agent。</div>' : step.children.map(child => { const known = state.sessions.find(session => session.id === child.childId); return `<div class="notice" style="margin-bottom:8px"><strong>${escapeHtml(child.label ?? child.childId)}</strong><br>ID：${escapeHtml(child.childId)} · 目录模式：${escapeHtml(child.mode)} · Event #${child.seq}<br>${known ? `父历史继承：${known.isSeeded ? '是' : '否'}　<button type="button" class="ghost-button" data-session="${escapeHtml(child.childId)}">打开子会话 ↗</button>` : '子会话日志尚不可用'}</div>` }).join('')}<p class="subhead">spawn provider 创建独立会话；fork provider 复制父会话截至最后一个已完成轮次的日志。目录里的 one-shot / continuable 表示子会话生命周期；继承情况以子会话 header 的 isSeeded 为准。</p></div></section>
  </div>`
}

function renderSteps() {
  const step = state.data.steps.find(row => row.key === state.stepKey) ?? state.data.steps[0]
  if (step === undefined) return heading('LLM TRACE', '尚无模型步骤', '当前会话没有 step/start Event。')
  return `${heading('LLM TRACE', '逐步查看模型往返', '选择步骤，检查当时的完整逻辑上下文、工具 Schema、标准化响应流、Harness 组装结果与工具输入输出。')}
    <div class="step-layout">${renderStepRail()}${renderStepDetail(step)}</div>`
}

function svgButton() {
  return '<button type="button" class="ghost-button" data-download-svg="traceSvg">下载 SVG ↓</button>'
}

function renderGraph() {
  return `${heading('TRAJECTORY MAP', '轨迹图', '按轮次查看上下文、模型尝试、解析响应、工具和子 Agent。点击节点检查原始记录。', svgButton())}
    <p class="graph-note">每行对应一个步骤；从左到右展示已记录的输入、响应与执行分支。实线工具返回表示存在 tool/result，虚线子 Agent 关系只表示目录记录，不推断子会话已经完成。</p>
    ${graphUi.render(state.data)}`
}

function sequenceSvg(steps) {
  const lanes = [145, 350, 565, 785, 1000]
  const names = ['Session', 'Agent Loop', 'LLM', 'Tool', 'Subagent']
  const rows = []
  let y = 110
  for (const step of steps) {
    for (const seq of step.eventSeqs) {
      const event = state.data.events[seq]
      if (!event) continue
      let row
      if (event.type === 'step/start') {
        row = { from: 0, to: 1, label: `${stepTitle(step)} · step/start #${seq}`, color: '#82aaf2' }
      } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        const request = step.requests.find(item => item.seq === seq)
        rows.push({ y, from: 1, to: 2, label: `request #${seq} · ${request?.model ?? '模型'}`, key: step.key, color: '#b69aec' })
        y += 34
        row = { from: 2, to: 1, label: `${event.type} #${seq}`, color: '#b69aec' }
      } else if (event.type === 'tool/call') {
        row = { from: 1, to: 3, label: `${event.data.name} · tool/call #${seq}`, color: '#e0a465' }
      } else if (event.type === 'tool/result') {
        row = { from: 3, to: 1, label: `tool/result #${seq}`, color: '#e0a465' }
      } else if (event.type === 'subagent/catalog') {
        row = { from: 1, to: 4, label: `child ${short(event.data.label ?? event.data.childId, 25)} #${seq}`, color: '#62d4a7' }
      } else if (event.type === 'step/end') {
        row = { from: 1, to: 0, label: `step/end #${seq}`, color: '#82aaf2' }
      }
      if (row) {
        rows.push({ y, ...row, key: step.key })
        y += 35
      }
    }
    y += 28
  }
  const height = Math.max(260, y + 40)
  const markup = [`<svg id="traceSvg" viewBox="0 0 1140 ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DSH Agent Loop 顺序图"><defs><marker id="seq-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#b9cce9"/></marker></defs>`]
  for (const [index, x] of lanes.entries()) {
    markup.push(`<rect x="${x - 67}" y="22" width="134" height="40" rx="9" fill="${index === 2 ? '#3a2d58' : index === 3 ? '#3b302a' : index === 4 ? '#1b4039' : '#1b3151'}" stroke="${index === 2 ? '#795daa' : index === 3 ? '#936b42' : index === 4 ? '#438e77' : '#5079b1'}"/><text x="${x}" y="47" text-anchor="middle" fill="#edf5ff" font-size="12" font-weight="700">${names[index]}</text><line x1="${x}" y1="65" x2="${x}" y2="${height - 24}" stroke="#3e5272" stroke-dasharray="5 6"/>`)
  }
  for (const row of rows) {
    const x1 = lanes[row.from]
    const x2 = lanes[row.to]
    const left = Math.min(x1, x2)
    const right = Math.max(x1, x2)
    const from = x1 < x2 ? x1 + 10 : x1 - 10
    const to = x1 < x2 ? x2 - 12 : x2 + 12
    markup.push(`<g data-step="${escapeHtml(row.key)}"><rect x="${left + 11}" y="${row.y - 25}" width="${right - left - 22}" height="33" rx="6" fill="#1c2a41" opacity=".84"/><line x1="${from}" y1="${row.y}" x2="${to}" y2="${row.y}" stroke="${row.color}" stroke-width="1.7" marker-end="url(#seq-arrow)"/><text x="${(x1 + x2) / 2}" y="${row.y - 8}" text-anchor="middle" fill="${row.color}" font-size="10">${escapeHtml(short(row.label, 57))}</text></g>`)
  }
  markup.push('</svg>')
  return markup.join('')
}

function renderSequence() {
  return `${heading('SEQUENCE DIAGRAM', '顺序图', '按日志先后排列 Session、Agent Loop、LLM、工具与子 Agent 之间的消息。点击任一箭头进入对应步骤。', svgButton())}
    <p class="graph-note">工具与子会话箭头按 Event 序号排列；request 箭头表示从响应前缀重建的逻辑请求，不表示网络发送的精确时刻。历史日志没有保存原始网络帧。</p>
    <div class="graph-shell">${sequenceSvg(state.data.steps)}</div>`
}

function renderContent() {
  if (state.error !== null) {
    content.innerHTML = `<div class="error-state">${escapeHtml(state.error)}</div>`
    return
  }
  if (state.data === null) {
    content.innerHTML = heading('SESSION EXPLORER', '正在读取会话', '请稍候…')
    return
  }
  const views = { overview: renderOverview, events: renderEvents, steps: renderSteps, graph: renderGraph, sequence: renderSequence }
  content.innerHTML = views[state.tab]()
}

async function api(path) {
  const url = new URL(path, location.origin)
  url.searchParams.set('token', token)
  const response = await fetch(url, { cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

async function ensureRequestDetail(seq) {
  if (state.data === null || state.requestDetails.has(seq)) return
  if (state.pendingRequests.has(seq)) return state.pendingRequests.get(seq)
  const id = state.sessionId
  const revision = state.signature
  const task = api(`/api/session/${encodeURIComponent(id)}/request/${seq}`).then(result => {
    if (id !== state.sessionId || revision !== state.signature || result.revision !== revision) return
    state.requestDetails.set(seq, result.request)
    state.requestErrors.delete(seq)
    if (state.tab === 'graph') graphUi.refresh()
    else if (state.tab === 'steps') renderContent()
  }).catch(error => {
    if (id === state.sessionId && revision === state.signature) {
      state.requestErrors.set(seq, error instanceof Error ? error.message : String(error))
      if (state.tab === 'graph') graphUi.refresh()
      else if (state.tab === 'steps') renderContent()
    }
    throw error
  }).finally(() => {
    if (state.pendingRequests.get(seq) === task) state.pendingRequests.delete(seq)
  })
  state.pendingRequests.set(seq, task)
  return task
}

function ensureSelectedRequestDetail() {
  if (state.data === null) return
  const step = state.data.steps.find(row => row.key === state.stepKey) ?? state.data.steps[0]
  const index = Math.min(state.attemptIndex ?? step?.requests.length - 1, step?.requests.length - 1)
  const seq = step?.requests[index]?.seq
  if (seq !== undefined) void ensureRequestDetail(seq).catch(() => {})
}

async function refreshSessions() {
  const result = await api('/api/sessions')
  state.sessions = result.sessions
  const selected = state.sessionId
  sessionSelect.innerHTML = state.sessions.map(session => `<option value="${escapeHtml(session.id)}" ${session.id === selected ? 'selected' : ''}>${escapeHtml(short(session.title, 50))}</option>`).join('')
  if (!state.sessions.some(session => session.id === state.sessionId)) {
    state.sessionId = state.sessions[0]?.id ?? null
    state.data = null
    state.signature = ''
    state.requestDetails = new Map()
    state.requestErrors = new Map()
    state.pendingRequests = new Map()
    graphUi.reset()
    sessionSelect.value = state.sessionId ?? ''
  }
}

async function refreshSession(force = false) {
  if (state.sessionId === null) {
    state.error = '本机日志目录没有可读取的会话。'
    renderContent()
    return
  }
  const id = state.sessionId
  if (!force && state.signature) {
    const current = await api(`/api/session/${encodeURIComponent(id)}/revision`)
    if (id !== state.sessionId) return
    if (current.revision === state.signature) {
      liveStatus.textContent = `已同步 · ${fmtClock(Date.now())}`
      return
    }
  }
  const result = await api(`/api/session/${encodeURIComponent(id)}`)
  if (id !== state.sessionId) return
  const signature = result.revision
  if (force || signature !== state.signature) {
    state.requestDetails = new Map()
    state.requestErrors = new Map()
    state.pendingRequests = new Map()
    result.requestDetails = state.requestDetails
    result.requestErrors = state.requestErrors
    state.data = result
    state.signature = signature
    state.error = null
    if (!result.steps.some(step => step.key === state.stepKey)) state.stepKey = result.steps[0]?.key ?? null
    if (!result.events.some(event => event.seq === state.eventSeq)) state.eventSeq = result.events[0]?.seq ?? null
    renderSummary()
    renderContent()
    if (state.tab === 'steps') ensureSelectedRequestDetail()
    if (state.tab === 'graph') graphUi.loadSelectedRequest()
  }
  liveStatus.textContent = `已同步 · ${fmtClock(Date.now())}`
}

function selectStep(key) {
  state.stepKey = key
  state.attemptIndex = null
  setTab('steps')
}

function selectEvent(seq) {
  state.eventSeq = seq
  setTab('events')
}

function selectSession(id) {
  state.sessionId = id
  state.data = null
  state.signature = ''
  state.requestDetails = new Map()
  state.requestErrors = new Map()
  state.pendingRequests = new Map()
  state.stepKey = null
  state.eventSeq = null
  graphUi.reset()
  const url = new URL(location.href)
  url.searchParams.set('session', id)
  history.replaceState(null, '', url)
  sessionSelect.value = id
  renderSummary()
  renderContent()
  void refreshSession(true).catch(showError)
}

function showError(error) {
  state.error = error instanceof Error ? error.message : String(error)
  liveStatus.textContent = '读取失败'
  renderContent()
}

const graphUi = new GraphUi({ content, escapeHtml, short, codeBox, rerender: renderContent, loadRequest: ensureRequestDetail })

for (const button of tabs) button.addEventListener('click', () => setTab(button.dataset.tab))
sessionSelect.addEventListener('change', () => selectSession(sessionSelect.value))
document.querySelector('#refreshButton').addEventListener('click', () => {
  void refreshSessions().then(() => refreshSession(true)).catch(showError)
})
content.addEventListener('click', async event => {
  if (graphUi.handleClick(event)) return
  const step = event.target.closest('[data-step]')
  if (step) { selectStep(step.dataset.step); return }
  const row = event.target.closest('[data-event]')
  if (row) { selectEvent(Number(row.dataset.event)); return }
  const attempt = event.target.closest('[data-attempt]')
  if (attempt) { state.attemptIndex = Number(attempt.dataset.attempt); renderContent(); ensureSelectedRequestDetail(); return }
  const child = event.target.closest('[data-session]')
  if (child) { selectSession(child.dataset.session); return }
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    await navigator.clipboard.writeText(decodeURIComponent(copy.dataset.copy))
    copy.textContent = '已复制'
    setTimeout(() => { if (copy.isConnected) copy.textContent = '复制' }, 1200)
    return
  }
  const download = event.target.closest('[data-download-svg]')
  if (download) {
    const svg = document.getElementById(download.dataset.downloadSvg)
    if (!svg) return
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = state.tab === 'graph' ? 'dsh-trajectory.svg' : 'dsh-sequence.svg'
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
})
content.addEventListener('input', event => {
  if (graphUi.handleInput(event)) return
  if (event.target.id !== 'eventSearch') return
  state.eventQuery = event.target.value
  const list = document.querySelector('#eventList')
  if (list) list.innerHTML = eventRows()
  const count = document.querySelector('#eventCount')
  if (count) count.textContent = `${filteredEvents().length} / ${state.data.events.length}`
})
content.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-graph-node]')) {
    event.preventDefault()
    graphUi.handleClick(event)
  }
})
content.addEventListener('wheel', event => { graphUi.handleWheel(event) }, { passive: false })
content.addEventListener('pointerdown', event => { graphUi.handlePointerDown(event) })
content.addEventListener('pointermove', event => { graphUi.handlePointerMove(event) })
content.addEventListener('pointerup', event => { graphUi.handlePointerUp(event) })
content.addEventListener('pointercancel', event => { graphUi.handlePointerUp(event) })
content.addEventListener('change', event => {
  if (event.target.id !== 'eventTypeFilter') return
  state.eventType = event.target.value
  const list = document.querySelector('#eventList')
  if (list) list.innerHTML = eventRows()
  const count = document.querySelector('#eventCount')
  if (count) count.textContent = `${filteredEvents().length} / ${state.data.events.length}`
})

renderContent()
try {
  await refreshSessions()
  await refreshSession(true)
} catch (error) {
  showError(error)
}
setInterval(() => {
  void refreshSessions().then(() => refreshSession()).catch(error => { liveStatus.textContent = `同步失败：${error.message}` })
}, 5000)
