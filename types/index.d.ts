export type Limit = { kind: string; percentUsed: number }
export type Credit = { used: number; limit: number; currency: string }
export type Snapshot = {
  credit: Credit | null
  tokens: number | null
  window: number
  percent: number | null
  limits: Limit[]
  base: Limit[]
  usd: number | null
}
export type Status = 'pending' | 'in_progress' | 'completed'
export type Item = { id: string; text: string; status: Status }

declare module 'claude-code' {
  interface PluginState {
    hud: { snapshot: Snapshot | null }
  }
}
