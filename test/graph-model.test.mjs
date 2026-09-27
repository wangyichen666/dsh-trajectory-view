import assert from 'node:assert/strict'
import test from 'node:test'
import { GRAPH_TYPES, filterGraph, projectGraph } from '../graph-model.mjs'

const fixture = {
  steps: [
    {
      key: '1-1', turn: 1, step: 1, startSeq: 1, endSeq: 12, eventSeqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      requests: [
        { seq: 3, type: 'assistant/attempt', messages: [{ role: 'user', content: [{ text: 'question' }] }], stream: [] },
        { seq: 5, type: 'assistant/message', messages: [{ role: 'user', content: [{ text: 'question' }] }],
          stream: [{ type: 'text' }], response: { content: [{ text: 'answer' }] }, usage: { output: 3 }, header: { model: 'test' } },
      ],
      tools: [
        { seq: 6, name: 'read', callId: 'a', arguments: '{"path":"a"}', resultSeq: 7, result: { content: 'ok' }, error: null },
        { seq: 8, name: 'bash', callId: 'b', arguments: 'pwd', resultSeq: null, result: null, error: null },
      ],
      children: [{ seq: 10, childId: 'child-1', label: 'analysis', mode: 'fork' }],
    },
    { key: '2-1', turn: 2, step: 1, startSeq: 13, endSeq: null, eventSeqs: [13], requests: [], tools: [], children: [] },
  ],
}

test('projects retries, parsed output, parallel tool branches, and child catalog evidence', () => {
  const graph = projectGraph(fixture)
  assert.deepEqual(graph.turns, [1, 2])
  assert.equal(graph.rows.length, 2)
  assert.ok(graph.nodes.some(node => node.id === 'model:1-1:3' && node.kind === 'retry'))
  assert.ok(graph.nodes.some(node => node.id === 'response:1-1:5'))
  const branches = graph.nodes.filter(node => node.stepKey === '1-1' && ['tool', 'child'].includes(node.kind))
  assert.equal(branches.length, 3)
  assert.equal(new Set(branches.map(node => node.y)).size, 3)
  assert.ok(graph.edges.some(edge => edge.from === 'tool:1-1:6' && edge.to === 'step:1-1' && edge.kind === 'returns'))
  assert.ok(!graph.edges.some(edge => edge.from === 'tool:1-1:8' && edge.kind === 'returns'))
  assert.ok(graph.edges.some(edge => edge.from === 'child:1-1:10' && edge.kind === 'recorded'))
})

test('selects a Turn and filters nodes without inventing edges', () => {
  const turn = projectGraph(fixture, 2)
  assert.equal(turn.rows.length, 1)
  assert.ok(turn.nodes.every(node => node.turn === 2))
  assert.ok(!turn.nodes.some(node => node.kind === 'response'))

  const graph = projectGraph(fixture, 1)
  const onlyTools = filterGraph(graph, 'read', new Set(GRAPH_TYPES.map(([kind]) => kind)))
  assert.deepEqual(onlyTools.nodes.map(node => node.id), ['tool:1-1:6'])
  assert.deepEqual(onlyTools.edges, [])
  assert.equal(onlyTools.rows.length, 1)
  const laterMatch = filterGraph(projectGraph(fixture), '等待模型响应', new Set(GRAPH_TYPES.map(([kind]) => kind)))
  assert.equal(laterMatch.rows.length, 1)
  assert.equal(laterMatch.rows[0].y, 82)
  assert.ok(laterMatch.height < projectGraph(fixture).height)
})

test('reveals prompt and stream only after a request detail is loaded', () => {
  const summary = {
    ...fixture.steps[0],
    requests: [{ seq: 5, type: 'assistant/message', model: 'test-model', streamCount: 1,
      response: { content: [{ text: 'answer' }] } }],
  }
  const data = { steps: [summary], requestDetails: new Map() }
  const before = projectGraph(data)
  assert.equal(before.nodes.find(node => node.kind === 'context').subtitle, '点击查看逻辑输入')
  assert.equal(before.nodes.find(node => node.kind === 'model').subtitle, 'Event #5 · 1 条流记录')

  data.requestDetails.set(5, fixture.steps[0].requests[1])
  const after = projectGraph(data)
  assert.equal(after.nodes.find(node => node.kind === 'context').subtitle, '1 条逻辑输入消息')
  assert.equal(after.nodes.find(node => node.kind === 'model').detail.stream.length, 1)
})
