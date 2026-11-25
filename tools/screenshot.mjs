// Render the context-inspector panel to real HTML over a real session log and
// screenshot it with a headless browser, for the README.
//
// Usage: node screenshot.mjs <session.jsonl.zstd> [--out docs] [--width 400]
//
// The panel is a sidebar widget, so the page reproduces the host's dark theme
// tokens (extracted from the installed app) and lets the panel's own CSS do the
// rest. No host code runs here: the same client.js is loaded into a vm sandbox
// with a minimal React, exactly as the render smoke test does it.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const sessionFile = args[0]
// Works from the plugin folder and from the workspace root that keeps the plugin in plugins/.
const inPluginFolder = fs.existsSync('client.js')
const outDir = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : (inPluginFolder ? 'docs' : 'plugins/context-inspector/docs'))
const width = Number(args.includes('--width') ? args[args.indexOf('--width') + 1] : 400)
const bundle = inPluginFolder ? path.resolve('client.js') : path.resolve('plugins/context-inspector/client.js')
const BROWSER = process.env.SHOT_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const PORT = 9333

/* ---- Session log ---- */
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

const events = readEvents(sessionFile).filter((event) => typeof event.type === 'string' && event.type !== 'session')
const eventWindow = { revision: events.length, hasMore: false, entries: events.map((event) => ({ type: 'event', event })) }
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

/* ---- Load the client half into a sandbox ---- */
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

/* ---- Minimal React with a real hook store so a click can open the sheet ---- */
const element = (type, props, ...children) => {
  const resolved = { ...(props ?? {}) }
  if (children.length === 1) resolved.children = children[0]
  else if (children.length > 1) resolved.children = children
  return { type, props: resolved, children }
}
let slots = []
let cursor = 0
function renderState(initial) {
  const index = cursor
  cursor += 1
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    slots[index] = typeof next === 'function' ? next(slots[index]) : next
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
  sessions: { binding: () => ({ eventSource: { getSnapshot: () => eventWindow, subscribe: () => () => {} } }) },
  sidebarRightTabs: { register: (definition) => { registrations.push({ kind: 'tab', definition }); return () => {} } },
  slots: {
    inject: (key, callback) => { callback(); return () => {} },
    register: (options, component) => { registrations.push({ kind: 'slot', options, component }); return () => {} },
  },
}
module.apply(ctx)
const body = registrations.find((entry) => entry.kind === 'slot')

function render() {
  cursor = 0
  return body.component({
    sessionId: 'session-shot',
    t: ctx.locale.bind('contextInspector'),
    useProjection: (key) => projections[key],
  })
}

/* ---- Element tree to HTML ---- */
const VOID_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'stop', 'use', 'input', 'img', 'br', 'hr'])
const escapeHtml = (text) => String(text)
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;')

function attrsOf(props) {
  const parts = []
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children' || key === 'key' || key === 'ref') continue
    if (/^on[A-Z]/u.test(key)) continue
    if (value === undefined || value === null || value === false) continue
    if (key === 'style') {
      if (typeof value === 'object') {
        const css = Object.entries(value)
          .map(([property, entry]) => `${property}:${String(entry)}`)
          .join(';')
        if (css !== '') parts.push(`style="${escapeHtml(css)}"`)
      }
      continue
    }
    const name = key === 'className' ? 'class' : key
    if (value === true) { parts.push(name); continue }
    parts.push(`${name}="${escapeHtml(String(value))}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

function rawTextOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(rawTextOf).join('')
  if (node === null || node === undefined) return ''
  const children = node.children && node.children.length > 0 ? node.children : node.props?.children
  return rawTextOf(children)
}

function toHtml(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node.type === 'function') return toHtml(node.type(node.props))
  const tag = node.type
  if (tag === 'style') return `<style${attrsOf(node.props ?? {})}>${rawTextOf(node)}</style>`
  const children = node.children && node.children.length > 0 ? node.children : node.props?.children
  const inner = toHtml(children)
  if (VOID_TAGS.has(tag)) return `<${tag}${attrsOf(node.props ?? {})}>`
  return `<${tag}${attrsOf(node.props ?? {})}>${inner}</${tag}>`
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) collect(child, predicate, out); return out }
  const children = typeof node.type === 'function' ? [node.type(node.props)] : node.children
  if (predicate(node)) out.push(node)
  const list = children && children.length > 0 ? children : node.props?.children
  for (const child of Array.isArray(list) ? list : [list]) collect(child, predicate, out)
  return out
}

/* ---- The page: host dark theme tokens, real font stack ---- */
const TOKENS = `
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-overlay: #353638;
  --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1a;
  --dsw-alias-brand-primary: #f9fafb;
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-state-warn-primary: #f59e0b;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-alias-state-success-primary: #4ade80;
  --dsw-specific-sidebar-fill: #151517;
`

function pageFor(panelHtml, extraCss) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Context inspector</title>
<style>
:root {${TOKENS}}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--dsw-alias-bg-base); }
body {
  width: ${width}px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: var(--dsw-alias-label-primary);
  -webkit-font-smoothing: antialiased;
}
.ci-root { height: auto; }
.ci-scroll { overflow: visible; height: auto; }
.ci-sheet { position: static; height: auto; }
.ci-sheet-body { overflow: visible; height: auto; }
${extraCss}
</style>
</head>
<body>
${panelHtml}
</body>
</html>
`
}

/* ---- Screenshots through the browser's own DevTools protocol ---- */
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find((target) => target.type === 'page')
        if (page !== undefined) return page
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('the browser did not expose a DevTools endpoint')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true })
  })
}

function makeClient(socket) {
  let nextId = 1
  const pending = new Map()
  const events = new Map()
  socket.addEventListener('message', (message) => {
    const payload = JSON.parse(message.data)
    if (payload.id !== undefined) {
      const entry = pending.get(payload.id)
      if (entry !== undefined) {
        pending.delete(payload.id)
        if (payload.error !== undefined) entry.reject(new Error(JSON.stringify(payload.error)))
        else entry.resolve(payload.result)
      }
      return
    }
    const listeners = events.get(payload.method)
    if (listeners !== undefined) {
      events.delete(payload.method)
      for (const listener of listeners) listener(payload.params)
    }
  })
  return {
    send(method, params = {}) {
      const id = nextId
      nextId += 1
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    once(method) {
      return new Promise((resolve) => {
        const listeners = events.get(method) ?? []
        listeners.push(resolve)
        events.set(method, listeners)
      })
    },
  }
}

async function shoot(client, filePath, outPath) {
  const loaded = client.once('Page.loadEventFired')
  await client.send('Page.navigate', { url: pathToFileURL(filePath).href })
  await loaded
  // Let layout settle: fonts, then a frame.
  await client.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true })
  await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 2, mobile: false })
  await sleep(120)
  const metrics = await client.send('Page.getLayoutMetrics')
  const height = Math.ceil(metrics.cssContentSize?.height ?? metrics.contentSize?.height ?? 1200)
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await sleep(120)
  const shot = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 2 },
  })
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  return { height, bytes: fs.statSync(outPath).size }
}

/* ---- Build both views ---- */
fs.mkdirSync(outDir, { recursive: true })
const workDir = path.resolve('.shot-work')
fs.mkdirSync(workDir, { recursive: true })

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  const children = node.children && node.children.length > 0 ? node.children : node.props?.children
  return textOf(children)
}

// A card folds on its head; the shot keeps the distribution and the cost open
// and folds the three long lists, so one image tells the whole story.
slots = []
let mainTree = render()
for (const title of ['Инструменты', 'Сообщения']) {
  const head = collect(mainTree, (node) => node.props?.className === 'ci-card-head' && textOf(node).includes(title))[0]
  if (head === undefined) continue
  head.props.onClick()
  mainTree = render()
}
const mainHtml = pageFor(toHtml(mainTree), '')
const mainFile = path.join(workDir, 'panel.html')
fs.writeFileSync(mainFile, mainHtml)

slots = []
const fresh = render()
const systemTarget = collect(fresh, (node) => typeof node.props?.['aria-label'] === 'string'
  && node.props['aria-label'].startsWith('Открыть системный промпт'))[0]
if (systemTarget === undefined) throw new Error('the system prompt drill-down target is missing')
systemTarget.props.onClick()
const sheetHtml = pageFor(toHtml(render()), `
.ci-scroll { display: none; }
.ci-sheet { position: static; border-left: 0; }
`)
const sheetFile = path.join(workDir, 'system-prompt.html')
fs.writeFileSync(sheetFile, sheetHtml)

/* ---- Drive one browser for both shots ---- */
const profile = path.resolve('.shot-profile')
fs.rmSync(profile, { recursive: true, force: true })
const browser = spawn(BROWSER, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' })

let exitCode = 0
try {
  const target = await waitForEndpoint()
  const socket = await connect(target.webSocketDebuggerUrl)
  const client = makeClient(socket)
  await client.send('Page.enable')
  await client.send('Runtime.enable')

  const panelOut = path.join(outDir, 'panel.png')
  const panelShot = await shoot(client, mainFile, panelOut)
  console.log(`panel.png        ${width}x${panelShot.height} @2x  ${Math.round(panelShot.bytes / 1024)} KiB`)

  const sheetOut = path.join(outDir, 'system-prompt.png')
  const sheetShot = await shoot(client, sheetFile, sheetOut)
  console.log(`system-prompt.png ${width}x${sheetShot.height} @2x  ${Math.round(sheetShot.bytes / 1024)} KiB`)

  socket.close()
} catch (error) {
  console.error('screenshot failed:', error.message)
  exitCode = 1
} finally {
  browser.kill()
  await sleep(400)
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
}
process.exit(exitCode)
