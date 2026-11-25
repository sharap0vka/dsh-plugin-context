// Unit-check the CNY pricing model: peak windows, both rate tables, cache
// writes, unknown models and the money formatter.
// Usage: node verify-pricing.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const bundle = fs.existsSync('client.js') ? path.resolve('client.js') : path.resolve('plugins/context-inspector/client.js')
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
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: (component) => component,
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
captured[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
const internals = sandbox.__contextInspectorInternals__

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// 2026-11-24 is a Tuesday; 2026-11-28 is a Saturday. Both at 02:00 UTC.
const tuesdayPeak = Date.UTC(2026, 10, 24, 2, 0)
const saturday = Date.UTC(2026, 10, 28, 2, 0)
const tuesdayLunch = Date.UTC(2026, 10, 24, 5, 0) // 13:00 Beijing: off-peak
const tuesdayEvening = Date.UTC(2026, 10, 24, 7, 30) // 15:30 Beijing: peak

check('peak: Tuesday 02:00 UTC', internals.isPeakHour(tuesdayPeak), true)
check('peak: Saturday 02:00 UTC', internals.isPeakHour(saturday), false)
check('peak: Beijing lunch 05:00 UTC', internals.isPeakHour(tuesdayLunch), false)
check('peak: Beijing 15:30 07:30 UTC', internals.isPeakHour(tuesdayEvening), true)

const million = { cacheRead: 1e6, cacheMiss: 0, output: 0 }
const millionMiss = { cacheRead: 0, cacheMiss: 1e6, output: 0 }
const millionOut = { cacheRead: 0, cacheMiss: 0, output: 1e6 }
const round = (value) => Math.round(value * 1e6) / 1e6

check('flash cache hit, peak', round(internals.priceUsageReport(million, 'deepseek-flash', tuesdayPeak).cacheHit), 0.04)
check('flash cache hit, off-peak', round(internals.priceUsageReport(million, 'deepseek-flash', saturday).cacheHit), 0.02)
check('flash cache miss, peak', round(internals.priceUsageReport(millionMiss, 'deepseek-flash', tuesdayPeak).cacheMiss), 2)
check('flash output, off-peak', round(internals.priceUsageReport(millionOut, 'deepseek-flash', saturday).output), 4)
check('pro cache miss, peak', round(internals.priceUsageReport(millionMiss, 'deepseek-v4-pro', tuesdayPeak).cacheMiss), 9)
check('pro output, off-peak', round(internals.priceUsageReport(millionOut, 'deepseek-v4-pro', saturday).output), 13.5)
check('legacy name bills as flash', round(internals.priceUsageReport(millionMiss, 'deepseek-v4-flash', tuesdayPeak).cacheMiss), 2)
check('unknown model is not priced', internals.priceUsageReport(millionMiss, 'some-other-model', tuesdayPeak), undefined)
check('unknown model, no list', internals.priceListFor('gpt-4o'), undefined)
check('cache saving at peak', round(internals.priceUsageReport(million, 'deepseek-flash', tuesdayPeak).saved), 1.96)

// 1M cached input + 1M uncached input + 1M output, peak, flash = 0.04 + 2 + 8
const combined = internals.priceUsageReport({ cacheRead: 1e6, cacheMiss: 1e6, output: 1e6 }, 'deepseek-flash', tuesdayPeak)
check('combined total', round(combined.cacheHit + combined.cacheMiss + combined.output), 10.04)

console.log('money format (default locale):', internals.formatCny(0.0004), internals.formatCny(0.0421), internals.formatCny(4.5187), internals.formatCny(1234.5))
console.log(failures === 0 ? 'PRICING: PASS' : `PRICING: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
