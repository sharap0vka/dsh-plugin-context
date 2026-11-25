// Render the context-inspector panel with a minimal React stub over a real
// session log, then drive it: open every drill-down detail view and print a text
// outline so labels, numbers and layout order can be reviewed without a browser.
// Usage: node render-smoke.mjs <session.jsonl.zstd> [empty]
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'

const file = process.argv[2]
// Works from the plugin folder and from the workspace root that keeps the plugin in plugins/.
const bundle = fs.existsSync('client.js') ? path.resolve('client.js') : path.resolve('plugins/context-inspector/client.js')

function readEvents(filePath) {
  const buffer = fs.readFileSync(filePath)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(starts[i], starts[i + 1] ?? buffer.length)).toString('utf8')
    } catch {}
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

const events = process.argv[3] === 'empty'
  ? []
  : readEvents(file).filter((event) => typeof event.type === 'string' && event.type !== 'session')
const window = { revision: events.length, hasMore: false, entries: events.map((event) => ({ type: 'event', event })) }

const usageEvents = events.filter((event) => event.type === 'assistant/message' && event.data?.usage)
const tokenUsage = usageEvents.reduce((acc, event) => ({
  uncachedInputTokens: acc.uncachedInputTokens + (event.data.usage.inputTokens ?? 0),
  outputTokens: acc.outputTokens + (event.data.usage.outputTokens ?? 0),
  cacheReadTokens: acc.cacheReadTokens + (event.data.usage.cacheReadTokens ?? 0),
  cacheWriteTokens: acc.cacheWriteTokens + (event.data.usage.cacheWriteTokens ?? 0),
}), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const last = usageEvents.at(-1)?.data.usage ?? {}
const contextPressure = {
  pressureTokens: (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0),
  contextWindow: events.filter((event) => event.type === 'request/context').at(-1)?.data?.contextWindow,
}
const projections = { tokenUsage, contextPressure, contextBreakdown: undefined }

/* ---- Capture the module ---- */
const captured = []
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => captured.push(definition) } },
  console,
  setTimeout,
  clearTimeout,
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
}
sandbox.globalThis = sandbox
sandbox.__CONTEXT_INSPECTOR_TEST__ = true
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(bundle, 'utf8'), sandbox, { filename: bundle })

/* ---- Minimal React with a real hook-state store so clicks can drive the panel ---- */
const element = (type, props, ...children) => {
  const resolved = { ...(props ?? {}) }
  if (children.length === 1) resolved.children = children[0]
  else if (children.length > 1) resolved.children = children
  return { type, props: resolved, children }
}

let slots = []
let cursor = 0
let dirty = false
function renderState(initial) {
  const index = cursor
  cursor += 1
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    slots[index] = typeof next === 'function' ? next(slots[index]) : next
    dirty = true
  }
  return [slots[index], set]
}

const React = {
  createElement: element,
  memo: (component) => component,
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useState: (initial) => renderState(initial),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const module = captured[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

/* ---- Fake client context ---- */
const ru = {}
const registrations = []
const ctx = {
  effect: (factory) => { factory(); return () => {} },
  locale: {
    register: (ns, dicts) => { Object.assign(ru, dicts.ru ?? {}); return () => {} },
    bind: () => (key, params) => {
      const template = ru[key] ?? key
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    },
  },
  sessions: {
    binding: () => ({ eventSource: { getSnapshot: () => window, subscribe: () => () => {} } }),
  },
  sidebarRightTabs: { register: (definition) => { registrations.push({ kind: 'tab', definition }); return () => {} } },
  slots: {
    inject: (key, callback) => { callback(); return () => {} },
    register: (options, component) => { registrations.push({ kind: 'slot', options, component }); return () => {} },
  },
}
module.apply(ctx)

const tab = registrations.find((entry) => entry.kind === 'tab')
const body = registrations.find((entry) => entry.kind === 'slot')
console.log('tab type :', JSON.stringify({ id: tab.definition.id, kind: tab.definition.kind, guide: tab.definition.guide.map((entry) => ({ id: entry.id, order: entry.order, title: entry.title() })) }))
console.log('body slot:', JSON.stringify(body.options))
console.log('title    :', tab.definition.title())

function render() {
  cursor = 0
  dirty = false
  return body.component({
    sessionId: 'session-test',
    t: ctx.locale.bind('contextInspector'),
    useProjection: (key) => projections[key],
  })
}

/* ---- Text serialization ---- */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (node.type === 'style') return ''
  return textOf(node.children)
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) collect(child, predicate, out); return out }
  if (typeof node !== 'object') return out
  const children = typeof node.type === 'function' ? [node.type(node.props)] : node.children
  if (predicate(node)) out.push(node)
  for (const child of Array.isArray(children) ? children : [children]) collect(child, predicate, out)
  return out
}

const tree = render()

console.log('--- main view: cards')
for (const node of collect(tree, (candidate) => typeof candidate.props?.className === 'string' && candidate.props.className.includes('ci-card-head'))) {
  console.log('  •', textOf(node).replace(/\s+/g, ' ').trim())
}
console.log('--- main view: distribution rows')
for (const node of collect(tree, (candidate) => typeof candidate.props?.className === 'string' && candidate.props.className.startsWith('ci-row'))) {
  console.log('  ·', textOf(node).replace(/\s+/g, ' ').trim())
}

/* ---- Drive every drill-down ---- */
const openTargets = [...new Set(collect(tree, (candidate) => typeof candidate.props?.['aria-label'] === 'string'
  && candidate.props['aria-label'].startsWith('Открыть'))
  .map((candidate) => candidate.props['aria-label']))]
console.log('--- drill-down targets')
console.log('  ' + openTargets.join('\n  '))

for (const label of openTargets) {
  slots = []
  const fresh = render()
  const target = collect(fresh, (candidate) => candidate.props?.['aria-label'] === label)[0]
  target.props.onClick()
  const detailed = render()
  const sheet = collect(detailed, (candidate) => typeof candidate.props?.className === 'string' && candidate.props.className === 'ci-sheet')[0]
  if (sheet === undefined) {
    console.log(`!! ${label}: no sheet opened`)
    continue
  }
  const bodyText = textOf(sheet)
  const panels = collect(sheet, (candidate) => typeof candidate.props?.className === 'string' && candidate.props.className === 'ci-panel').length
  const rows = collect(sheet, (candidate) => typeof candidate.props?.className === 'string' && candidate.props.className.startsWith('ci-row')).length
  console.log(`\n== ${label}  (panels=${panels}, rows=${rows}, chars=${bodyText.length})`)
  console.log(bodyText.replace(/\s+/g, ' ').trim().slice(0, 700))

  if (label === 'Открыть все сообщения') {
    // Expand the heaviest message and one heavy tool result, and verify the
    // complete content is rendered rather than the summary preview.
    const expandables = collect(sheet, (candidate) => typeof candidate.props?.['aria-label'] === 'string'
      && candidate.props['aria-label'].includes('показать содержимое'))
    if (expandables.length === 0) {
      console.log('!! no expandable message row')
      continue
    }
    const toolRow = expandables.find((candidate) => candidate.props['aria-label'].startsWith('Результат'))
    for (const candidate of [expandables[0], toolRow].filter(Boolean)) {
      candidate.props.onClick()
      const expanded = render()
      const expandedSheet = collect(expanded, (candidateNode) => typeof candidateNode.props?.className === 'string'
        && candidateNode.props.className === 'ci-sheet')[0]
      const codeBlocks = collect(expandedSheet, (candidateNode) => candidateNode.props?.className === 'ci-code')
      const meta = collect(expandedSheet, (candidateNode) => typeof candidateNode.props?.className === 'string'
        && candidateNode.props.className.includes('ci-expand-meta'))
      console.log(`-- expansion of "${candidate.props['aria-label'].split(':')[0]}": code blocks=${codeBlocks.length}`)
      for (const block of codeBlocks.slice(-1)) {
        const content = textOf(block)
        console.log(`   chars=${content.length} head=${JSON.stringify(content.slice(0, 100))}`)
      }
      if (meta.length > 0) console.log(`   meta=${JSON.stringify(textOf(meta.at(-1)))}`)
    }
  }
}
