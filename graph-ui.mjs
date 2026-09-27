import { GRAPH_TYPES, filterGraph, projectGraph } from './graph-model.mjs'

const MIN_ZOOM = 0.45
const MAX_ZOOM = 1.5

function clamp(value) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value)) }

function edgePath(edge, byId) {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  if (!from || !to) return ''
  const sx = from.x + from.width
  const sy = from.y + from.height / 2
  const tx = to.x
  const ty = to.y + to.height / 2
  const bend = Math.max(36, (tx - sx) * .42)
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
}

/** Session graph controls and SVG presentation. The graph model contains only recorded facts. */
export class GraphUi {
  constructor({ content, escapeHtml, short, codeBox, rerender }) {
    this.content = content
    this.escapeHtml = escapeHtml
    this.short = short
    this.codeBox = codeBox
    this.rerender = rerender
    this.scope = 'all'
    this.scopeChosen = false
    this.states = new Map()
    this.data = null
    this.pan = null
  }

  reset() {
    this.scope = 'all'
    this.scopeChosen = false
    this.states.clear()
    this.pan = null
  }

  current() {
    const key = String(this.scope)
    let value = this.states.get(key)
    if (!value) {
      value = { query: '', types: new Set(GRAPH_TYPES.map(([kind]) => kind)), zoom: .9, selectedId: null }
      this.states.set(key, value)
    }
    return value
  }

  graph() {
    const full = projectGraph(this.data, this.scope)
    return { full, visible: filterGraph(full, this.current().query, this.current().types) }
  }

  render(data) {
    this.data = data
    const turns = [...new Set(data.steps.map(step => step.turn))]
    if (!this.scopeChosen) this.scope = turns.at(-1) ?? 'all'
    if (this.scope !== 'all' && !turns.includes(this.scope)) this.scope = 'all'
    const current = this.current()
    const e = this.escapeHtml
    return `<div class="graph-scope" aria-label="轨迹图范围">
      <button type="button" data-graph-scope="all" class="${this.scope === 'all' ? 'active' : ''}">会话总览</button>
      ${turns.map(turn => `<button type="button" data-graph-scope="${turn}" class="${this.scope === turn ? 'active' : ''}">第 ${turn} 轮</button>`).join('')}
    </div>
    <div class="graph-toolbar" aria-label="轨迹图工具栏">
      <input id="graphSearch" class="search" type="search" placeholder="搜索节点、工具、参数或内容" aria-label="搜索轨迹图" value="${e(current.query)}">
      <div class="graph-types" aria-label="节点类型筛选">${GRAPH_TYPES.map(([kind, label]) => `<button type="button" data-graph-type="${kind}" aria-pressed="${current.types.has(kind)}" class="${current.types.has(kind) ? 'active' : ''}">${label}</button>`).join('')}</div>
      <span id="graphCount" class="graph-count"></span>
      <div class="graph-zoom">
        <button type="button" data-graph-zoom="fit" title="适应当前画布">适应</button>
        <button type="button" data-graph-zoom="out" aria-label="缩小">−</button>
        <button type="button" data-graph-zoom="reset" title="重置缩放">${Math.round(current.zoom * 100)}%</button>
        <button type="button" data-graph-zoom="in" aria-label="放大">＋</button>
      </div>
    </div>
    <div id="graphBody">${this.body()}</div>`
  }

  body() {
    const { full, visible } = this.graph()
    const current = this.current()
    const e = this.escapeHtml
    const byId = new Map(visible.nodes.map(item => [item.id, item]))
    const selected = visible.nodes.find(item => item.id === current.selectedId) ?? null
    if (selected === null) current.selectedId = null
    const neighbors = new Set(selected ? [selected.id] : [])
    for (const link of full.edges) {
      if (link.from === selected?.id) neighbors.add(link.to)
      if (link.to === selected?.id) neighbors.add(link.from)
    }
    const rows = visible.rows.map(row => `<g class="graph-row"><text x="48" y="${row.y - 18}">第 ${row.turn} 轮 · 第 ${row.step} 步</text><line x1="48" y1="${row.y + row.height + 16}" x2="1314" y2="${row.y + row.height + 16}"/></g>`).join('')
    const links = visible.edges.map(link => `<path class="graph-edge" data-kind="${link.kind}" d="${edgePath(link, byId)}" marker-end="url(#graph-arrow)"/>`).join('')
    const cards = visible.nodes.map(item => `<g class="graph-node ${item.id === current.selectedId ? 'selected' : ''} ${selected && !neighbors.has(item.id) ? 'muted' : ''}" data-kind="${item.kind}" data-graph-node="${e(item.id)}" role="button" tabindex="0" aria-label="${e(`${item.title}，${item.subtitle}`)}">
      <title>${e(`${item.title} · ${item.subtitle}`)}</title>
      <rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="10"/>
      <text class="graph-node-title" x="${item.x + 13}" y="${item.y + 27}">${e(this.short(item.title, 22))}</text>
      <text class="graph-node-subtitle" x="${item.x + 13}" y="${item.y + 51}">${e(this.short(item.subtitle, 28))}</text>
    </g>`).join('')
    const svg = `<svg id="traceSvg" width="${Math.round(visible.width * current.zoom)}" height="${Math.round(visible.height * current.zoom)}" viewBox="0 0 ${visible.width} ${visible.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="DSH 语义执行图">
      <defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8aa7cb"/></marker></defs>
      ${rows}${links}${cards}</svg>`
    const empty = visible.nodes.length === 0 ? '<div class="graph-empty">没有符合条件的节点。可清除搜索或重新启用节点类型。</div>' : ''
    queueMicrotask(() => {
      const count = this.content.querySelector('#graphCount')
      if (count) count.textContent = `${visible.nodes.length} / ${full.nodes.length} 节点 · ${visible.edges.length} 条连线`
    })
    return `<div class="graph-workspace ${selected ? 'has-selection' : ''}">
      <div id="graphShell" class="graph-shell graph-canvas" tabindex="0" aria-label="轨迹图画布">${svg}${empty}</div>
      ${selected ? this.inspector(selected) : ''}
    </div>`
  }

  inspector(item) {
    const e = this.escapeHtml
    const detail = item.detail
    let sections
    switch (item.kind) {
      case 'context': sections = [['有序上下文消息', detail.messages], ['请求配置与工具 Schema', detail.header], ['请求上下文', detail.requestContext]]; break
      case 'model':
      case 'retry': sections = [['送给适配器的逻辑消息', detail.messages], ['请求配置与工具 Schema', detail.header], ['标准化响应流', detail.stream], ['组装结果', detail.response], ['Token 用量', detail.usage]]; break
      case 'response': sections = [['组装后的助手消息', detail.response], ['适配器标准化流', detail.stream], ['Token 用量', detail.usage]]; break
      case 'tool': sections = [['模型给工具的入参', detail.arguments], ['工具返回给模型的结果', detail.result], ['错误', detail.error]]; break
      default: sections = [['已记录信息', detail]]
    }
    return `<aside class="graph-inspector" aria-label="节点详情">
      <div class="graph-inspector-head"><div><span class="tag ${item.kind === 'tool' ? 'tool' : item.kind === 'child' ? 'subagent' : 'model'}">${e(GRAPH_TYPES.find(([kind]) => kind === item.kind)?.[1] ?? item.kind)}</span><h2>${e(item.title)}</h2><p>${e(item.subtitle)}</p></div><button type="button" data-graph-close aria-label="关闭节点详情">×</button></div>
      <div class="graph-inspector-actions"><button type="button" class="ghost-button" data-step="${e(item.stepKey)}">查看完整步骤</button>${item.seq === null ? '' : `<button type="button" class="ghost-button" data-event="${item.seq}">Event #${item.seq}</button>`}</div>
      ${sections.filter(([, value]) => value !== null && value !== undefined).map(([title, value], index) => `<details ${index === 0 ? 'open' : ''}><summary>${e(title)}</summary><div class="detail-inner">${this.codeBox(value)}</div></details>`).join('')}
    </aside>`
  }

  refresh() {
    const host = this.content.querySelector('#graphBody')
    if (!host) return
    const before = this.content.querySelector('#graphShell')
    const left = before?.scrollLeft ?? 0
    const top = before?.scrollTop ?? 0
    host.innerHTML = this.body()
    const after = this.content.querySelector('#graphShell')
    if (after) { after.scrollLeft = left; after.scrollTop = top }
    const zoom = this.content.querySelector('[data-graph-zoom="reset"]')
    if (zoom) zoom.textContent = `${Math.round(this.current().zoom * 100)}%`
  }

  handleClick(event) {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return false
    const scope = target.closest('[data-graph-scope]')
    if (scope) {
      this.scope = scope.dataset.graphScope === 'all' ? 'all' : Number(scope.dataset.graphScope)
      this.scopeChosen = true
      this.rerender()
      return true
    }
    const type = target.closest('[data-graph-type]')
    if (type) {
      const current = this.current()
      if (current.types.has(type.dataset.graphType)) current.types.delete(type.dataset.graphType)
      else current.types.add(type.dataset.graphType)
      type.classList.toggle('active', current.types.has(type.dataset.graphType))
      type.setAttribute('aria-pressed', String(current.types.has(type.dataset.graphType)))
      this.refresh()
      return true
    }
    const zoom = target.closest('[data-graph-zoom]')
    if (zoom) {
      const current = this.current()
      const graph = projectGraph(this.data, this.scope)
      const shell = this.content.querySelector('#graphShell')
      if (zoom.dataset.graphZoom === 'fit' && shell) current.zoom = clamp((shell.clientWidth - 24) / graph.width)
      else if (zoom.dataset.graphZoom === 'in') current.zoom = clamp(current.zoom + .1)
      else if (zoom.dataset.graphZoom === 'out') current.zoom = clamp(current.zoom - .1)
      else current.zoom = .9
      this.refresh()
      return true
    }
    const item = target.closest('[data-graph-node]')
    if (item) {
      this.current().selectedId = item.dataset.graphNode
      this.refresh()
      return true
    }
    if (target.closest('[data-graph-close]')) {
      this.current().selectedId = null
      this.refresh()
      return true
    }
    return false
  }

  handleInput(event) {
    if (event.target?.id !== 'graphSearch') return false
    this.current().query = event.target.value
    this.refresh()
    return true
  }

  handleWheel(event) {
    const shell = event.target instanceof Element ? event.target.closest('#graphShell') : null
    if (!shell || event.deltaY === 0) return false
    event.preventDefault()
    const current = this.current()
    const previous = current.zoom
    current.zoom = clamp(Number((current.zoom + (event.deltaY < 0 ? .1 : -.1)).toFixed(2)))
    if (current.zoom === previous) return true
    const rect = shell.getBoundingClientRect()
    const offsetX = event.clientX - rect.left
    const offsetY = event.clientY - rect.top
    const contentX = (shell.scrollLeft + offsetX) / previous
    const contentY = (shell.scrollTop + offsetY) / previous
    this.refresh()
    const next = this.content.querySelector('#graphShell')
    next.scrollLeft = contentX * current.zoom - offsetX
    next.scrollTop = contentY * current.zoom - offsetY
    return true
  }

  handlePointerDown(event) {
    const shell = event.target instanceof Element ? event.target.closest('#graphShell') : null
    if (!shell || event.button !== 0 || event.target.closest('[data-graph-node]')) return
    this.pan = { shell, id: event.pointerId, x: event.clientX, y: event.clientY,
      left: shell.scrollLeft, top: shell.scrollTop }
    shell.setPointerCapture?.(event.pointerId)
    shell.classList.add('panning')
  }

  handlePointerMove(event) {
    if (!this.pan || this.pan.id !== event.pointerId) return
    this.pan.shell.scrollLeft = this.pan.left - (event.clientX - this.pan.x)
    this.pan.shell.scrollTop = this.pan.top - (event.clientY - this.pan.y)
  }

  handlePointerUp(event) {
    if (!this.pan || this.pan.id !== event.pointerId) return
    this.pan.shell.classList.remove('panning')
    if (this.pan.shell.hasPointerCapture?.(event.pointerId)) this.pan.shell.releasePointerCapture(event.pointerId)
    this.pan = null
  }
}
