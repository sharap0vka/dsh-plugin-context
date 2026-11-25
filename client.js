/**
 * Client half of the context-inspector bundle: one right-Sidebar tab that maps
 * the session context and its token cost, with a per-source distribution and a
 * drill-down detail view for every source.
 *
 * Everything is derived from data the browser already holds — the Session
 * event window (request headers, the system prompt, surface messages, tool
 * calls and results) and the token-meter projections `tokenUsage`,
 * `contextPressure`, and `contextBreakdown`. Pricing reuses the meter's fixed
 * heuristic (four characters per token plus structural overhead) so the rows
 * agree with the host's own composition figures. Nothing is sent, no model
 * call is made, and no host resource is registered.
 */
window.__ModuleLoader__.load({
  id: '@local/context-inspector',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const ID = '@local/context-inspector'
    const KIND = 'context-inspector'
    const NS = 'contextInspector'

    /* ------------------------------------------------------------------ *
     * Token pricing — the token-meter heuristic, kept identical on purpose
     * ------------------------------------------------------------------ */

    const CHARS_PER_TOKEN = 4
    const BLOCK_OVERHEAD = 4
    const ROLE_OVERHEAD = 4

    const priceText = (text) => Math.ceil((typeof text === 'string' ? text.length : 0) / CHARS_PER_TOKEN)

    /** Price one content block exactly as the host's estimator does. */
    function priceBlock(block) {
      if (block === null || typeof block !== 'object') return BLOCK_OVERHEAD
      switch (block.type) {
        case 'text':
        case 'reasoning':
          return priceText(block.text) + BLOCK_OVERHEAD
        case 'tool-call':
          return priceText(block.name) + priceText(block.arguments) + BLOCK_OVERHEAD
        case 'image': {
          const reference = { type: block.type, attachment: block.attachment }
          return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
        }
        default:
          return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
      }
    }

    function priceContent(blocks) {
      if (!Array.isArray(blocks)) return 0
      let tokens = 0
      for (const block of blocks) tokens += priceBlock(block)
      return tokens
    }

    /** Price one model-visible message; a system message prices as prompt text. */
    function priceMessage(message) {
      const content = Array.isArray(message?.content) ? message.content : []
      if (message?.role === 'system') {
        if (content.length === 0) return 0
        let characters = 0
        for (const block of content) {
          characters += block?.type === 'text' ? block.text.length : JSON.stringify(block).length
        }
        return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
      }
      return priceContent(content) + ROLE_OVERHEAD
    }

    const priceToolSchemas = (tools) => (
      Array.isArray(tools) && tools.length > 0
        ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        : 0
    )

    /* ------------------------------------------------------------------ *
     * Formatting — Intl for grouping and percentages, so the panel follows
     * the active locale instead of hardcoded separators and decimal marks.
     * Compact magnitudes keep the conventional K/M suffix: they are a
     * developer-tool abbreviation, not a locale number format.
     * ------------------------------------------------------------------ */

    const NUMBER_FORMATS = new Map()
    const PERCENT_FORMATS = new Map()

    /** Formatting bundle for one locale id, cached per locale. */
    function formatsFor(locale) {
      const key = typeof locale === 'string' && locale !== '' ? locale : 'default'
      let entry = NUMBER_FORMATS.get(key)
      if (entry === undefined) {
        const tag = key === 'default' ? undefined : key
        try {
          entry = { number: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }) }
        } catch {
          entry = { number: undefined }
        }
        NUMBER_FORMATS.set(key, entry)
      }
      return entry
    }

    function percentFormatFor(locale, digits) {
      const key = `${typeof locale === 'string' && locale !== '' ? locale : 'default'}:${digits}`
      let format = PERCENT_FORMATS.get(key)
      if (format === undefined) {
        const tag = key.startsWith('default:') ? undefined : key.slice(0, key.lastIndexOf(':'))
        try {
          format = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: digits })
        } catch {
          format = undefined
        }
        PERCENT_FORMATS.set(key, format)
      }
      return format
    }

    // The active formats are rebound by the panel on every render from the
    // locale service; module-level rows read them without prop plumbing.
    let activeLocale
    let activeNumberFormat = formatsFor(undefined).number

    function bindLocale(locale) {
      if (locale === activeLocale) return
      activeLocale = locale
      activeNumberFormat = formatsFor(locale).number
    }

    function formatNumber(value) {
      const rounded = Math.round(Math.abs(value))
      if (activeNumberFormat !== undefined) return activeNumberFormat.format(rounded)
      return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
    }

    function formatCompact(value) {
      const n = Math.abs(value)
      if (n >= 1e6) return `${(value / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
      if (n >= 1e4) return `${Math.round(value / 1e3)}K`
      if (n >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}K`
      return formatNumber(value)
    }

    function formatPercent(part, whole) {
      if (!(whole > 0)) return '—'
      const share = (100 * part) / whole
      const digits = share >= 10 ? 0 : share >= 1 ? 1 : 2
      const format = percentFormatFor(activeLocale, digits)
      if (share < 0.05) {
        const tiny = percentFormatFor(activeLocale, 1)
        return tiny === undefined ? '<0.1%' : `<${tiny.format(0.001)}`
      }
      return format === undefined ? `${share.toFixed(digits)}%` : format.format(share / 100)
    }

    /** A standalone percentage value, not a share of a whole. */
    function formatShare(percent) {
      const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : 2
      const format = percentFormatFor(activeLocale, digits)
      return format === undefined ? `${percent.toFixed(digits)}%` : format.format(percent / 100)
    }

    const MONEY_FORMATS = new Map()

    /** Yuan, in the reader's own number format; small amounts keep more digits. */
    function formatCny(value) {
      const abs = Math.abs(value)
      const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4
      const key = `${typeof activeLocale === 'string' && activeLocale !== '' ? activeLocale : 'default'}:${digits}`
      let format = MONEY_FORMATS.get(key)
      if (format === undefined) {
        const tag = key.startsWith('default:') ? undefined : key.slice(0, key.lastIndexOf(':'))
        try {
          format = new Intl.NumberFormat(tag, {
            style: 'currency',
            currency: 'CNY',
            currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })
        } catch {
          format = null
        }
        MONEY_FORMATS.set(key, format)
      }
      return format === null || format === undefined ? `¥${value.toFixed(digits)}` : format.format(value)
    }

    /* ------------------------------------------------------------------ *
     * Pricing — DeepSeek's published list, CNY per 1M tokens, as on
     * https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-25).
     * Off-peak is half the peak rate. Peak is Beijing time, Monday to Friday,
     * 09:00-12:00 and 14:00-18:00, which is 01:00-04:00 and 06:00-10:00 UTC.
     * Chinese public holidays are not modelled, so a holiday hour bills at the
     * peak rate here. A cache write is billed as a cache miss, as the platform
     * does.
     * ------------------------------------------------------------------ */

    const CNY_PER_MILLION = {
      'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    }

    // Retired names are still accepted and served by the current model at its price.
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
      'deepseek-chat': 'deepseek-flash',
      'deepseek-reasoner': 'deepseek-v4-pro',
    }

    function priceListFor(model) {
      if (typeof model !== 'string' || model === '') return undefined
      return CNY_PER_MILLION[MODEL_ALIASES[model] ?? model]
    }

    function isPeakHour(time) {
      if (typeof time !== 'number' || !Number.isFinite(time)) return true
      const at = new Date(time)
      const day = at.getUTCDay()
      if (day === 0 || day === 6) return false
      const hour = at.getUTCHours() + at.getUTCMinutes() / 60
      return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
    }

    /** What one provider usage report cost, at the rate of its own hour. */
    function priceUsageReport({ cacheRead, cacheMiss, output }, model, time) {
      const list = priceListFor(model)
      if (list === undefined) return undefined
      const factor = isPeakHour(time) ? 1 : 0.5
      return {
        cacheHit: (cacheRead * list.cacheHit * factor) / 1e6,
        cacheMiss: (cacheMiss * list.cacheMiss * factor) / 1e6,
        output: (output * list.output * factor) / 1e6,
        // What the cached prefix would have cost at the miss rate.
        saved: (cacheRead * (list.cacheMiss - list.cacheHit) * factor) / 1e6,
      }
    }

    const EMPTY_COST = () => ({ cacheHit: 0, cacheMiss: 0, output: 0, saved: 0, total: 0, unpriced: 0 })

    function addCost(target, report) {
      target.cacheHit += report.cacheHit
      target.cacheMiss += report.cacheMiss
      target.output += report.output
      target.saved += report.saved
      target.total += report.cacheHit + report.cacheMiss + report.output
      return target
    }

    /* ------------------------------------------------------------------ *
     * Reading the session log
     * ------------------------------------------------------------------ */

    const SURFACE_TYPES = new Set([
      'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
    ])

    const EMPTY_SOURCE = { subscribe: () => () => {}, getSnapshot: () => undefined }

    // Hoisted patterns: these run once per surface node, so a literal inside the
    // hot function would allocate a RegExp on every event.
    const WHITESPACE_RUN = /\s+/gu
    const PARAGRAPH_BREAK = /\n{2,}/u
    const SKILL_ENTRY_LINE = /^-\s+`([^`]+)`\s*:\s*(.*)$/u

    /** The message a surface event carries, in each event's own envelope shape. */
    function messageOf(event) {
      const data = event.data ?? {}
      switch (event.type) {
        case 'user/message':
          return data
        case 'system/message':
        case 'developer/message':
        case 'assistant/message':
        case 'tool/result':
          return data.message
        default:
          return undefined
      }
    }

    /** Join the model-visible text of one message, ignoring bookkeeping blocks. */
    function rawTextOf(message, limit) {
      const parts = []
      let length = 0
      for (const block of Array.isArray(message?.content) ? message.content : []) {
        let part
        if (block?.type === 'text') part = block.text
        else if (block?.type === 'tool-call') part = `→ ${block.name}`
        else if (block?.type === 'image') part = '[изображение]'
        else if (block?.type === 'file') part = `[файл ${block.attachment?.name ?? ''}]`
        if (part === undefined) continue
        parts.push(part)
        length += part.length
        if (length >= limit) break
      }
      return parts.join('\n')
    }

    function previewOf(text, limit) {
      const collapsed = text.replace(WHITESPACE_RUN, ' ').trim()
      if (collapsed.length <= limit) return collapsed
      return `${collapsed.slice(0, limit - 1)}…`
    }

    /** Parse the durable `<available_skills>` catalog out of one prompt text. */
    function parseSkillCatalog(text) {
      const open = text.indexOf('<available_skills>')
      const close = text.lastIndexOf('</available_skills>')
      if (open < 0 || close <= open) return undefined
      const body = text.slice(open + '<available_skills>'.length, close)
      const wrapperText = text.slice(0, open) + text.slice(close + '</available_skills>'.length)
      const items = []
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim()
        const match = SKILL_ENTRY_LINE.exec(line)
        if (match === null) continue
        items.push({ name: match[1], description: match[2], tokens: priceText(line) + 2 })
      }
      return { wrapperTokens: priceText(wrapperText) + 2, items }
    }

    /** Group a tool name by the source that contributed it. */
    function toolSourceOf(name) {
      if (name.startsWith('mcp__')) {
        const rest = name.slice(5)
        const separator = rest.indexOf('__')
        const server = separator > 0 ? rest.slice(0, separator) : rest
        return { group: 'mcp', server }
      }
      return { group: 'builtin', server: undefined }
    }

    const TOOL_FAMILY_PATTERNS = [
      ['shell', /^(pwsh|bash|terminal|job_|run_)/u],
      ['fs', /^(read|write|edit|apply_patch|glob|grep|working_directory)/u],
      ['web', /^(web_|present)/u],
      ['agent', /^(subagent|workflow|send_message|wait_agent|list_agents|create_goal|update_goal|get_goal|team_)/u],
      ['inspect', /^(cordis_inspect)/u],
      ['schedule', /^schedule_/u],
      ['media', /^(read_image|office_)/u],
      ['knowledge', /^(skill|load_workspace_dependencies)/u],
      ['tooling', /^(todo_write|plugin_manager|list_subagent_models|ask_user_question)/u],
    ]

    /** Coarse family of a tool, used only to pick a glyph. */
    function toolFamilyOf(name) {
      if (name.startsWith('mcp__')) return 'mcp'
      for (const [family, pattern] of TOOL_FAMILY_PATTERNS) {
        if (pattern.test(name)) return family
      }
      return 'generic'
    }

    function bump(map, key, factory) {
      let value = map.get(key)
      if (value === undefined) {
        value = factory()
        map.set(key, value)
      }
      return value
    }

    /**
     * Fold the event window into the panel's read model: the effective request
     * envelope, surviving surface nodes, per-tool totals, the skill catalog,
     * per-turn provider usage, and the disjoint source distribution.
     * @param entries - Session event window entries in log order.
     * @returns the read model.
     */
    function analyze(entries) {
      const nodes = []
      let header
      let route
      const calls = new Map()
      const tools = new Map()
      const skillLoads = new Map()
      const turns = new Map()
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, samples: 0, cost: EMPTY_COST() }

      for (const entry of entries) {
        // The window carries durable events and client-only live chunks; only the former is state.
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        const event = entry.event
        if (event === null || typeof event !== 'object') continue
        const type = event.type
        const data = event.data ?? {}

        if (type === 'request/header') {
          header = {
            seq: event.seq,
            reason: data.reason,
            config: data.header?.config,
            tools: Array.isArray(data.header?.tools) ? data.header.tools : [],
          }
          continue
        }
        if (type === 'request/context') {
          route = data
          continue
        }
        if (type === 'tool/call') {
          const call = { name: data.name, turn: data.turn, step: data.step }
          calls.set(data.callId, call)
          bump(tools, data.name, () => ({
            name: data.name, calls: 0, resultTokens: 0, errors: 0, source: toolSourceOf(data.name), family: toolFamilyOf(data.name),
          })).calls += 1
          if (data.name === 'skill') {
            let skillName
            try {
              const args = JSON.parse(data.arguments ?? '{}')
              skillName = typeof args?.name === 'string' ? args.name : undefined
            } catch {
              skillName = undefined
            }
            if (skillName !== undefined) call.skillName = skillName
          }
          continue
        }
        if (type === 'tool/result') {
          const message = data.message
          const call = calls.get(message?.toolCallId)
          const name = call?.name ?? 'tool'
          const stat = bump(tools, name, () => ({
            name, calls: 0, resultTokens: 0, errors: 0, source: toolSourceOf(name), family: toolFamilyOf(name),
          }))
          stat.resultTokens += priceMessage(message)
          if (data.error !== undefined || message?.isError === true) stat.errors += 1
          if (call?.skillName !== undefined) {
            const load = bump(skillLoads, call.skillName, () => ({ calls: 0, tokens: 0 }))
            load.calls += 1
            load.tokens += priceMessage(message)
          }
        }
        if (type === 'assistant/message') {
          const reported = data.usage
          if (reported !== undefined && typeof reported.inputTokens === 'number') {
            const input = reported.inputTokens || 0
            const output = reported.outputTokens || 0
            const cacheRead = reported.cacheReadTokens || 0
            const cacheWrite = reported.cacheWriteTokens || 0
            usage.input += input
            usage.output += output
            usage.cacheRead += cacheRead
            usage.cacheWrite += cacheWrite
            usage.samples += 1
            const turn = bump(turns, data.turn, () => ({ turn: data.turn, steps: 0, prompt: 0, output: 0, cacheRead: 0, cacheWrite: 0, input: 0, cost: 0, priced: false }))
            turn.steps += 1
            turn.prompt = Math.max(turn.prompt, input + cacheRead + cacheWrite)
            turn.output += output
            turn.cacheRead += cacheRead
            turn.cacheWrite += cacheWrite
            turn.input += input
            // Cost by the clock of the request itself: peak and off-peak differ twofold.
            const report = priceUsageReport(
              { cacheRead, cacheMiss: input + cacheWrite, output },
              header?.config?.model ?? route?.model,
              event.time,
            )
            if (report === undefined) {
              usage.cost.unpriced += 1
            } else {
              addCost(usage.cost, report)
              turn.cost += report.cacheHit + report.cacheMiss + report.output
              turn.priced = true
            }
          }
        }
        if (!SURFACE_TYPES.has(type)) continue

        const op = event.surfaceOp
        if (op !== null && typeof op === 'object' && op.op === 'replace') {
          for (let index = nodes.length - 1; index >= 0; index -= 1) {
            const node = nodes[index]
            if (node.seq >= op.startSeq && node.seq <= op.endSeq) nodes.splice(index, 1)
          }
        }
        const message = messageOf(event)
        // Prompt-bearing messages keep their whole joined text (the skill catalog and the
        // system prompt are read back out of them). Every node also keeps its message
        // reference, so a row can render its complete content on demand instead of a copy.
        const promptBearing = type === 'user/message' || type === 'developer/message' || type === 'system/message'
        const call = type === 'tool/result' ? calls.get(message?.toolCallId) : undefined
        nodes.push({
          seq: event.seq,
          type,
          tokens: priceMessage(message),
          text: promptBearing ? rawTextOf(message, Number.POSITIVE_INFINITY) : undefined,
          message,
          toolName: call?.name,
          isError: type === 'tool/result' && (data.error !== undefined || message?.isError === true),
          preview: previewOf(rawTextOf(message, 600), 220),
          turn: data.turn ?? null,
        })
      }

      // Surviving system prompt: the last nonempty system node in surface order.
      let systemNode
      for (const node of nodes) {
        if (node.type === 'system/message' && node.tokens > 0) systemNode = node
      }

      // The prompt is one text blob, so its own paragraphs are the only per-instruction
      // granularity the log carries. Price each paragraph, heaviest first.
      const systemSections = []
      if (systemNode?.text !== undefined) {
        for (const paragraph of systemNode.text.split(PARAGRAPH_BREAK)) {
          const trimmed = paragraph.trim()
          if (trimmed === '') continue
          systemSections.push({
            text: trimmed,
            label: previewOf(trimmed, 90),
            tokens: priceText(trimmed) + BLOCK_OVERHEAD,
          })
        }
        systemSections.sort((a, b) => b.tokens - a.tokens)
      }

      const groups = { system: 0, developer: 0, user: 0, assistant: 0, tool: 0 }
      const counts = { system: 0, developer: 0, user: 0, assistant: 0, tool: 0 }
      for (const node of nodes) {
        if (node.type === 'system/message') {
          if (node === systemNode) groups.system += node.tokens
          counts.system += 1
          continue
        }
        if (node.type === 'developer/message') {
          groups.developer += node.tokens
          counts.developer += 1
        } else if (node.type === 'user/message') {
          groups.user += node.tokens
          counts.user += 1
        } else if (node.type === 'assistant/message') {
          groups.assistant += node.tokens
          counts.assistant += 1
        } else if (node.type === 'tool/result') {
          groups.tool += node.tokens
          counts.tool += 1
        }
      }

      // Skill catalog: the last surviving user message carrying the envelope.
      let catalog
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index]
        if (node.type !== 'user/message' || node.text === undefined) continue
        const parsed = parseSkillCatalog(node.text)
        if (parsed === undefined) continue
        const itemsTokens = parsed.items.reduce((sum, item) => sum + item.tokens, 0)
        catalog = {
          seq: node.seq,
          wrapperTokens: parsed.wrapperTokens,
          items: parsed.items,
          tokens: parsed.wrapperTokens + itemsTokens,
        }
        break
      }

      const schema = header === undefined ? [] : header.tools
      const declaredNames = new Set(schema.map((tool) => tool.name))
      const toolsTotal = priceToolSchemas(schema)
      // Distribute the envelope's own framing over the declarations so the rows add up.
      const rawPrices = schema.map((tool) => Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN))
      const rawSum = rawPrices.reduce((sum, price) => sum + price, 0)
      const scale = rawSum > 0 && toolsTotal > 0 ? toolsTotal / rawSum : 1
      const toolRows = schema.map((tool, index) => {
        const stat = tools.get(tool.name)
        return {
          name: tool.name,
          tokens: Math.round(rawPrices[index] * scale),
          deferred: tool.deferLoading === true,
          source: toolSourceOf(tool.name ?? ''),
          family: toolFamilyOf(tool.name ?? ''),
          calls: stat?.calls ?? 0,
          resultTokens: stat?.resultTokens ?? 0,
          errors: stat?.errors ?? 0,
          declared: true,
        }
      })
      const extraRows = []
      for (const stat of tools.values()) {
        if (declaredNames.has(stat.name)) continue
        extraRows.push({
          name: stat.name,
          tokens: 0,
          deferred: false,
          source: stat.source,
          family: stat.family,
          calls: stat.calls,
          resultTokens: stat.resultTokens,
          errors: stat.errors,
          declared: false,
        })
      }

      const mcpGroups = new Map()
      const builtinRows = []
      for (const row of [...toolRows, ...extraRows]) {
        if (row.source.group === 'mcp') {
          const group = bump(mcpGroups, row.source.server, () => ({ server: row.source.server, rows: [], tokens: 0, calls: 0, resultTokens: 0 }))
          group.rows.push(row)
          group.tokens += row.tokens
          group.calls += row.calls
          group.resultTokens += row.resultTokens
        } else {
          builtinRows.push(row)
        }
      }

      return {
        provider: header?.config?.provider ?? route?.provider,
        model: header?.config?.model ?? route?.model,
        contextWindow: route?.contextWindow,
        headerSeq: header?.seq,
        toolCount: schema.length,
        toolsTotal,
        toolRows,
        builtinRows,
        mcpGroups: [...mcpGroups.values()].sort((a, b) => b.tokens - a.tokens),
        groups,
        counts,
        systemNode,
        systemSections,
        nodes,
        catalog,
        skillLoads,
        turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
        usage,
      }
    }

    /** Last durable sequence in the window: the fold's memo key, immune to live streaming chunks. */
    function durableSignature(entries) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (entry?.type === 'event') return `${entry.event.seq}:${entries.length}`
      }
      return `-1:${entries.length}`
    }

    /* ------------------------------------------------------------------ *
     * Category palette — one hue per remediation surface, all token-derived
     * ------------------------------------------------------------------ */

    const ACCENT = {
      instructions: 'var(--dsw-alias-brand-primary)',
      schemas: 'color-mix(in oklab, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-state-success-primary))',
      mcp: 'var(--dsw-alias-state-success-primary)',
      assistant: 'color-mix(in oklab, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-state-error-primary))',
      toolResults: 'var(--dsw-alias-state-warn-primary)',
      user: 'color-mix(in oklab, var(--dsw-alias-label-secondary) 80%, var(--dsw-alias-brand-primary))',
      skills: 'color-mix(in oklab, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-error-primary))',
      spend: 'color-mix(in oklab, var(--dsw-alias-label-secondary) 65%, var(--dsw-alias-brand-primary))',
    }

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only, so light and dark both follow the host
     * ------------------------------------------------------------------ */

    const CSS = `
/* One system: 4px spacing grid (8 inside a row, 16 at a container edge),
   radius 4 / 8 / 12 / 16 following the host scale, pill only for chips and
   bars, two weights — 400 for text, 500 for headers, 600 for figures — and one
   icon family at 14 / 16 / 18 with a 1.6 stroke. */
.ci-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 1em;
  line-height: 1.45;
}
.ci-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 16px 16px 32px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* Flex children must never shrink below their content: a card body is taller
   than the viewport, and a shrunken card clips rows instead of scrolling. */
.ci-scroll > * { flex: 0 0 auto; }
.ci-num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
.ci-root button {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.ci-root button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
/* Press feedback: the one motion a control needs. Colour changes carry hover. */
.ci-root button:active { transform: translateY(0.5px); }
@media (prefers-reduced-motion: reduce) {
  .ci-root button:active { transform: none; }
}

/* Hero */
.ci-hero {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 16px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ci-hero-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.ci-hero-label {
  font-size: 0.8em;
  color: var(--dsw-alias-label-secondary);
}
.ci-hero-value { font-size: 2em; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
.ci-track {
  position: relative;
  display: flex;
  height: 8px;
  width: 100%;
  border-radius: 999px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
}
.ci-fill { height: 100%; background: var(--dsw-alias-brand-primary); border-radius: 999px; }
.ci-fill-warn { background: var(--dsw-alias-state-warn-primary); }
.ci-fill-danger { background: var(--dsw-alias-state-error-primary); }
.ci-hero-meta { display: flex; justify-content: space-between; gap: 12px; font-size: 0.84em; color: var(--dsw-alias-label-secondary); }
.ci-hero-meta b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.ci-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ci-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.ci-chip-warn {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 45%, transparent);
}
.ci-chip-danger {
  color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 45%, transparent);
}

/* Card */
.ci-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 12px;
  overflow: hidden;
}
.ci-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ci-card-head:hover { background: var(--dsw-alias-bg-layer-2); }
.ci-card-title { font-weight: 500; font-size: 0.95em; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-card-total { font-size: 0.82em; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ci-caret {
  width: 7px; height: 7px; flex: 0 0 auto;
  border-right: 1.5px solid var(--dsw-alias-label-secondary);
  border-bottom: 1.5px solid var(--dsw-alias-label-secondary);
  transform: rotate(45deg);
  transition: transform 120ms ease;
  margin: 0 2px 3px 0;
}
.ci-caret-open { transform: rotate(-135deg); margin-bottom: 0; }
@media (prefers-reduced-motion: reduce) {
  .ci-caret { transition: none; }
}
.ci-card-body { padding: 0 16px 12px; display: flex; flex-direction: column; gap: 1px; }

/* Icon chip */
.ci-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  color: var(--ci-accent, var(--dsw-alias-label-secondary));
  background: color-mix(in oklab, var(--ci-accent, var(--dsw-alias-label-secondary)) 14%, transparent);
  border: 1px solid color-mix(in oklab, var(--ci-accent, var(--dsw-alias-border-l1)) 32%, transparent);
}
.ci-icon-lg { width: 30px; height: 30px; border-radius: 8px; }
.ci-icon svg { display: block; }

/* Rows */
/* Rows bleed 8px into the container padding so the hover surface reads as a
   full-width list row, while the icon column stays on the container's line. */
.ci-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 -8px;
  padding: 8px;
  width: calc(100% + 16px);
  border-radius: 8px;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
}
.ci-row + .ci-row { border-top: 1px solid color-mix(in oklab, var(--dsw-alias-border-l1) 55%, transparent); }
.ci-row-action {
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.ci-row-action:hover { background: var(--dsw-alias-bg-layer-2); }
.ci-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ci-row-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ci-row-name {
  font-size: 0.9em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.ci-row-sub {
  font-size: 0.82em;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}
.ci-row-value { font-size: 0.88em; flex: 0 0 auto; text-align: right; padding-top: 1px; }
.ci-row-extra {
  font-size: 0.8em;
  flex: 0 0 auto;
  text-align: right;
  color: var(--dsw-alias-label-secondary);
  padding-top: 2px;
  min-width: 2.8em;
}
.ci-row-pct { width: 4.2em; text-align: right; font-size: 0.8em; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; padding-top: 2px; }
.ci-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); opacity: 0.55; padding-top: 3px; }
.ci-row-action:hover .ci-chevron { opacity: 1; }
.ci-sub { padding-left: 40px; }

/* Bars */
.ci-bar { height: 4px; border-radius: 999px; background: color-mix(in oklab, var(--dsw-alias-label-secondary) 16%, transparent); overflow: hidden; margin-top: 4px; display: block; }
.ci-bar-fill { height: 100%; border-radius: 999px; background: var(--ci-accent, var(--dsw-alias-brand-primary)); display: block; }
.ci-stack { display: flex; height: 12px; border-radius: 999px; overflow: hidden; margin: 4px 0 8px; background: var(--dsw-alias-bg-layer-2); }
.ci-stack span { height: 100%; }

/* A group divider, not a shouted label: the hairline carries the separation
   and the type stays in sentence case. */
.ci-group {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  margin: 16px 0 4px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in oklab, var(--dsw-alias-border-l1) 55%, transparent);
  font-size: 0.8em;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.ci-group:first-child { margin-top: 4px; padding-top: 0; border-top: 0; }

/* Badges */
.ci-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72em;
  padding: 0 6px;
  line-height: 1.6;
  border-radius: 4px;
  border: 1px solid color-mix(in oklab, var(--ci-accent, var(--dsw-alias-border-l1)) 40%, transparent);
  color: var(--ci-accent, var(--dsw-alias-label-secondary));
  background: color-mix(in oklab, var(--ci-accent, var(--dsw-alias-label-secondary)) 10%, transparent);
  white-space: nowrap;
  flex: 0 0 auto;
}
.ci-badge-quiet {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l1);
  background: none;
}

/* KPI tiles */
.ci-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 4px 0 8px; }
.ci-kpi {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex; flex-direction: column; gap: 1px;
  background: var(--dsw-alias-bg-layer-2);
  min-width: 0;
}
.ci-kpi-label { font-size: 0.78em; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-kpi-value { font-size: 1.08em; font-weight: 600; }
.ci-kpi-note { font-size: 0.78em; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Shared text */
.ci-caption { font-size: 0.78em; color: var(--dsw-alias-label-secondary); margin: 2px 0 6px; }
.ci-footnote { font-size: 0.78em; color: var(--dsw-alias-label-secondary); padding: 6px 2px 0; }
.ci-more {
  margin-top: 8px;
  align-self: flex-start;
  background: none;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 0.8em;
  padding: 8px 12px;
  cursor: pointer;
}
.ci-more:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ci-empty {
  padding: 20px 16px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 0.86em;
  display: flex; flex-direction: column; gap: 6px;
}
.ci-empty-title { color: var(--dsw-alias-label-primary); font-weight: 500; }
.ci-notice {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 0.78em;
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in oklab, var(--dsw-alias-state-warn-primary) 10%, transparent);
}

/* Detail sheet */
.ci-sheet {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
}
.ci-sheet-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.ci-sheet-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 0.8em;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.ci-sheet-back:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.ci-sheet-title { font-weight: 500; font-size: 0.95em; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-sheet-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; padding: 16px 16px 32px; display: flex; flex-direction: column; gap: 12px; }
.ci-sheet-body > * { flex: 0 0 auto; }

/* Detail blocks */
.ci-panel {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.ci-panel-head { display: flex; align-items: center; gap: 8px; }
.ci-panel-title { font-weight: 500; font-size: 0.9em; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-panel-meta { font-size: 0.8em; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ci-prose {
  font-size: 0.88em;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-wrap: pretty;
  color: var(--dsw-alias-label-primary);
  margin: 0;
}
.ci-prose-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 8;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Expandable message content */
.ci-msg {
  display: flex;
  flex-direction: column;
  /* Long lists: skip layout and paint for rows outside the viewport. */
  content-visibility: auto;
  contain-intrinsic-size: auto 52px;
}
@media (pointer: coarse) {
  /* Comfortable touch targets on trackpads' touch screens and tablets. */
  .ci-row, .ci-row-action { padding-top: 12px; padding-bottom: 12px; }
}
.ci-msg + .ci-msg > .ci-row { border-top: 1px solid color-mix(in oklab, var(--dsw-alias-border-l1) 55%, transparent); }
.ci-expand {
  margin: 4px 0 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ci-expand-head { display: flex; align-items: center; gap: 8px; }
.ci-expand-meta { font-size: 0.76em; color: var(--dsw-alias-label-secondary); flex: 1 1 auto; }
.ci-code {
  margin: 0;
  max-height: 336px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
  font-size: 0.78em;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}
.ci-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 0.78em;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.ci-copy:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.ci-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 2px 0 0; }
.ci-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.76em;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.ci-swatch { width: 8px; height: 8px; border-radius: 2px; background: var(--ci-accent); flex: 0 0 auto; }
`

    /* ------------------------------------------------------------------ *
     * Glyphs — original 16px line icons, no primitive imports
     * ------------------------------------------------------------------ */

    /* One icon family, three sizes: 16 in rows, 18 in block headers, 14 for
       small affordances. Stroke never varies. */
    function glyph(paths) {
      return function Glyph(props) {
        const size = props?.size ?? 16
        return h('svg', {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }, paths.map((d, index) => (typeof d === 'string'
          ? h('path', { key: index, d })
          : h('circle', { key: index, cx: d[0], cy: d[1], r: d[2] }))))
      }
    }

    const IconInstructions = glyph(['M5 5h14M5 12h9M5 19h12'])
    const IconSchemas = glyph(['M9 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H9M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20H15M4 9h3M4 15h3M17 9h3M17 15h3'])
    const IconMcp = glyph(['M12 3v6M12 15v6M5 12h6M13 12h6', [12, 12, 2]])
    const IconAssistant = glyph(['M12 4l1.8 4.6L18 10l-4.2 1.4L12 16l-1.8-4.6L6 10l4.2-1.4z', 'M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'])
    const IconToolResult = glyph(['M4 7l4 5-4 5M11 17h9'])
    const IconUser = glyph([[12, 8, 3.2], 'M4.5 19.5c1.2-3.2 4-5 7.5-5s6.3 1.8 7.5 5'])
    const IconSkills = glyph(['M12 3l2.3 4.9 5.2.7-3.8 3.7 1 5.2-4.7-2.6-4.7 2.6 1-5.2L4.5 8.6l5.2-.7z'])
    const IconSpend = glyph(['M4 6c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5S4 7.4 4 6z', 'M4 6v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6', 'M4 12v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6'])
    const IconShell = glyph(['M4 7l4.5 5L4 17M11 17h9'])
    const IconFile = glyph(['M7 3h7l4 4v14H7z', 'M14 3v4h4M10 12h5M10 16h5'])
    const IconWeb = glyph(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z'])
    const IconAgent = glyph(['M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z', 'M9.5 13.5h.01M14.5 13.5h.01M12 8V4M9 4h6'])
    const IconInspect = glyph([[11, 11, 6.2], 'M16 16l4.5 4.5'])
    const IconSchedule = glyph(['M12 7v5l3 2', [12, 12, 8.5]])
    const IconMedia = glyph(['M4 5h16v14H4z', 'M4 15l4.5-4 4 3.5 3-2.5L20 16', [9, 9, 1.2]])
    const IconKnowledge = glyph(['M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M8 4v16'])
    const IconTooling = glyph(['M14.5 6.5a3.5 3.5 0 1 0 3 5.5L21 8.5 17.5 5z', 'M13 11L4 20'])
    const IconGeneric = glyph([[12, 12, 3.5], [12, 12, 8]])
    const IconChevron = glyph(['M9 6l6 6-6 6'])
    const IconBack = glyph(['M15 6l-6 6 6 6'])
    const IconCopy = glyph(['M9 9h9v11H9z', 'M6 15H5V4h9v1'])

    const FAMILY_ICON = {
      shell: IconShell,
      fs: IconFile,
      web: IconWeb,
      agent: IconAgent,
      inspect: IconInspect,
      schedule: IconSchedule,
      media: IconMedia,
      knowledge: IconKnowledge,
      tooling: IconTooling,
      mcp: IconMcp,
      generic: IconGeneric,
    }

    const CATEGORY_ICON = {
      instructions: IconInstructions,
      schemas: IconSchemas,
      mcp: IconMcp,
      assistant: IconAssistant,
      toolResults: IconToolResult,
      user: IconUser,
      skills: IconSkills,
      spend: IconSpend,
      generic: IconGeneric,
    }

    /* ------------------------------------------------------------------ *
     * Building blocks
     * ------------------------------------------------------------------ */

    function IconChip({ name, accents, large }) {
      const Glyph = CATEGORY_ICON[name] ?? FAMILY_ICON[name] ?? IconGeneric
      return h('span', {
        className: large === true ? 'ci-icon ci-icon-lg' : 'ci-icon',
        style: accents === undefined ? undefined : { '--ci-accent': accents },
      }, h(Glyph, { size: large === true ? 18 : 16 }))
    }

    function Badge({ label, accent, quiet }) {
      return h('span', {
        className: quiet === true ? 'ci-badge ci-badge-quiet' : 'ci-badge',
        style: accent === undefined || quiet === true ? undefined : { '--ci-accent': accent },
      }, label)
    }

    /** A magnitude bar. Under one percent it would read as dust, so it is not drawn. */
    function Bar({ share, accent }) {
      if (!(share >= 1)) return null
      const width = Math.max(1, Math.min(100, share))
      return h('span', {
        className: 'ci-bar',
        style: accent === undefined ? undefined : { '--ci-accent': accent },
      }, h('span', { className: 'ci-bar-fill', style: { width: `${width}%` } }))
    }

    function Card({ title, icon, iconAccent, total, open, onToggle, children }) {
      return h('section', { className: 'ci-card' },
        h('button', {
          type: 'button',
          className: 'ci-card-head',
          'aria-expanded': open,
          onClick: onToggle,
        },
          icon !== undefined ? h(IconChip, { name: icon, accents: iconAccent }) : null,
          h('span', { className: 'ci-card-title' }, title),
          total !== undefined ? h('span', { className: 'ci-card-total ci-num' }, total) : null,
          h('span', { className: open ? 'ci-caret ci-caret-open' : 'ci-caret', 'aria-hidden': true }),
        ),
        open === true ? h('div', { className: 'ci-card-body' }, children) : null,
      )
    }

    /**
     * One row. With `onClick` it is a real `<button>` — native keyboard
     * activation and focus — with an affordance chevron; otherwise it is a
     * plain reading.
     */
    function Row({
      name, sub, value, extra, percent, icon, iconAccent, accents, badges, share, indent, onClick, ariaLabel,
    }) {
      const className = [
        'ci-row',
        indent === true ? 'ci-sub' : '',
        onClick !== undefined ? 'ci-row-action' : '',
      ].filter(Boolean).join(' ')
      const content = [
        icon !== undefined ? h(IconChip, { key: 'icon', name: icon, accents: iconAccent ?? accents }) : null,
        h('span', { className: 'ci-row-main', key: 'main' },
          h('span', { className: 'ci-row-line' },
            h('span', { className: 'ci-row-name', title: name }, name),
            badges === undefined ? null : badges.map((badge, index) => h(Badge, { key: index, ...badge })),
          ),
          sub !== undefined && sub !== '' ? h('span', { className: 'ci-row-sub', title: sub }, sub) : null,
          share !== undefined && share > 0 ? h(Bar, { share, accent: accents }) : null,
        ),
        value !== undefined ? h('span', { className: 'ci-row-value ci-num', key: 'value' }, value) : null,
        extra !== undefined ? h('span', { className: 'ci-row-extra ci-num', key: 'extra' }, extra) : null,
        percent !== undefined ? h('span', { className: 'ci-row-pct ci-num', key: 'pct' }, percent) : null,
        onClick !== undefined ? h('span', { className: 'ci-chevron', key: 'chevron' }, h(IconChevron, { size: 14 })) : null,
      ]
      if (onClick === undefined) return h('div', { className }, content)
      return h('button', {
        type: 'button',
        className,
        'aria-label': ariaLabel ?? name,
        onClick,
      }, content)
    }

    /** A stat tile is a number: label, figure, note. No icon, no mini chart. */
    function Kpi({ label, value, note }) {
      return h('div', { className: 'ci-kpi' },
        h('span', { className: 'ci-kpi-label' }, label),
        h('span', { className: 'ci-kpi-value ci-num' }, value),
        note !== undefined ? h('span', { className: 'ci-kpi-note ci-num' }, note) : null,
      )
    }

    function StackedTrack({ segments }) {
      const total = segments.reduce((sum, segment) => sum + segment.tokens, 0)
      if (total <= 0) return null
      return h('div', { className: 'ci-stack', 'aria-hidden': true },
        segments.map((segment) => (segment.tokens > 0
          ? h('span', { key: segment.key, style: { width: `${(segment.tokens / total) * 100}%`, background: segment.accent } })
          : null)),
      )
    }

    function Legend({ segments, total }) {
      if (total <= 0) return null
      return h('div', { className: 'ci-legend' },
        segments.filter((segment) => segment.tokens > 0).map((segment) => h('span', { key: segment.key, className: 'ci-legend-item' },
          h('span', { className: 'ci-swatch', style: { '--ci-accent': segment.accent } }),
          `${segment.label} ${formatPercent(segment.tokens, total)}`,
        )),
      )
    }

    function CopyButton({ text, t }) {
      const [copied, setCopied] = useState(false)
      const onClick = () => {
        const clipboard = typeof navigator === 'object' ? navigator.clipboard : undefined
        if (clipboard === undefined) return
        clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }).catch(() => {})
      }
      return h('button', { type: 'button', className: 'ci-copy', onClick },
        h(IconCopy, { size: 14 }),
        h('span', { 'aria-live': 'polite' }, copied ? t('detail.copied') : t('detail.copy')),
      )
    }

    /* ------------------------------------------------------------------ *
     * Detail sheet bodies
     * ------------------------------------------------------------------ */

    function SystemDetail({ model, systemTokens, composed, t, expanded, onToggleSection }) {
      const sections = model.systemSections
      const text = model.systemNode?.text ?? ''
      return [
        h('div', { className: 'ci-panel', key: 'summary' },
          h('div', { className: 'ci-panel-head' },
            h(IconChip, { name: 'instructions', accents: ACCENT.instructions, large: true }),
            h('span', { className: 'ci-panel-title' }, t('detail.system.title')),
            sections.length > 0 ? h(CopyButton, { text, t }) : null,
          ),
          h('div', { className: 'ci-kpis' },
            h(Kpi, { label: t('detail.system.tokens'), value: formatNumber(systemTokens) }),
            h(Kpi, { label: t('detail.system.share'), value: formatPercent(systemTokens, composed) }),
            h(Kpi, { label: t('detail.system.parts'), value: String(sections.length) }),
            h(Kpi, { label: t('detail.system.chars'), value: formatCompact(text.length) }),
          ),
          sections.length > 0
            ? h(Bar, { share: (systemTokens / Math.max(1, composed)) * 100, accent: ACCENT.instructions })
            : null,
          h('div', { className: 'ci-footnote' }, t('detail.system.note')),
        ),
        sections.length === 0
          ? h('div', { className: 'ci-panel', key: 'empty' }, h('div', { className: 'ci-empty' }, t('detail.system.empty')))
          : sections.map((section, index) => {
            const open = expanded[index] !== false
            return h('div', { className: 'ci-panel', key: `s:${index}`, style: { '--ci-accent': ACCENT.instructions } },
              h('div', { className: 'ci-panel-head' },
                h(IconChip, { name: 'instructions', accents: ACCENT.instructions }),
                h('span', { className: 'ci-panel-title' }, t('detail.system.part', { index: String(index + 1) })),
                h('span', { className: 'ci-panel-meta ci-num' },
                  `${formatNumber(section.tokens)} · ${formatPercent(section.tokens, systemTokens)}`),
                h('button', {
                  type: 'button',
                  className: 'ci-copy',
                  'aria-expanded': open,
                  onClick: () => onToggleSection(index),
                }, open ? t('detail.compact') : t('detail.expand')),
              ),
              h(Bar, { share: (section.tokens / Math.max(1, systemTokens)) * 100, accent: ACCENT.instructions }),
              h('p', { className: open ? 'ci-prose' : 'ci-prose ci-prose-clamped' }, section.text),
            )
          }),
      ]
    }

    function ToolsDetail({ model, toolsTokens, t }) {
      const builtin = model.builtinRows.slice().sort((a, b) => (b.tokens + b.resultTokens) - (a.tokens + a.resultTokens))
      const allRows = builtin.concat(...model.mcpGroups.map((group) => group.rows))
      const maxWeight = allRows.reduce((max, row) => Math.max(max, row.tokens + row.resultTokens), 0)
      const rowOf = (row, key) => h(Row, {
        key,
        name: row.name,
        sub: t('row.tool.sub', { calls: String(row.calls), results: formatCompact(row.resultTokens) }),
        value: formatCompact(row.tokens),
        extra: row.resultTokens > 0 ? formatCompact(row.resultTokens) : '—',
        icon: row.family,
        accents: row.source.group === 'mcp' ? ACCENT.mcp : ACCENT.schemas,
        badges: row.deferred === true ? [{ label: t('badge.deferred'), quiet: true }] : undefined,
        share: maxWeight > 0 ? ((row.tokens + row.resultTokens) / maxWeight) * 100 : undefined,
      })
      return [
        h('div', { className: 'ci-panel', key: 'summary' },
          h('div', { className: 'ci-panel-head' },
            h(IconChip, { name: 'schemas', accents: ACCENT.schemas, large: true }),
            h('span', { className: 'ci-panel-title' }, t('detail.tools.title')),
          ),
          h('div', { className: 'ci-kpis' },
            h(Kpi, { label: t('detail.tools.count'), value: String(model.toolCount) }),
            h(Kpi, { label: t('detail.tools.schema'), value: formatCompact(toolsTokens) }),
            h(Kpi, {
              label: t('detail.tools.results'),
              value: formatCompact(allRows.reduce((sum, row) => sum + row.resultTokens, 0)),
            }),
            h(Kpi, { label: t('detail.tools.mcp'), value: String(model.mcpGroups.length) }),
          ),
          h('div', { className: 'ci-footnote' }, t('note.columns')),
        ),
        h('div', { className: 'ci-panel', key: 'builtin' },
          h('div', { className: 'ci-group', style: { marginTop: 0 } },
            h('span', undefined, t('group.builtin')),
            h('span', { className: 'ci-num' }, formatCompact(builtin.reduce((sum, row) => sum + row.tokens, 0))),
          ),
          builtin.length === 0
            ? h('div', { className: 'ci-empty' }, t('tools.none'))
            : builtin.map((row, index) => rowOf(row, `b:${index}`)),
        ),
        ...model.mcpGroups.map((group) => h('div', { className: 'ci-panel', key: `mcp:${group.server}` },
          h('div', { className: 'ci-group', style: { marginTop: 0 } },
            h('span', undefined, `MCP · ${group.server}`),
            h('span', { className: 'ci-num' }, `${formatCompact(group.tokens)} · ${formatCompact(group.resultTokens)}`),
          ),
          group.rows.slice().sort((a, b) => b.tokens - a.tokens).map((row, index) => rowOf(row, `m:${index}`)),
        )),
      ]
    }

    function SkillsDetail({ model, t }) {
      const items = model.catalog?.items ?? []
      const maxTokens = items.reduce((max, item) => Math.max(max, item.tokens), 0)
      return [
        h('div', { className: 'ci-panel', key: 'summary' },
          h('div', { className: 'ci-panel-head' },
            h(IconChip, { name: 'skills', accents: ACCENT.skills, large: true }),
            h('span', { className: 'ci-panel-title' }, t('detail.skills.title')),
          ),
          h('div', { className: 'ci-kpis' },
            h(Kpi, { label: t('detail.skills.count'), value: String(items.length) }),
            h(Kpi, { label: t('detail.skills.catalog'), value: formatCompact(model.catalog?.tokens ?? 0) }),
            h(Kpi, { label: t('detail.skills.framing'), value: formatCompact(model.catalog?.wrapperTokens ?? 0) }),
            h(Kpi, { label: t('detail.skills.loaded'), value: String(model.skillLoads.size) }),
          ),
          h('div', { className: 'ci-footnote' }, t('note.skills')),
        ),
        h('div', { className: 'ci-panel', key: 'list' },
          items.length === 0 ? h('div', { className: 'ci-empty' }, t('skills.none')) : items.map((item) => {
            const load = model.skillLoads.get(item.name)
            return h('div', { key: item.name, className: 'ci-row', style: { '--ci-accent': ACCENT.skills } },
              h(IconChip, { name: 'skills', accents: ACCENT.skills }),
              h('span', { className: 'ci-row-main' },
                h('span', { className: 'ci-row-line' },
                  h('span', { className: 'ci-row-name', title: item.name }, item.name),
                  load === undefined ? null : h(Badge, { label: t('badge.loaded'), accent: ACCENT.skills }),
                ),
                h('span', { className: 'ci-row-sub', title: item.description }, item.description),
                h(Bar, { share: maxTokens > 0 ? (item.tokens / maxTokens) * 100 : 0, accent: ACCENT.skills }),
                load === undefined ? null : h('span', { className: 'ci-row-sub' },
                  t('row.loaded.sub', { calls: String(load.calls), tokens: formatCompact(load.tokens) })),
              ),
              h('span', { className: 'ci-row-value ci-num' }, formatCompact(item.tokens)),
            )
          }),
        ),
      ]
    }

    const MESSAGE_LABEL = {
      'system/message': 'row.message.system',
      'user/message': 'row.message.user',
      'developer/message': 'row.message.developer',
      'assistant/message': 'row.message.assistant',
      'tool/result': 'row.message.tool',
    }

    const MESSAGE_ICON = {
      'system/message': 'instructions',
      'user/message': 'user',
      'developer/message': 'instructions',
      'assistant/message': 'assistant',
      'tool/result': 'toolResults',
    }

    const MESSAGE_ACCENT = {
      'system/message': ACCENT.instructions,
      'user/message': ACCENT.user,
      'developer/message': ACCENT.instructions,
      'assistant/message': ACCENT.assistant,
      'tool/result': ACCENT.toolResults,
    }

    /** Character budget rendered for one expanded node; copying keeps the whole text. */
    const EXPAND_LIMIT = 20000

    /** Row title for one surface node: the tool that produced it, or its kind. */
    function messageTitleOf(node, t) {
      if (node.type === 'tool/result') {
        return node.toolName === undefined
          ? t('row.message.tool')
          : t('row.message.toolNamed', { name: node.toolName })
      }
      return t(MESSAGE_LABEL[node.type] ?? 'row.message.tool')
    }

    /**
     * One message row with an inline expansion: the summary line names the source
     * and shows a snippet, clicking it reveals the complete content with a copy
     * control. The join happens on demand, so the fold never copies whole results.
     * Memoized on primitive props so expanding one row does not re-render the list.
     */
    const MessageRow = React.memo(function MessageRow({ node, seq, t, expanded, onToggle, maxTokens }) {
      const full = useMemo(() => {
        if (expanded !== true) return undefined
        if (node.text !== undefined) return node.text
        if (node.message === undefined) return ''
        return rawTextOf(node.message, Number.POSITIVE_INFINITY)
      }, [expanded, node])
      const shown = full !== undefined && full.length > EXPAND_LIMIT ? full.slice(0, EXPAND_LIMIT) : full
      const truncated = full !== undefined && shown !== undefined && full.length > shown.length
      const badges = []
      if (node.turn !== null) badges.push({ label: t('row.message.turn', { turn: String(node.turn) }), quiet: true })
      if (node.isError === true) badges.push({ label: t('badge.error'), accent: 'var(--dsw-alias-state-error-primary)' })
      return h('div', { className: 'ci-msg' },
        h(Row, {
          name: messageTitleOf(node, t),
          sub: node.preview === '' ? t('row.message.empty') : node.preview,
          value: formatCompact(node.tokens),
          icon: MESSAGE_ICON[node.type] ?? 'toolResults',
          accents: MESSAGE_ACCENT[node.type] ?? ACCENT.user,
          badges,
          share: maxTokens > 0 ? (node.tokens / maxTokens) * 100 : undefined,
          onClick: () => onToggle(seq),
          ariaLabel: `${messageTitleOf(node, t)}: ${expanded === true ? t('detail.message.hide') : t('detail.message.show')}`,
        }),
        expanded === true
          ? h('div', { className: 'ci-expand' },
            h('div', { className: 'ci-expand-head' },
              h('span', { className: 'ci-expand-meta ci-num' },
                truncated
                  ? t('detail.message.truncated', { shown: formatNumber(shown.length), total: formatNumber(full.length) })
                  : t('detail.message.chars', { count: formatNumber(full.length) })),
              h(CopyButton, { text: full, t }),
            ),
            h('pre', { className: 'ci-code', translate: 'no' }, shown === '' ? t('row.message.empty') : shown),
          )
          : null,
      )
    })

    function MessagesDetail({ model, t, expandedMessages, onToggleMessage }) {
      const all = model.nodes
        .filter((node) => node.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
      const capped = all.slice(0, 200)
      const maxTokens = all.reduce((max, node) => Math.max(max, node.tokens), 0)
      return [
        h('div', { className: 'ci-panel', key: 'summary' },
          h('div', { className: 'ci-panel-head' },
            h(IconChip, { name: 'user', accents: ACCENT.user, large: true }),
            h('span', { className: 'ci-panel-title' }, t('detail.messages.title')),
          ),
          h('div', { className: 'ci-kpis' },
            h(Kpi, { label: t('kpi.user'), value: formatCompact(model.groups.user + model.groups.developer) }),
            h(Kpi, { label: t('kpi.assistant'), value: formatCompact(model.groups.assistant) }),
            h(Kpi, { label: t('kpi.toolResults'), value: formatCompact(model.groups.tool) }),
            h(Kpi, { label: t('kpi.nodes'), value: String(all.length) }),
          ),
          h('div', { className: 'ci-footnote' }, t('detail.messages.note')),
          all.length > capped.length
            ? h('div', { className: 'ci-notice' }, t('detail.messages.capped', { count: String(capped.length) }))
            : null,
        ),
        h('div', { className: 'ci-panel', key: 'list' }, capped.map((node) => h(MessageRow, {
          key: `n:${node.seq}`,
          node,
          seq: node.seq,
          t,
          maxTokens,
          expanded: expandedMessages[node.seq] === true,
          onToggle: onToggleMessage,
        }))),
      ]
    }

    function SpendDetail({ model, usageSource, cacheShare, totalBilled, t }) {
      const cost = model.usage.cost
      const priceList = priceListFor(model.model)
      return [
        h('div', { className: 'ci-panel', key: 'summary' },
          h('div', { className: 'ci-panel-head' },
            h(IconChip, { name: 'spend', accents: ACCENT.spend, large: true }),
            h('span', { className: 'ci-panel-title' }, t('detail.spend.title')),
          ),
          h('div', { className: 'ci-kpis' },
            h(Kpi, { label: t('kpi.input'), value: formatCompact(usageSource?.uncachedInputTokens ?? 0), note: t('kpi.input.note') }),
            h(Kpi, {
              label: t('kpi.cache'),
              value: formatCompact(usageSource?.cacheReadTokens ?? 0),
              note: cacheShare === undefined ? undefined : `${formatShare(cacheShare)} ${t('kpi.cache.note')}`,
            }),
            h(Kpi, { label: t('kpi.output'), value: formatCompact(usageSource?.outputTokens ?? 0), note: t('kpi.output.note') }),
            h(Kpi, { label: t('kpi.total'), value: formatCompact(totalBilled), note: t('kpi.total.note') }),
          ),
          (usageSource?.cacheWriteTokens ?? 0) > 0
            ? h(Row, { name: t('row.cacheWrite'), value: formatNumber(usageSource.cacheWriteTokens ?? 0) })
            : null,
          h('div', { className: 'ci-footnote' }, t('note.spend')),
        ),
        h('div', { className: 'ci-panel', key: 'money' },
          h('div', { className: 'ci-panel-head' },
            h(IconChip, { name: 'spend', accents: ACCENT.spend, large: true }),
            h('span', { className: 'ci-panel-title' }, t('detail.pricing.title')),
            cost.total > 0 ? h('span', { className: 'ci-panel-meta ci-num' }, formatCny(cost.total)) : null,
          ),
          cost.total <= 0
            ? null
            : h('div', { className: 'ci-kpis' },
              h(Kpi, { label: t('kpi.cost'), value: formatCny(cost.total), note: t('kpi.cost.note') }),
              h(Kpi, { label: t('kpi.cacheSaved'), value: formatCny(cost.saved), note: t('kpi.cacheSaved.note') }),
              h(Kpi, { label: t('pricing.cacheHit'), value: formatCny(cost.cacheHit) }),
              h(Kpi, { label: t('pricing.output'), value: formatCny(cost.output) }),
            ),
          cost.total > 0 && cost.cacheMiss > 0
            ? h(Row, { name: t('pricing.cacheMiss'), value: formatCny(cost.cacheMiss) })
            : null,
          priceList === undefined
            ? h('div', { className: 'ci-notice' }, t('notice.pricing', { model: model.model ?? t('pricing.unknownModel') }))
            : [
              h('div', { className: 'ci-group', key: 'g-price' },
                h('span', undefined, t('pricing.perMillion')),
                h('span', undefined, t('pricing.columns')),
              ),
              h(Row, { key: 'p-hit', name: t('pricing.cacheHit'), value: formatCny(priceList.cacheHit), extra: formatCny(priceList.cacheHit / 2) }),
              h(Row, { key: 'p-miss', name: t('pricing.cacheMiss'), value: formatCny(priceList.cacheMiss), extra: formatCny(priceList.cacheMiss / 2) }),
              h(Row, { key: 'p-out', name: t('pricing.output'), value: formatCny(priceList.output), extra: formatCny(priceList.output / 2) }),
              h('div', { className: 'ci-caption', key: 'p-model' }, t('detail.pricing.model', { model: model.model ?? t('pricing.unknownModel') })),
            ],
          h('div', { className: 'ci-footnote' }, t('detail.pricing.note')),
        ),
        h('div', { className: 'ci-panel', key: 'turns' },
          h('div', { className: 'ci-group', style: { marginTop: 0 } },
            h('span', undefined, t('group.turns')),
            h('span', undefined, t('group.turns.cost')),
          ),
          model.turns.length === 0
            ? h('div', { className: 'ci-empty' }, t('spend.none'))
            : model.turns.slice().reverse().map((turn) => h(Row, {
              key: `t:${turn.turn}`,
              name: t('row.turn', { turn: String(turn.turn) }),
              sub: t('row.turn.sub', {
                steps: String(turn.steps),
                prompt: formatCompact(turn.prompt),
                output: formatCompact(turn.output),
                cache: turn.cacheRead + turn.input > 0
                  ? formatShare((turn.cacheRead / (turn.cacheRead + turn.input)) * 100)
                  : '—',
              }),
              value: formatCompact(turn.output),
              extra: turn.priced === true ? formatCny(turn.cost) : '—',
              icon: 'spend',
              accents: ACCENT.spend,
            })),
        ),
      ]
    }

    /* ------------------------------------------------------------------ *
     * The panel
     * ------------------------------------------------------------------ */

    function createPanel(ctx) {
      const bound = ctx.locale.bind(NS)

      function Panel(props) {
        const t = typeof props?.t === 'function' ? props.t : bound
        const sessionId = props?.sessionId
        const useProjection = props?.useProjection

        // Number and percent formatting follow the active locale.
        bindLocale(typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale()?.active : undefined)

        // The Session slot scope retains the generation, but a first render can still land
        // before the binding publishes; retry a bounded number of times instead of showing
        // an empty panel for a live Session.
        const [bindingTick, setBindingTick] = useState(0)
        const binding = sessionId === undefined ? undefined : ctx.sessions.binding(sessionId)
        useEffect(() => {
          if (binding !== undefined || sessionId === undefined || bindingTick > 40) return undefined
          const timer = setTimeout(() => setBindingTick((tick) => tick + 1), 250)
          return () => clearTimeout(timer)
        }, [binding, sessionId, bindingTick])

        const source = useMemo(() => (binding === undefined ? EMPTY_SOURCE : binding.eventSource), [binding])
        const subscribe = useCallback((listener) => source.subscribe(listener), [source])
        const snapshot = useCallback(() => source.getSnapshot(), [source])
        const window = useSyncExternalStore(subscribe, snapshot, snapshot)

        const tokenUsage = useProjection === undefined ? undefined : useProjection('tokenUsage')
        const pressure = useProjection === undefined ? undefined : useProjection('contextPressure')
        const breakdown = useProjection === undefined ? undefined : useProjection('contextBreakdown')

        const entries = window?.entries ?? []
        const signature = useMemo(() => durableSignature(entries), [entries])
        const model = useMemo(() => analyze(entries), [signature])

        const [openSections, setOpenSections] = useState({ distribution: true, tools: true, skills: false, messages: true, spend: true })
        const [detail, setDetail] = useState(undefined)
        const [expandedSections, setExpandedSections] = useState({})
        const [expandedMessages, setExpandedMessages] = useState({})
        const backRef = useRef(undefined)
        const sheetRef = useRef(undefined)
        const openerRef = useRef(undefined)
        const toggle = (key) => setOpenSections((current) => ({ ...current, [key]: !current[key] }))

        /** Open a drill-down, remembering the control that must regain focus on close. */
        const openDetail = useCallback((kind) => {
          openerRef.current = typeof document === 'object' ? document.activeElement : undefined
          setDetail(kind)
        }, [])

        const closeDetail = useCallback(() => {
          setDetail(undefined)
          const opener = openerRef.current
          openerRef.current = undefined
          if (opener !== undefined && opener !== null && typeof opener.focus === 'function') opener.focus()
        }, [])

        const toggleMessage = useCallback((seq) => {
          setExpandedMessages((current) => ({ ...current, [seq]: current[seq] !== true }))
        }, [])

        // Escape closes the sheet; Tab is trapped inside it while it is open.
        useEffect(() => {
          if (detail === undefined) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeDetail()
              return
            }
            if (event.key !== 'Tab') return
            const sheet = sheetRef.current
            if (sheet === undefined || sheet === null) return
            const focusable = [...sheet.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
              .filter((element) => element.disabled !== true && element.offsetParent !== null)
            if (focusable.length === 0) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }
          document.addEventListener('keydown', onKeyDown, true)
          return () => document.removeEventListener('keydown', onKeyDown, true)
        }, [detail, closeDetail])

        useEffect(() => {
          if (detail === undefined) return
          if (backRef.current !== undefined && backRef.current !== null) backRef.current.focus()
        }, [detail])

        const capacity = pressure?.contextWindow ?? model.contextWindow
        const pressureTokens = pressure?.pressureTokens
        const projected = pressure?.projectedTokens
        const usedKnown = pressureTokens !== undefined || projected !== undefined
        const used = pressureTokens ?? projected ?? 0
        const occupiedShare = capacity !== undefined && capacity > 0 ? used / capacity : undefined

        const systemTokens = breakdown?.systemTokens ?? model.groups.system
        const toolsTokens = breakdown?.toolsTokens ?? model.toolsTotal
        const catalogTokens = model.catalog?.tokens ?? 0
        // Disjoint sources: the skill catalog lives inside a user message, so it leaves
        // the user slice instead of being counted twice.
        const userOnlyTokens = Math.max(0, model.groups.user - catalogTokens)
        const instructionsTokens = systemTokens + model.groups.developer
        const composed = instructionsTokens + toolsTokens + catalogTokens + userOnlyTokens
          + model.groups.assistant + model.groups.tool

        const mcpTokens = model.mcpGroups.reduce((sum, group) => sum + group.tokens, 0)
        const builtinTokens = model.builtinRows.reduce((sum, row) => sum + row.tokens, 0)
        const hasMcp = model.mcpGroups.length > 0
        const builtinGroupTokens = hasMcp ? builtinTokens : toolsTokens

        const usageSource = tokenUsage ?? (model.usage.samples > 0 ? {
          uncachedInputTokens: model.usage.input,
          cacheReadTokens: model.usage.cacheRead,
          cacheWriteTokens: model.usage.cacheWrite,
          outputTokens: model.usage.output,
        } : undefined)
        const billedInput = (usageSource?.uncachedInputTokens ?? 0)
          + (usageSource?.cacheReadTokens ?? 0)
          + (usageSource?.cacheWriteTokens ?? 0)
        const cacheShare = billedInput > 0 ? ((usageSource?.cacheReadTokens ?? 0) / billedInput) * 100 : undefined
        const totalBilled = billedInput + (usageSource?.outputTokens ?? 0)

        const windowIncomplete = window?.hasMore === true
        const headerMissing = entries.length > 0 && model.headerSeq === undefined

        const segments = [
          { key: 'instructions', label: t('source.instructions'), tokens: instructionsTokens, accent: ACCENT.instructions },
          { key: 'schemas', label: t('source.schemas'), tokens: toolsTokens, accent: ACCENT.schemas },
          { key: 'mcp', label: t('source.mcp'), tokens: mcpTokens, accent: ACCENT.mcp },
          { key: 'skills', label: t('source.skills'), tokens: catalogTokens, accent: ACCENT.skills },
          { key: 'user', label: t('source.user'), tokens: userOnlyTokens, accent: ACCENT.user },
          { key: 'assistant', label: t('source.assistant'), tokens: model.groups.assistant, accent: ACCENT.assistant },
          { key: 'toolResults', label: t('source.toolResults'), tokens: model.groups.tool, accent: ACCENT.toolResults },
        ]

        const sections = []

        if (entries.length === 0) {
          sections.push(h('div', { className: 'ci-card', key: 'empty' },
            h('div', { className: 'ci-empty' },
              h('span', { className: 'ci-empty-title' }, t('empty.title')),
              h('span', undefined, t('empty.body')),
            ),
          ))
          return h('div', { className: 'ci-root' },
            h('style', { 'data-context-inspector': '' }, CSS),
            h('div', { className: 'ci-scroll' }, sections),
          )
        }

        /* Hero */
        const level = occupiedShare === undefined ? undefined : occupiedShare > 0.92 ? 'danger' : occupiedShare > 0.8 ? 'warn' : 'ok'
        sections.push(h('section', { className: 'ci-hero', key: 'hero' },
          h('div', { className: 'ci-hero-top' },
            h('span', { className: 'ci-hero-label' }, t('hero.label')),
            h('span', { className: 'ci-hero-value ci-num' },
              usedKnown && occupiedShare !== undefined ? formatPercent(used, capacity) : '—'),
          ),
          h('div', {
            className: 'ci-track',
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': usedKnown && occupiedShare !== undefined ? Math.round(occupiedShare * 100) : undefined,
            'aria-valuetext': usedKnown && capacity !== undefined
              ? t('hero.valueText', { used: formatNumber(used), capacity: formatNumber(capacity) })
              : t('hero.noData'),
            'aria-label': t('hero.label'),
          },
            usedKnown && occupiedShare !== undefined
              ? h('span', {
                className: level === 'danger' ? 'ci-fill ci-fill-danger' : level === 'warn' ? 'ci-fill ci-fill-warn' : 'ci-fill',
                style: { width: `${Math.max(1.5, Math.min(100, occupiedShare * 100))}%` },
              })
              : null,
          ),
          h('div', { className: 'ci-hero-meta' },
            usedKnown
              ? h('span', undefined,
                h('b', { className: 'ci-num' }, formatNumber(used)),
                capacity !== undefined ? ` / ${formatNumber(capacity)} ${t('unit.tokens')}` : '',
              )
              : h('span', undefined, t('hero.noData')),
            usedKnown && capacity !== undefined
              ? h('span', { className: 'ci-num' }, t('hero.free', { value: formatNumber(Math.max(0, capacity - used)) }))
              : h('span', undefined, capacity === undefined ? t('hero.noWindow') : ''),
          ),
          h('div', { className: 'ci-chips' },
            model.model !== undefined
              ? h('span', { className: 'ci-chip' }, `${model.provider ?? ''}${model.provider === undefined ? '' : ' · '}${model.model}`)
              : null,
            projected !== undefined && projected !== pressureTokens
              ? h('span', { className: 'ci-chip' }, t('hero.projected', { value: formatNumber(projected) }))
              : null,
            composed > 0
              ? h('span', { className: 'ci-chip' }, t('hero.composed', { value: formatCompact(composed) }))
              : null,
            level === 'warn' || level === 'danger'
              ? h('span', { className: level === 'danger' ? 'ci-chip ci-chip-danger' : 'ci-chip ci-chip-warn' }, t('hero.nearlyFull'))
              : null,
          ),
          windowIncomplete ? h('div', { className: 'ci-notice' }, t('notice.window')) : null,
          headerMissing ? h('div', { className: 'ci-notice' }, t('notice.header')) : null,
        ))

        /* Distribution */
        const distributionRows = [
          h(Row, {
            key: 'instructions',
            icon: 'instructions',
            iconAccent: ACCENT.instructions,
            name: t('source.instructions'),
            sub: t('source.instructions.sub', { count: String(model.systemSections.length) }),
            value: formatNumber(instructionsTokens),
            percent: formatPercent(instructionsTokens, composed),
            accents: ACCENT.instructions,
            share: (instructionsTokens / Math.max(1, composed)) * 100,
            onClick: model.systemNode === undefined ? undefined : () => openDetail('system'),
            ariaLabel: t('detail.open.system'),
          }),
          h(Row, {
            key: 'schemas',
            icon: 'schemas',
            iconAccent: ACCENT.schemas,
            name: t('source.schemas'),
            sub: headerMissing
              ? t('source.schemas.outside')
              : t('source.schemas.sub', { count: String(model.toolCount) }),
            value: headerMissing ? '—' : formatNumber(toolsTokens),
            percent: headerMissing ? undefined : formatPercent(toolsTokens, composed),
            accents: ACCENT.schemas,
            share: headerMissing ? 0 : (toolsTokens / Math.max(1, composed)) * 100,
            onClick: () => openDetail('tools'),
            ariaLabel: t('detail.open.tools'),
          }),
          hasMcp
            ? h(Row, {
              key: 'mcp',
              indent: true,
              icon: 'mcp',
              iconAccent: ACCENT.mcp,
              name: t('source.mcp'),
              sub: model.mcpGroups.map((group) => group.server).join(', '),
              value: formatCompact(mcpTokens),
              percent: formatPercent(mcpTokens, composed),
              accents: ACCENT.mcp,
              badges: [{ label: 'MCP', accent: ACCENT.mcp }],
            })
            : null,
          h(Row, {
            key: 'skills',
            icon: 'skills',
            iconAccent: ACCENT.skills,
            name: t('source.skills'),
            sub: model.catalog === undefined
              ? t('skills.none')
              : t('source.skills.sub', { count: String(model.catalog.items.length) }),
            value: catalogTokens > 0 ? formatNumber(catalogTokens) : '—',
            percent: formatPercent(catalogTokens, composed),
            accents: ACCENT.skills,
            share: (catalogTokens / Math.max(1, composed)) * 100,
            onClick: () => openDetail('skills'),
            ariaLabel: t('detail.open.skills'),
          }),
          h(Row, {
            key: 'user',
            icon: 'user',
            iconAccent: ACCENT.user,
            name: t('source.user'),
            sub: t('source.user.sub', { count: String(model.counts.user) }),
            value: formatNumber(userOnlyTokens),
            percent: formatPercent(userOnlyTokens, composed),
            accents: ACCENT.user,
            share: (userOnlyTokens / Math.max(1, composed)) * 100,
            onClick: () => openDetail('messages'),
            ariaLabel: t('detail.open.messages'),
          }),
          h(Row, {
            key: 'assistant',
            icon: 'assistant',
            iconAccent: ACCENT.assistant,
            name: t('source.assistant'),
            sub: t('source.assistant.sub', { count: String(model.counts.assistant) }),
            value: formatNumber(model.groups.assistant),
            percent: formatPercent(model.groups.assistant, composed),
            accents: ACCENT.assistant,
            share: (model.groups.assistant / Math.max(1, composed)) * 100,
            onClick: () => openDetail('messages'),
            ariaLabel: t('detail.open.messages'),
          }),
          h(Row, {
            key: 'toolResults',
            icon: 'toolResults',
            iconAccent: ACCENT.toolResults,
            name: t('source.toolResults'),
            sub: t('source.toolResults.sub', {
              count: String(model.counts.tool),
              calls: String(model.builtinRows.concat(...model.mcpGroups.map((group) => group.rows))
                .reduce((sum, row) => sum + row.calls, 0)),
            }),
            value: formatNumber(model.groups.tool),
            percent: formatPercent(model.groups.tool, composed),
            accents: ACCENT.toolResults,
            share: (model.groups.tool / Math.max(1, composed)) * 100,
            onClick: () => openDetail('messages'),
            ariaLabel: t('detail.open.messages'),
          }),
        ]
        sections.push(h(Card, {
          key: 'distribution',
          title: t('section.distribution'),
          icon: 'instructions',
          iconAccent: ACCENT.instructions,
          total: `≈ ${formatCompact(composed)}`,
          open: openSections.distribution,
          onToggle: () => toggle('distribution'),
        },
          h(StackedTrack, { key: 'stack', segments }),
          h(Legend, { key: 'legend', segments, total: composed }),
          h('div', { className: 'ci-caption', key: 'caption' }, t('caption.share')),
          distributionRows,
          h('div', { className: 'ci-footnote', key: 'note' }, t('note.heuristics')),
        ))

        /* Tools */
        const toolWeight = (row) => row.tokens + row.resultTokens
        const sortedBuiltin = model.builtinRows.slice().sort((a, b) => toolWeight(b) - toolWeight(a))
        const visibleBuiltin = sortedBuiltin.slice(0, 8)
        const maxToolWeight = sortedBuiltin.reduce((max, row) => Math.max(max, toolWeight(row)), 0)
        const toolRow = (row, keyPrefix) => h(Row, {
          key: `${keyPrefix}:${row.name}`,
          name: row.name.startsWith('mcp__') ? row.name.slice(row.name.indexOf('__', 5) + 2) : row.name,
          sub: t('row.tool.sub', { calls: String(row.calls), results: formatCompact(row.resultTokens) })
            + (row.errors > 0 ? ` · ${t('row.tool.errors', { count: String(row.errors) })}` : ''),
          value: formatCompact(row.tokens),
          extra: row.resultTokens > 0 ? formatCompact(row.resultTokens) : '—',
          share: maxToolWeight > 0 ? (toolWeight(row) / maxToolWeight) * 100 : undefined,
          icon: row.family,
          accents: row.source.group === 'mcp' ? ACCENT.mcp : ACCENT.schemas,
          badges: row.deferred === true ? [{ label: t('badge.deferred'), quiet: true }] : undefined,
        })
        sections.push(h(Card, {
          key: 'tools',
          title: t('section.tools'),
          icon: 'schemas',
          iconAccent: ACCENT.schemas,
          total: headerMissing ? t('section.tools.outsideWindow') : `${model.toolCount} · ${formatCompact(toolsTokens)}`,
          open: openSections.tools,
          onToggle: () => toggle('tools'),
        },
          h('div', { className: 'ci-group', key: 'g-builtin' },
            h('span', undefined, t('group.builtin')),
            h('span', { className: 'ci-num' }, t('group.totals', {
              schema: formatCompact(builtinGroupTokens),
              results: formatCompact(sortedBuiltin.reduce((sum, row) => sum + row.resultTokens, 0)),
            })),
          ),
          !headerMissing && visibleBuiltin.length === 0
            ? h('div', { className: 'ci-empty', key: 'none' }, t('tools.none'))
            : null,
          headerMissing
            ? h('div', { className: 'ci-empty', key: 'outside' }, t('tools.outsideWindow'))
            : visibleBuiltin.map((row) => toolRow(row, 'builtin')),
          model.mcpGroups.map((group) => h('div', { key: `mcp-group:${group.server}` },
            h('div', { className: 'ci-group' },
              h('span', undefined, `MCP · ${group.server}`),
              h('span', { className: 'ci-num' }, t('group.totals', {
                schema: formatCompact(group.tokens),
                results: formatCompact(group.resultTokens),
              })),
            ),
            group.rows.slice().sort((a, b) => toolWeight(b) - toolWeight(a)).slice(0, 8)
              .map((row) => toolRow(row, `mcp:${group.server}`)),
          )),
          h('button', {
            key: 'open-all',
            type: 'button',
            className: 'ci-more',
            'aria-label': t('detail.open.tools'),
            onClick: () => openDetail('tools'),
          }, t('action.openAll', { count: String(model.toolCount + model.mcpGroups.length) })),
          h('div', { className: 'ci-footnote', key: 'columns' }, t('note.columns')),
        ))

        /* Skills */
        if (model.catalog !== undefined || model.skillLoads.size > 0) {
          const items = model.catalog?.items ?? []
          const maxItemTokens = items.reduce((max, item) => Math.max(max, item.tokens), 0)
          sections.push(h(Card, {
            key: 'skills',
            title: t('section.skills'),
            icon: 'skills',
            iconAccent: ACCENT.skills,
            total: t('section.skills.total', { count: String(items.length) }),
            open: openSections.skills,
            onToggle: () => toggle('skills'),
          },
            items.length === 0 ? h('div', { className: 'ci-empty', key: 'none' }, t('skills.none')) : null,
            items.slice(0, 6).map((item) => {
              const load = model.skillLoads.get(item.name)
              return h(Row, {
                key: `skill:${item.name}`,
                name: item.name,
                sub: item.description,
                value: formatCompact(item.tokens),
                share: maxItemTokens > 0 ? (item.tokens / maxItemTokens) * 100 : undefined,
                icon: 'skills',
                accents: ACCENT.skills,
                badges: load === undefined ? undefined : [{ label: t('badge.loaded'), accent: ACCENT.skills }],
              })
            }),
            h('button', {
              key: 'open-all',
              type: 'button',
              className: 'ci-more',
              'aria-label': t('detail.open.skills'),
              onClick: () => openDetail('skills'),
            }, t('action.openAll', { count: String(items.length) })),
            model.catalog !== undefined
              ? h(Row, {
                key: 'wrapper',
                indent: true,
                name: t('row.catalogWrapper'),
                sub: t('row.catalogWrapper.sub'),
                value: formatCompact(model.catalog.wrapperTokens),
                accents: ACCENT.skills,
              })
              : null,
            model.skillLoads.size > 0
              ? h('div', { className: 'ci-group', key: 'g-loaded' }, h('span', undefined, t('group.loaded')))
              : null,
            [...model.skillLoads.entries()].map(([name, load]) => h(Row, {
              key: `load:${name}`,
              indent: true,
              name,
              sub: t('row.loaded.sub', { calls: String(load.calls), tokens: formatCompact(load.tokens) }),
              value: formatCompact(load.tokens),
              accents: ACCENT.skills,
            })),
            h('div', { className: 'ci-footnote', key: 'note' }, t('note.skills')),
          ))
        }

        /* Messages */
        const messageNodes = model.nodes
          .filter((node) => node.type !== 'system/message' && node.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
        const visibleMessages = messageNodes.slice(0, 6)
        const maxMessageTokens = messageNodes.reduce((max, node) => Math.max(max, node.tokens), 0)
        sections.push(h(Card, {
          key: 'messages',
          title: t('section.messages'),
          icon: 'user',
          iconAccent: ACCENT.user,
          total: t('section.messages.total', { count: String(messageNodes.length) }),
          open: openSections.messages,
          onToggle: () => toggle('messages'),
        },
          h('div', { className: 'ci-kpis', key: 'kpis' },
            h(Kpi, { label: t('kpi.user'), value: formatCompact(model.groups.user + model.groups.developer) }),
            h(Kpi, { label: t('kpi.assistant'), value: formatCompact(model.groups.assistant) }),
            h(Kpi, { label: t('kpi.toolResults'), value: formatCompact(model.groups.tool) }),
            h(Kpi, { label: t('kpi.nodes'), value: formatNumber(model.nodes.length) }),
          ),
          visibleMessages.map((node) => h(Row, {
            key: `msg:${node.seq}`,
            name: messageTitleOf(node, t),
            sub: node.preview === '' ? t('row.message.empty') : node.preview,
            value: formatCompact(node.tokens),
            share: maxMessageTokens > 0 ? (node.tokens / maxMessageTokens) * 100 : undefined,
            icon: MESSAGE_ICON[node.type] ?? 'toolResults',
            accents: MESSAGE_ACCENT[node.type] ?? ACCENT.user,
            badges: node.isError === true
              ? [{ label: t('badge.error'), accent: 'var(--dsw-alias-state-error-primary)' }]
              : undefined,
            onClick: () => openDetail('messages'),
            ariaLabel: `${messageTitleOf(node, t)}: ${t('detail.open.messages')}`,
          })),
          h('button', {
            key: 'open-all',
            type: 'button',
            className: 'ci-more',
            'aria-label': t('detail.open.messages'),
            onClick: () => openDetail('messages'),
          }, t('action.openAll', { count: String(messageNodes.length) })),
        ))

        /* Spend */
        const cost = model.usage.cost
        sections.push(h(Card, {
          key: 'spend',
          title: t('section.spend'),
          icon: 'spend',
          iconAccent: ACCENT.spend,
          total: totalBilled > 0
            ? (cost.total > 0 ? `${formatCompact(totalBilled)} · ${formatCny(cost.total)}` : formatCompact(totalBilled))
            : undefined,
          open: openSections.spend,
          onToggle: () => toggle('spend'),
        },
          usageSource === undefined
            ? h('div', { className: 'ci-empty', key: 'none' }, t('spend.none'))
            : h('div', { className: 'ci-kpis', key: 'kpis' },
              h(Kpi, { label: t('kpi.input'), value: formatCompact(usageSource.uncachedInputTokens ?? 0), note: t('kpi.input.note') }),
              h(Kpi, {
                label: t('kpi.cache'),
                value: formatCompact(usageSource.cacheReadTokens ?? 0),
                note: cacheShare === undefined ? undefined : `${formatShare(cacheShare)} ${t('kpi.cache.note')}`,
              }),
              h(Kpi, { label: t('kpi.output'), value: formatCompact(usageSource.outputTokens ?? 0), note: t('kpi.output.note') }),
              h(Kpi, { label: t('kpi.total'), value: formatCompact(totalBilled), note: t('kpi.total.note') }),
            ),
          usageSource === undefined || cost.total <= 0
            ? null
            : h('div', { className: 'ci-group', key: 'g-money' },
              h('span', undefined, t('group.money')),
              h('span', undefined, t('group.money.note')),
            ),
          usageSource === undefined || cost.total <= 0
            ? null
            : h('div', { className: 'ci-kpis', key: 'money' },
              h(Kpi, { label: t('kpi.cost'), value: formatCny(cost.total), note: t('kpi.cost.note') }),
              h(Kpi, { label: t('kpi.cacheSaved'), value: formatCny(cost.saved), note: t('kpi.cacheSaved.note') }),
            ),
          cost.unpriced > 0
            ? h('div', { className: 'ci-notice', key: 'unpriced' }, t('notice.pricing', { model: model.model ?? t('pricing.unknownModel') }))
            : null,
          tokenUsage === undefined && usageSource !== undefined
            ? h('div', { className: 'ci-notice', key: 'fallback' }, t('notice.usageFallback'))
            : null,
          model.turns.length > 0
            ? h('div', { className: 'ci-group', key: 'g-turns' },
              h('span', undefined, t('group.turns')),
              h('span', undefined, t('group.turns.note')),
            )
            : null,
          model.turns.slice(-6).reverse().map((turn) => h(Row, {
            key: `turn:${turn.turn}`,
            name: t('row.turn', { turn: String(turn.turn) }),
            sub: t('row.turn.sub', {
              steps: String(turn.steps),
              prompt: formatCompact(turn.prompt),
              output: formatCompact(turn.output),
              cache: turn.cacheRead + turn.input > 0
                ? formatShare((turn.cacheRead / (turn.cacheRead + turn.input)) * 100)
                : '—',
            }),
            value: formatCompact(turn.output),
            icon: 'spend',
            accents: ACCENT.spend,
          })),
          model.turns.length > 0
            ? h('button', {
              key: 'open-all',
              type: 'button',
              className: 'ci-more',
              'aria-label': t('detail.open.spend'),
              onClick: () => openDetail('spend'),
            }, t('action.openAll', { count: String(model.turns.length) }))
            : null,
          h('div', { className: 'ci-footnote', key: 'note' }, t('note.spend')),
          cost.total > 0
            ? h('div', { className: 'ci-footnote', key: 'note-cost' }, t('note.cost'))
            : null,
        ))

        sections.push(h('div', { className: 'ci-footnote', key: 'source' }, t('note.source')))

        /* Detail sheet */
        const detailContent = detail === undefined ? null : detail === 'system'
          ? SystemDetail({
            model,
            systemTokens,
            composed,
            t,
            expanded: expandedSections,
            onToggleSection: (index) => {
              setExpandedSections((current) => ({ ...current, [index]: current[index] === false }))
            },
          })
          : detail === 'tools'
            ? ToolsDetail({ model, toolsTokens, t })
            : detail === 'skills'
              ? SkillsDetail({ model, t })
              : detail === 'messages'
                ? MessagesDetail({
                model,
                t,
                expandedMessages,
                onToggleMessage: toggleMessage,
              })
                : SpendDetail({ model, usageSource, cacheShare, totalBilled, t })

        const detailTitle = detail === undefined ? '' : {
          system: t('detail.system.title'),
          tools: t('detail.tools.title'),
          skills: t('detail.skills.title'),
          messages: t('detail.messages.title'),
          spend: t('detail.spend.title'),
        }[detail]

        return h('div', { className: 'ci-root' },
          h('style', { 'data-context-inspector': '' }, CSS),
          h('div', { className: 'ci-scroll' }, sections),
          detail === undefined ? null : h('div', {
            className: 'ci-sheet',
            ref: sheetRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': detailTitle,
          },
            h('div', { className: 'ci-sheet-head' },
              h('button', {
                type: 'button',
                className: 'ci-sheet-back',
                ref: backRef,
                onClick: () => closeDetail(),
              }, h(IconBack, { size: 14 }), t('detail.back')),
              h('span', { className: 'ci-sheet-title' }, detailTitle),
            ),
            h('div', { className: 'ci-sheet-body' }, detailContent),
          ),
        )
      }

      return Panel
    }

    /* ------------------------------------------------------------------ *
     * Copy
     * ------------------------------------------------------------------ */

    const en = {
      'title': 'Context',
      'description': 'Context composition and token spend',
      'hero.label': 'Used of model window',
      'hero.free': '{value} free',
      'hero.noWindow': 'window unknown',
      'hero.noData': 'no prompt data yet',
      'hero.valueText': '{used} of {capacity} tokens',
      'hero.nearlyFull': 'nearly full',
      'hero.projected': 'next request ≈ {value}',
      'hero.composed': 'composition ≈ {value}',
      'caption.share': 'Share of the estimated composition',
      'notice.window': 'Only the loaded history window is folded: older turns and their tool results are not counted.',
      'notice.header': 'The request header lies outside the loaded window, so the tool list below is incomplete.',
      'notice.usageFallback': 'The token-meter projections are not served here, so these figures cover the loaded window only.',
      'section.distribution': 'Context distribution',
      'section.tools': 'Tools',
      'section.tools.outsideWindow': 'outside window',
      'section.skills': 'Skills',
      'section.skills.total': '{count} entries',
      'section.messages': 'Messages',
      'section.messages.total': '{count} nodes',
      'section.spend': 'Token spend',
      'source.instructions': 'Instructions',
      'source.instructions.sub': '{count} fragments',
      'source.schemas': 'Tool schemas',
      'source.schemas.sub': '{count} declared',
      'source.schemas.outside': 'header outside the loaded window',
      'source.mcp': 'MCP tools',
      'source.skills': 'Skill catalog',
      'source.skills.sub': '{count} entries',
      'source.user': 'Your messages',
      'source.user.sub': '{count} messages',
      'source.assistant': 'Model answers',
      'source.assistant.sub': '{count} answers',
      'source.toolResults': 'Tool results',
      'source.toolResults.sub': '{count} results · {calls} calls',
      'row.tool.sub': '{calls} calls · results {results}',
      'row.tool.errors': '{count} errors',
      'row.catalogWrapper': 'Catalog framing',
      'row.catalogWrapper.sub': 'instructions around the skill list',
      'row.loaded.sub': '{calls} loads · {tokens} returned',
      'row.message.user': 'Your message',
      'row.message.system': 'System prompt',
      'row.message.developer': 'Runtime context',
      'row.message.assistant': 'Model answer',
      'row.message.tool': 'Tool result',
      'row.message.toolNamed': '{name} result',
      'row.message.empty': 'empty content',
      'row.message.turn': 'turn {turn}',
      'row.turn': 'Turn {turn}',
      'row.turn.sub': '{steps} steps · prompt {prompt} · output {output} · cache {cache}',
      'row.cacheWrite': 'Cache writes',
      'group.builtin': 'Built-in',
      'group.loaded': 'Loaded through the skill tool',
      'group.turns': 'By turn',
      'group.turns.note': 'output tokens',
      'group.totals': 'schema {schema} · results {results}',
      'badge.deferred': 'deferred',
      'badge.loaded': 'loaded',
      'badge.error': 'error',
      'kpi.user': 'Your messages',
      'kpi.assistant': 'Model answers',
      'kpi.toolResults': 'Tool results',
      'kpi.nodes': 'Surface nodes',
      'kpi.input': 'Uncached input',
      'kpi.input.note': 'billed anew',
      'kpi.cache': 'Cache read',
      'kpi.cache.note': 'reused',
      'kpi.output': 'Output',
      'kpi.output.note': 'generated',
      'kpi.total': 'Total tokens',
      'kpi.total.note': 'input + cache + output',
      'kpi.cost': 'Session cost',
      'kpi.cost.note': 'list price',
      'kpi.cacheSaved': 'Saved by cache',
      'kpi.cacheSaved.note': 'against a cache miss',
      'group.money': 'Cost, yuan',
      'group.money.note': 'peak / off-peak by request time',
      'group.turns.cost': 'output tokens · cost',
      'pricing.cacheHit': 'Cache hit',
      'pricing.cacheMiss': 'Cache miss and write',
      'pricing.output': 'Output',
      'pricing.perMillion': '¥ per 1M tokens',
      'pricing.columns': 'peak / off-peak',
      'pricing.unknownModel': 'unknown model',
      'detail.pricing.title': 'Cost, yuan',
      'detail.pricing.model': 'Model {model} · DeepSeek list price',
      'detail.pricing.note': 'Peak is Beijing time, Monday to Friday, 09:00-12:00 and 14:00-18:00, at the full rate; every other hour, weekends and Chinese public holidays bill at half. Holidays are not modelled here, and a cache write bills as a cache miss.',
      'notice.pricing': 'No published price for {model}, so the cost stays empty.',
      'note.cost': 'Priced per request at the rate of its own hour, from the same provider usage; yuan, on the DeepSeek price list.',
      'note.heuristics': 'Estimated at four characters per token plus block framing — the same heuristic the host uses for its own composition figures, not a provider tokenizer.',
      'note.skills': 'Catalog cost is what the skill list adds to every request; loads are the result tokens each loaded skill returned.',
      'note.spend': 'Provider-reported usage over the complete session log. Cache reads are reuse, not new input.',
      'note.columns': 'Columns: declaration tokens, then the tokens its results put into the context.',
      'note.source': 'Folded from this session log and the token-meter projections. Nothing leaves the browser.',
      'tools.none': 'No tool declarations in this request.',
      'tools.outsideWindow': 'The request header is not in the loaded window, so the declared tool list is unknown.',
      'skills.none': 'No skill catalog in this session.',
      'spend.none': 'No provider usage has been reported for this session yet.',
      'empty.title': 'Nothing to measure yet',
      'empty.body': 'The panel fills in as soon as the session logs its first request.',
      'action.openAll': 'Open all {count}',
      'unit.tokens': 'tokens',
      'detail.back': 'Back',
      'detail.copy': 'Copy',
      'detail.copied': 'Copied',
      'detail.expand': 'Show more',
      'detail.compact': 'Collapse',
      'detail.open.system': 'Open the full system prompt',
      'detail.open.tools': 'Open all tool definitions',
      'detail.open.skills': 'Open the skill catalog',
      'detail.open.messages': 'Open all messages',
      'detail.open.spend': 'Open all turns',
      'detail.system.title': 'System prompt',
      'detail.system.tokens': 'Tokens',
      'detail.system.share': 'Of context',
      'detail.system.parts': 'Fragments',
      'detail.system.chars': 'Characters',
      'detail.system.part': 'Fragment {index}',
      'detail.system.empty': 'This session has no system prompt in its surface.',
      'detail.system.note': 'The prompt is one text; its fragments are the paragraphs it is assembled from, priced by the same heuristic in heaviest-first order.',
      'detail.tools.title': 'Tool definitions',
      'detail.tools.count': 'Tools',
      'detail.tools.schema': 'Schema tokens',
      'detail.tools.results': 'Result tokens',
      'detail.tools.mcp': 'MCP servers',
      'detail.skills.title': 'Skill catalog',
      'detail.skills.count': 'Entries',
      'detail.skills.catalog': 'Catalog tokens',
      'detail.skills.framing': 'Framing',
      'detail.skills.loaded': 'Loaded',
      'detail.messages.title': 'Messages',
      'detail.messages.note': 'Every model-visible node, heaviest first. System prompts and catalog entries appear in their own rows too.',
      'detail.messages.capped': 'Showing the heaviest {count} nodes.',
      'detail.message.show': 'show content',
      'detail.message.hide': 'hide content',
      'detail.message.chars': '{count} characters',
      'detail.message.truncated': 'showing {shown} of {total} characters',
      'detail.spend.title': 'Token spend',
    }

    const ru = {
      'title': 'Контекст',
      'description': 'Состав контекста и расход токенов',
      'hero.label': 'Занято в окне модели',
      'hero.free': 'свободно {value}',
      'hero.noWindow': 'окно неизвестно',
      'hero.noData': 'данных о промпте ещё нет',
      'hero.valueText': '{used} из {capacity} токенов',
      'hero.nearlyFull': 'почти полно',
      'hero.projected': 'следующий запрос ≈ {value}',
      'hero.composed': 'состав ≈ {value}',
      'caption.share': 'Доля от оценки состава',
      'notice.window': 'Считается только загруженное окно истории: более ранние ходы и их результаты инструментов не учтены.',
      'notice.header': 'Заголовок запроса вне загруженного окна — список инструментов ниже неполный.',
      'notice.usageFallback': 'Проекции token-meter здесь не подключены, поэтому цифры расхода относятся только к загруженному окну.',
      'section.distribution': 'Распределение контекста',
      'section.tools': 'Инструменты',
      'section.tools.outsideWindow': 'вне окна',
      'section.skills': 'Навыки',
      'section.skills.total': 'записей: {count}',
      'section.messages': 'Сообщения',
      'section.messages.total': 'узлов: {count}',
      'section.spend': 'Расход токенов',
      'source.instructions': 'Инструкции',
      'source.instructions.sub': 'фрагментов: {count}',
      'source.schemas': 'Схемы инструментов',
      'source.schemas.sub': 'объявлено: {count}',
      'source.schemas.outside': 'заголовок вне окна',
      'source.mcp': 'Инструменты MCP',
      'source.skills': 'Каталог навыков',
      'source.skills.sub': 'записей: {count}',
      'source.user': 'Ваши сообщения',
      'source.user.sub': 'сообщений: {count}',
      'source.assistant': 'Ответы модели',
      'source.assistant.sub': 'ответов: {count}',
      'source.toolResults': 'Результаты инструментов',
      'source.toolResults.sub': 'результатов: {count} · вызовов: {calls}',
      'row.tool.sub': 'вызовов {calls} · результаты {results}',
      'row.tool.errors': 'ошибок {count}',
      'row.catalogWrapper': 'Обвязка каталога',
      'row.catalogWrapper.sub': 'инструкции вокруг списка навыков',
      'row.loaded.sub': 'загрузок {calls} · вернули {tokens}',
      'row.message.user': 'Ваше сообщение',
      'row.message.system': 'Системный промпт',
      'row.message.developer': 'Контекст среды',
      'row.message.assistant': 'Ответ модели',
      'row.message.tool': 'Результат инструмента',
      'row.message.toolNamed': 'Результат · {name}',
      'row.message.empty': 'пустое содержимое',
      'row.message.turn': 'ход {turn}',
      'row.turn': 'Ход {turn}',
      'row.turn.sub': 'шагов {steps} · промпт {prompt} · ответ {output} · кэш {cache}',
      'row.cacheWrite': 'Запись в кэш',
      'group.builtin': 'Встроенные',
      'group.loaded': 'Загружено через инструмент skill',
      'group.turns': 'По ходам',
      'group.turns.note': 'токены ответа',
      'group.totals': 'схема {schema} · результаты {results}',
      'badge.deferred': 'отложен',
      'badge.loaded': 'загружен',
      'badge.error': 'ошибка',
      'kpi.user': 'Ваши сообщения',
      'kpi.assistant': 'Ответы модели',
      'kpi.toolResults': 'Результаты',
      'kpi.nodes': 'Узлов в контексте',
      'kpi.input': 'Вход без кэша',
      'kpi.input.note': 'оплачено заново',
      'kpi.cache': 'Чтение кэша',
      'kpi.cache.note': 'переиспользовано',
      'kpi.output': 'Выход',
      'kpi.output.note': 'сгенерировано',
      'kpi.total': 'Сумма токенов',
      'kpi.total.note': 'вход + кэш + выход',
      'kpi.cost': 'Стоимость сессии',
      'kpi.cost.note': 'по прайсу',
      'kpi.cacheSaved': 'Сэкономил кэш',
      'kpi.cacheSaved.note': 'против промаха',
      'group.money': 'Стоимость, юани',
      'group.money.note': 'пик / не пик по времени запроса',
      'group.turns.cost': 'токены ответа · стоимость',
      'pricing.cacheHit': 'Кэш-хит',
      'pricing.cacheMiss': 'Кэш-мисс и запись',
      'pricing.output': 'Выход',
      'pricing.perMillion': '¥ за 1M токенов',
      'pricing.columns': 'пик / не пик',
      'pricing.unknownModel': 'неизвестная модель',
      'detail.pricing.title': 'Стоимость, юани',
      'detail.pricing.model': 'Модель {model} · прайс DeepSeek',
      'detail.pricing.note': 'Пик — Пекин, пн–пт 09:00–12:00 и 14:00–18:00, полная ставка; остальное время, выходные и праздники КНР — вдвое дешевле. Праздники здесь не учитываются, запись в кэш считается как промах.',
      'notice.pricing': 'Опубликованной цены для {model} нет, поэтому стоимость не считается.',
      'note.cost': 'Стоимость — по каждому запросу по ставке его часа, из тех же данных провайдера; юани, по прайсу DeepSeek.',
      'note.heuristics': 'Оценка: четыре символа на токен плюс структурная обвязка блоков — та же эвристика, что у хоста, а не токенизатор провайдера.',
      'note.skills': 'Стоимость каталога — это то, что список навыков добавляет в каждый запрос; загрузки — сколько токенов вернул загруженный навык.',
      'note.spend': 'Данные провайдера по всему логу сессии. Чтение кэша — переиспользование, а не новый вход.',
      'note.columns': 'Столбцы: токены объявления, затем токены, которые его результаты внесли в контекст.',
      'note.source': 'Считается по логу этой сессии и проекциям token-meter. Ничего не покидает браузер.',
      'tools.none': 'В этом запросе нет объявленных инструментов.',
      'tools.outsideWindow': 'Заголовок запроса не попал в загруженное окно, поэтому список объявленных инструментов неизвестен.',
      'skills.none': 'В этой сессии нет каталога навыков.',
      'spend.none': 'Провайдер ещё не сообщал расход по этой сессии.',
      'empty.title': 'Пока нечего измерять',
      'empty.body': 'Панель заполнится, как только сессия запишет первый запрос.',
      'action.openAll': 'Открыть все ({count})',
      'unit.tokens': 'токенов',
      'detail.back': 'Назад',
      'detail.copy': 'Скопировать',
      'detail.copied': 'Скопировано',
      'detail.expand': 'Развернуть',
      'detail.compact': 'Свернуть',
      'detail.open.system': 'Открыть системный промпт целиком',
      'detail.open.tools': 'Открыть все определения инструментов',
      'detail.open.skills': 'Открыть каталог навыков',
      'detail.open.messages': 'Открыть все сообщения',
      'detail.open.spend': 'Открыть все ходы',
      'detail.system.title': 'Системный промпт',
      'detail.system.tokens': 'Токенов',
      'detail.system.share': 'Доля контекста',
      'detail.system.parts': 'Фрагментов',
      'detail.system.chars': 'Символов',
      'detail.system.part': 'Фрагмент {index}',
      'detail.system.empty': 'В этой сессии в контексте нет системного промпта.',
      'detail.system.note': 'Промпт — один текст; его фрагменты — абзацы, из которых он собран, оценённые той же эвристикой и отсортированные по весу.',
      'detail.tools.title': 'Определения инструментов',
      'detail.tools.count': 'Инструментов',
      'detail.tools.schema': 'Токены схем',
      'detail.tools.results': 'Токены результатов',
      'detail.tools.mcp': 'MCP-серверов',
      'detail.skills.title': 'Каталог навыков',
      'detail.skills.count': 'Записей',
      'detail.skills.catalog': 'Токены каталога',
      'detail.skills.framing': 'Обвязка',
      'detail.skills.loaded': 'Загружено',
      'detail.messages.title': 'Сообщения',
      'detail.messages.note': 'Все видимые модели узлы, самые тяжёлые сверху. Системный промпт и записи каталога видны и в своих строках.',
      'detail.messages.capped': 'Показаны самые тяжёлые {count} узлов.',
      'detail.message.show': 'показать содержимое',
      'detail.message.hide': 'скрыть содержимое',
      'detail.message.chars': '{count} символов',
      'detail.message.truncated': 'показано {shown} из {total} символов',
      'detail.spend.title': 'Расход токенов',
    }

    /* ------------------------------------------------------------------ *
     * Guide card glyph — the panel's own artwork, no primitive imports
     * ------------------------------------------------------------------ */

    function GuideGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 20,
        height: 20,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('path', { d: 'M4 19V10M9 19V5M14 19v-6M19 19v-9' }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    if (globalThis.__CONTEXT_INSPECTOR_TEST__ === true) {
      globalThis.__contextInspectorInternals__ = {
        analyze,
        durableSignature,
        priceMessage,
        priceToolSchemas,
        priceUsageReport,
        priceListFor,
        isPeakHour,
        formatCny,
      }
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'context-inspector: copy')

        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('title'),
          guide: [{
            id: 'context',
            order: 40,
            title: () => t('title'),
            description: () => t('description'),
            icon: GuideGlyph,
          }],
        }), 'context-inspector: tab type')

        const Panel = createPanel(ctx)

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, Panel)), 'context-inspector: tab body')
      },
    }
  },
})
