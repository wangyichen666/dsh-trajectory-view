/** Event-backed nodes for the explorer's per-step execution graph. */

export const GRAPH_TYPES = [
  ['context', '上下文'],
  ['model', '模型'],
  ['retry', '重试'],
  ['response', '解析响应'],
  ['tool', '工具'],
  ['child', '子 Agent'],
  ['step', '步骤'],
]

const COLUMNS = { context: 48, model: 312, response: 576, branch: 840, step: 1104 }
const NODE_WIDTH = 210
const NODE_HEIGHT = 72
const STACK_GAP = 88
const ROW_GAP = 38

function messageText(message) {
  return (message?.content ?? [])
    .filter(block => typeof block?.text === 'string')
    .map(block => block.text)
    .join(' ')
}

function concise(value, length = 84) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > length ? `${text.slice(0, length)}…` : text
}

function stackY(rowTop, rowHeight, count, index) {
  return rowTop + (rowHeight - (count - 1) * STACK_GAP - NODE_HEIGHT) / 2 + index * STACK_GAP
}

function node(id, kind, step, x, y, title, subtitle, detail, seq = null) {
  const search = [title, subtitle, JSON.stringify(detail) ?? ''].join(' ').slice(0, 20_000).toLocaleLowerCase()
  return {
    id, kind, stepKey: step.key, turn: step.turn, step: step.step, seq,
    x, y, width: NODE_WIDTH, height: NODE_HEIGHT, title, subtitle, detail, search,
  }
}

function edge(from, to, kind) {
  return { id: `${from}->${to}`, from, to, kind }
}

/** Build a graph from recorded steps; `scope` is `all` or a durable Turn number. */
export function projectGraph(data, scope = 'all') {
  const steps = data.steps.filter(step => scope === 'all' || step.turn === scope)
  const nodes = []
  const edges = []
  const rows = []
  let top = 82

  for (const step of steps) {
    const requests = step.requests.map(request => data.requestDetails?.get(request.seq) ?? request)
    const branches = [
      ...step.tools.map(tool => ({ kind: 'tool', value: tool, seq: tool.seq })),
      ...step.children.map(child => ({ kind: 'child', value: child, seq: child.seq })),
    ].sort((left, right) => left.seq - right.seq)
    const attemptCount = Math.max(1, requests.length)
    const branchCount = Math.max(1, branches.length)
    const rowHeight = Math.max(152, attemptCount * STACK_GAP + 16, branchCount * STACK_GAP + 16)
    const middleY = top + (rowHeight - NODE_HEIGHT) / 2
    const contextId = `context:${step.key}`
    const firstRequest = requests[0]
    const finalRequest = requests.findLast(request => request.type === 'assistant/message')
    const contextMessages = firstRequest?.messages
    nodes.push(node(contextId, 'context', step, COLUMNS.context, middleY,
      `第 ${step.turn} 轮 · 第 ${step.step} 步`, contextMessages === undefined ? '点击查看逻辑输入' : `${contextMessages.length} 条逻辑输入消息`,
      { messages: contextMessages, header: firstRequest?.header ?? null,
        requestContext: firstRequest?.requestContext ?? null, requestSeq: firstRequest?.seq ?? null,
        startSeq: step.startSeq }, step.startSeq))

    let previousId = contextId
    if (requests.length === 0) {
      const pendingId = `model:${step.key}:pending`
      nodes.push(node(pendingId, 'model', step, COLUMNS.model, middleY,
        '等待模型响应', '当前步骤尚无持久化模型响应', { startSeq: step.startSeq }))
      edges.push(edge(contextId, pendingId, 'request'))
      previousId = pendingId
    } else {
      for (const [index, request] of requests.entries()) {
        const kind = request.type === 'assistant/attempt' ? 'retry' : 'model'
        const id = `model:${step.key}:${request.seq}`
        const subtitle = request.type === 'assistant/attempt'
          ? `Event #${request.seq} · 未完成尝试`
          : `Event #${request.seq} · ${request.stream?.length ?? request.streamCount ?? 0} 条流记录`
        nodes.push(node(id, kind, step, COLUMNS.model,
          stackY(top, rowHeight, attemptCount, index),
          request.type === 'assistant/attempt' ? `第 ${index + 1} 次尝试` : 'LLM 响应',
          subtitle, request, request.seq))
        edges.push(edge(previousId, id, index === 0 ? 'request' : 'retry'))
        previousId = id
      }
    }

    let outputId = previousId
    if (finalRequest !== undefined) {
      outputId = `response:${step.key}:${finalRequest.seq}`
      nodes.push(node(outputId, 'response', step, COLUMNS.response, middleY,
        'Harness 解析结果', concise(messageText(finalRequest.response) || '已组装助手消息'),
        { response: finalRequest.response, stream: finalRequest.stream,
          usage: finalRequest.usage, requestSeq: finalRequest.seq },
        finalRequest.seq))
      edges.push(edge(`model:${step.key}:${finalRequest.seq}`, outputId, 'parsed'))
    }

    const endId = `step:${step.key}`
    nodes.push(node(endId, 'step', step, COLUMNS.step, middleY,
      step.endSeq === null ? '步骤进行中' : '步骤结束',
      step.endSeq === null ? `起始 Event #${step.startSeq}` : `Event #${step.endSeq}`,
      { startSeq: step.startSeq, endSeq: step.endSeq, eventSeqs: step.eventSeqs },
      step.endSeq))

    if (branches.length === 0) {
      edges.push(edge(outputId, endId, 'follows'))
    } else {
      for (const [index, branch] of branches.entries()) {
        const value = branch.value
        const id = `${branch.kind}:${step.key}:${branch.seq}`
        const isTool = branch.kind === 'tool'
        nodes.push(node(id, branch.kind, step, COLUMNS.branch,
          stackY(top, rowHeight, branchCount, index),
          isTool ? value.name : (value.label ?? '子 Agent'),
          isTool
            ? `调用 #${value.seq} · ${value.resultSeq === null ? '等待结果' : `结果 #${value.resultSeq}`}`
            : `目录 Event #${value.seq} · ${value.childId ?? ''}`,
          isTool ? { arguments: value.arguments, result: value.result,
            error: value.error, callId: value.callId, resultSeq: value.resultSeq }
            : value,
          branch.seq))
        edges.push(edge(outputId, id, isTool ? 'invokes' : 'recorded'))
        if (isTool && value.resultSeq !== null) edges.push(edge(id, endId, 'returns'))
        if (!isTool) edges.push(edge(id, endId, 'recorded'))
      }
    }

    rows.push({ stepKey: step.key, turn: step.turn, step: step.step, y: top, height: rowHeight })
    top += rowHeight + ROW_GAP
  }

  return { nodes, edges, rows, width: 1364, height: Math.max(260, top + 26), turns: [...new Set(data.steps.map(step => step.turn))] }
}

/** Keep matching nodes and only edges whose endpoints remain visible. */
export function filterGraph(graph, query, kinds) {
  const needle = query.trim().toLocaleLowerCase()
  const matches = graph.nodes.filter(item => kinds.has(item.kind) && (needle === '' || item.search.includes(needle)))
  const ids = new Set(matches.map(item => item.id))
  const stepKeys = new Set(matches.map(item => item.stepKey))
  let top = 82
  const offsets = new Map()
  const rows = graph.rows.filter(row => stepKeys.has(row.stepKey)).map(row => {
    offsets.set(row.stepKey, top - row.y)
    const placed = { ...row, y: top }
    top += row.height + ROW_GAP
    return placed
  })
  const nodes = matches.map(item => ({ ...item, y: item.y + offsets.get(item.stepKey) }))
  return {
    ...graph, nodes, rows, height: Math.max(260, top + 26),
    edges: graph.edges.filter(item => ids.has(item.from) && ids.has(item.to)),
  }
}
