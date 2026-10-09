import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Credit, Snapshot } from '../types'

const PANE = 'hud'
const snapshot = atom({ plugin: 'hud', key: 'snapshot' } as const, null)

const WARN = 80
const BAR = 16
const REFRESH_MS = 60_000

let credit: Credit | null = null
let fetchedAt = 0

const kilo = (n: number) => {
  const k = Math.round(n / 100) / 10
  if (n >= 999_950) {
    return `${Math.round(n / 100_000) / 10}M`
  }
  return n >= 1000 ? `${k}k` : String(n)
}
const bar = (p: number) => {
  const f = Math.max(0, Math.min(BAR, Math.round((p / 100) * BAR)))
  return { on: '█'.repeat(f), off: '░'.repeat(BAR - f) }
}
const tone = (p: number) => (p >= 90 ? 'red' : p >= WARN ? 'yellow' : 'green')
const money = (n: number) => `$${n.toFixed(2)}`
const label = (k: string) =>
  k === 'five_hour' ? '5h window' : k === 'seven_day' ? '7d week' : k === 'spend_limit' ? 'Credit' : k

const take = (
  e: {
    context: { tokens?: number; window: number; percent?: number }
    rateLimits: { kind: string; percentUsed: number }[]
    cost?: { usd: number }
  },
  extra: Credit | null,
  prev?: Snapshot | null,
): Snapshot => ({
  credit: extra,
  tokens: e.context.tokens ?? null,
  window: e.context.window,
  percent: e.context.percent ?? null,
  limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
  // usage of each window when this session first saw it; a window that renewed (value dropped) restarts from 0
  base: e.rateLimits.map(l => {
    const start = prev?.base?.find(b => b.kind === l.kind)?.percentUsed ?? l.percentUsed
    return { kind: l.kind, percentUsed: l.percentUsed < start ? 0 : start }
  }),
  usd: e.cost?.usd ?? null,
})

const safe = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch {
    // tracking must never break the tool call
  }
}

// Same figures /usage shows; the credential never leaves the host.
async function loadCredit($) {
  const auth = await $.session.authorize()
  if (!auth) {
    return
  }
  const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (!res.ok) {
    return
  }
  const spend = JSON.parse(res.text)?.spend
  if (spend?.used && spend?.limit) {
    const div = 10 ** (spend.limit.exponent ?? 2)
    credit = { used: spend.used.amount_minor / div, limit: spend.limit.amount_minor / div, currency: spend.limit.currency }
  }
}

async function refresh($) {
  const now = Date.now()
  if (now - fetchedAt >= REFRESH_MS) {
    fetchedAt = now
    await safe(() => loadCredit($))
  }
  const usage = await $.session.usage()
  await update($, snapshot, prev => take(usage, credit, prev))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hud', description: 'Open the usage and context panel' })
    await safe(() => refresh($))
    void $.ui.open({ id: PANE, title: 'HUD' })

    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    await $.ui.open({ id: PANE, title: 'HUD' })

    return { text: 'HUD opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, prev => take(e, credit, prev))
    void safe(() => refresh($))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)

    const Meter = ({ percent }: { percent: number }) => {
      const b = bar(percent)
      return (
        <Text>
          <Text color={tone(percent)}>{b.on}</Text>
          <Text dimColor>{b.off}</Text>
          <Text bold color={tone(percent)}> {Math.round(percent)}%</Text>
        </Text>
      )
    }

    const Card = ({ title, color, right, children }: { title: string; color: string; right?: string; children: unknown }) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
        <Box width="100%">
          <Box flexGrow={1}>
            <Text bold color={color}>
              {title}
            </Text>
          </Box>
          {right && <Text dimColor>{right}</Text>}
        </Box>
        {children}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Card title="◉ CONTEXT" color="cyan">
          {s?.percent != null ? (
            <Box flexDirection="column">
              <Meter percent={s.percent} />
              <Text dimColor>
                {s.tokens != null ? kilo(s.tokens) : '?'} of {kilo(s.window)} tokens
              </Text>
            </Box>
          ) : (
            <Text dimColor>waiting for first measurement…</Text>
          )}
        </Card>

        <Card title="◆ SESSION" color="magenta">
          <Text bold color="green">
            {s?.usd != null ? money(s.usd) : '—'}
          </Text>
          <Text dimColor>spent this session</Text>
          {(s?.limits ?? []).map(l => {
            const used = Math.max(0, l.percentUsed - (s?.base?.find(b => b.kind === l.kind)?.percentUsed ?? l.percentUsed))
            return (
              <Text key={l.kind}>
                <Text dimColor>{label(l.kind)}: </Text>
                <Text bold color={tone(used * 4)}>
                  +{used.toFixed(used < 10 ? 1 : 0)}%
                </Text>
              </Text>
            )
          })}
        </Card>

        <Card
          title="◈ CREDIT"
          color="yellow"
        >
          {s?.credit != null && (
            <Box flexDirection="column">
              <Meter percent={(s.credit.used / s.credit.limit) * 100} />
              <Text>
                <Text bold color={tone((s.credit.used / s.credit.limit) * 100)}>
                  {money(s.credit.limit - s.credit.used)}
                </Text>
                <Text dimColor> left of {money(s.credit.limit)}</Text>
              </Text>
              <Text dimColor>month: {money(s.credit.used)} used</Text>
            </Box>
          )}
          {(s?.limits ?? []).map(l => (
            <Box key={l.kind} flexDirection="column">
              <Box width="100%">
                <Text dimColor>{label(l.kind)}</Text>
              </Box>
              <Meter percent={l.percentUsed} />
            </Box>
          ))}
          {s?.credit == null && (s?.limits ?? []).length === 0 && <Text dimColor>no limit data</Text>}
        </Card>

      </Box>
    )
  })
}
