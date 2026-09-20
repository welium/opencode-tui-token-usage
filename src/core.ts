/**
 * Usage-aggregation and formatting logic for the token-tracker footer.
 *
 * Pure module with no plugin entrypoint: only `src/index.ts` (`.`) and
 * `src/tui.tsx` (`./tui`) are package entries, so this file is never probed
 * as a plugin by OpenCode's flat-file discovery.
 *
 * V2 note: telemetry is session-level, not message-level. V2 session
 * messages carry no `tokens`/`cost` fields, so per-message aggregation
 * always yields zero. Totals are summed from each family member's
 * `SessionInfo.tokens`/`cost` instead; only the request count still comes
 * from the message list (assistant message count per session).
 */

export type SessionTokenSnapshot = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type FamilySessionUsage = {
  readonly id: string
  readonly tokens: SessionTokenSnapshot
  readonly cost: number
  readonly requests: number
}

export type UsageTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  providerRequests: number
}

export type SessionTreeUsage = {
  root: UsageTotals
  tree: UsageTotals
  sessionIDs: readonly string[]
}

export type UsageLayout = "primary" | "narrow"

export type UsageSegmentTone = "label" | "metric" | "value" | "separator"

export type UsageSegment = {
  readonly text: string
  readonly tone: UsageSegmentTone
}

export type UsageLine = readonly UsageSegment[]

/**
 * Return the fraction of recorded prompt tokens served from cache.
 *
 * `input` is the non-cached prompt-token count, so cache writes are not part
 * of the denominator: cacheRead / (input + cacheRead). A tree with no
 * recorded prompt tokens has a zero hit rate.
 */
export function cacheHitRate(usage: UsageTotals): number {
  const promptTokens = usage.input + usage.cacheRead
  return promptTokens > 0 ? usage.cacheRead / promptTokens : 0
}

export const formatTokenCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return `${value}`
}

export const formatCost = (value: number): string => {
  if (value === 0) return "$0"
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(3)}`
  if (value >= 0.001) return `$${value.toFixed(4)}`
  return "<$0.001"
}

const formatCacheHitRate = (usage: UsageTotals): string => `${(cacheHitRate(usage) * 100).toFixed(1)}%`

const separator = (): UsageSegment => ({ text: " · ", tone: "separator" })
const metric = (text: string): UsageSegment => ({ text, tone: "metric" })
const value = (text: string): UsageSegment => ({ text, tone: "value" })
const label = (text: string): UsageSegment => ({ text, tone: "label" })

const metricValue = (amount: number, name: string): UsageLine => [value(formatTokenCount(amount)), metric(` ${name}`)]

const lineText = (line: UsageLine): string => line.map(segment => segment.text).join("")

const joinMetrics = (metrics: ReadonlyArray<UsageLine>): UsageLine =>
  metrics.flatMap((current, index) => (index === 0 ? current : [separator(), ...current]))

const continuation = (content: UsageLine): UsageLine => [label("       "), ...content]

const optionalMetrics = (usage: UsageTotals): UsageLine[] => {
  const metrics: UsageLine[] = []
  if (usage.reasoning !== 0) metrics.push(metricValue(usage.reasoning, "think"))
  if (usage.cacheWrite !== 0) metrics.push(metricValue(usage.cacheWrite, "write"))
  return metrics
}

const sectionLines = (name: "MAIN" | "TOT ", usage: UsageTotals, layout: UsageLayout, width: number): UsageLine[] => {
  const firstMetric = layout === "primary" ? joinMetrics([metricValue(usage.input, "in"), metricValue(usage.output, "out")]) : metricValue(usage.input, "in")
  const firstLine: UsageLine = [label(`${name}   `), ...firstMetric]
  const cacheLine = metricValue(usage.cacheRead, "cache")
  const optional = optionalMetrics(usage)
  const cacheAndOptional = joinMetrics([cacheLine, ...optional])
  const rows: UsageLine[] = [firstLine, continuation(cacheLine)]

  if (optional.length > 0 && lineText(continuation(cacheAndOptional)).length <= width) {
    rows[1] = continuation(cacheAndOptional)
  } else {
    rows.push(...optional.map(item => continuation(item)))
  }

  if (layout === "narrow") rows.push(continuation(metricValue(usage.output, "out")))
  return rows
}

const summaryLines = (usage: SessionTreeUsage): UsageLine[] => [
  [
    value(`${usage.tree.providerRequests}`),
    metric(" req"),
    separator(),
    value(`${Math.max(0, usage.sessionIDs.length - 1)}`),
    metric(" agents"),
  ],
  [value(formatCacheHitRate(usage.tree)), metric(" hit"), separator(), value(formatCost(usage.tree.cost))],
]

const layoutLines = (usage: SessionTreeUsage, layout: UsageLayout, width: number): UsageLine[] => [
  ...sectionLines("MAIN", usage.root, layout, width),
  ...sectionLines("TOT ", usage.tree, layout, width),
  ...summaryLines(usage),
]

export function selectUsageLayout(usage: SessionTreeUsage, width: number): UsageLayout {
  const normalizedWidth = Math.max(1, Math.floor(width))
  const primary = layoutLines(usage, "primary", normalizedWidth)
  return primary.every(line => lineText(line).length <= normalizedWidth) ? "primary" : "narrow"
}

/**
 * Format the sidebar snapshot as styled text segments. Every emitted row is
 * measured before it is returned, so the TUI never has to wrap a metric.
 */
export function formatUsageSegments(usage: SessionTreeUsage, width = 48): readonly UsageLine[] {
  const normalizedWidth = Math.max(1, Math.floor(width))
  const layout = selectUsageLayout(usage, normalizedWidth)
  return layoutLines(usage, layout, normalizedWidth)
}

/**
 * Format the sidebar snapshot into short lines without dropping any metric.
 */
export function formatUsageLines(usage: SessionTreeUsage, width = 48): readonly string[] {
  return formatUsageSegments(usage, width).map(lineText)
}

const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  providerRequests: 0,
})

const emptyTokens = (): SessionTokenSnapshot => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

export const emptySession = (id: string): FamilySessionUsage => ({
  id,
  tokens: emptyTokens(),
  cost: 0,
  requests: 0,
})

const numberOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

/** Sum session-level telemetry across family members. */
export function totalsFromFamily(sessions: ReadonlyArray<FamilySessionUsage>): UsageTotals {
  const usage = emptyUsage()

  for (const session of sessions) {
    usage.input += numberOrZero(session.tokens?.input)
    usage.output += numberOrZero(session.tokens?.output)
    usage.reasoning += numberOrZero(session.tokens?.reasoning)
    usage.cacheRead += numberOrZero(session.tokens?.cacheRead)
    usage.cacheWrite += numberOrZero(session.tokens?.cacheWrite)
    usage.cost += numberOrZero(session.cost)
    usage.providerRequests += numberOrZero(session.requests)
  }

  return usage
}

/** Split family snapshots into root-only and whole-tree totals. */
export function sessionTreeUsage(
  rootSessionID: string,
  sessions: ReadonlyArray<FamilySessionUsage>,
): SessionTreeUsage {
  const root = sessions.find(session => session.id === rootSessionID)
  return {
    root: totalsFromFamily(root === undefined ? [] : [root]),
    tree: totalsFromFamily(sessions),
    sessionIDs: sessions.map(session => session.id),
  }
}
