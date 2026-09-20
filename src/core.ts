/**
 * Usage-aggregation and formatting logic for the token-tracker footer.
 *
 * Pure module with no plugin entrypoint: only `src/index.ts` (`.`) and
 * `src/tui.tsx` (`./tui`) are package entries, so this file is never probed
 * as a plugin by OpenCode's flat-file discovery.
 *
 * V2 note: message telemetry is described with local structural types instead
 * of an SDK import. V2 session messages (`SessionMessageInfo`) are a union
 * discriminated by `type` (assistant messages carry `type: "assistant"`,
 * optional `cost`, and optional `tokens`), so the aggregation filters on
 * `type` rather than the V1 `role` field. Callers adapt client messages to
 * `MessageWithTelemetry` (see `src/tui.tsx`).
 */

export type RecordedTokenTelemetry = {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: {
    read?: unknown
    write?: unknown
  }
}

export type MessageWithTelemetry = {
  id: string
  type: string
  cost?: unknown
  tokens?: RecordedTokenTelemetry
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

export type SessionChild = {
  id: string
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

const numberOrZero = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

const addMessage = (usage: UsageTotals, message: MessageWithTelemetry): void => {
  const tokens = message.tokens
  usage.input += numberOrZero(tokens?.input)
  usage.output += numberOrZero(tokens?.output)
  usage.reasoning += numberOrZero(tokens?.reasoning)
  usage.cacheRead += numberOrZero(tokens?.cache?.read)
  usage.cacheWrite += numberOrZero(tokens?.cache?.write)
  usage.cost += numberOrZero(message.cost)
  usage.providerRequests += 1
}

/** Aggregate only recorded assistant telemetry, deduplicated by message ID. */
export function aggregateRecordedMessages(messages: ReadonlyArray<MessageWithTelemetry>): UsageTotals {
  const usage = emptyUsage()
  const messageIDs = new Set<string>()

  for (const message of messages) {
    if (message.type !== "assistant" || messageIDs.has(message.id)) continue
    messageIDs.add(message.id)
    addMessage(usage, message)
  }

  return usage
}

/** Discover and aggregate the root session and every reachable child session. */
export async function collectSessionTreeUsage(
  rootSessionID: string,
  readChildren: (sessionID: string) => Promise<ReadonlyArray<SessionChild>>,
  readMessages: (sessionID: string) => ReadonlyArray<MessageWithTelemetry>,
): Promise<SessionTreeUsage> {
  const sessionIDs: string[] = []
  const discovered = new Set<string>()
  const scheduled = new Set<string>([rootSessionID])
  const pending = [rootSessionID]

  while (pending.length > 0) {
    const sessionID = pending.pop()
    if (sessionID === undefined || discovered.has(sessionID)) continue

    discovered.add(sessionID)
    sessionIDs.push(sessionID)

    for (const child of await readChildren(sessionID)) {
      if (typeof child?.id === "string" && child.id.length > 0 && !scheduled.has(child.id)) {
        scheduled.add(child.id)
        pending.push(child.id)
      }
    }
  }

  const messagesBySession = sessionIDs.map(sessionID => readMessages(sessionID))
  return {
    root: aggregateRecordedMessages(messagesBySession[0] ?? []),
    tree: aggregateRecordedMessages(messagesBySession.flat()),
    sessionIDs,
  }
}
