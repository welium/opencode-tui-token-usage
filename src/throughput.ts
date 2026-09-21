/**
 * Live token-throughput tracking for the token-tracker footer.
 *
 * Design reference: `npm:pi-live-throughput` as used in the Pi coding agent.
 * While an assistant response streams, the footer shows a rolling rate,
 * average rate, estimated output tokens, and elapsed time, laid out as a
 * labeled section that mirrors the MAIN/TOT blocks in core.ts:
 *
 *   `⚡       ~92.3 tok/s · avg 84.5`
 *   `       ~1.2k tok · 14.2s`
 *
 * When streaming finishes, the live lines are replaced with a final summary
 * that stays visible until the next response starts:
 *
 *   `✓        512 tok · 120 tok/s avg`
 *   `       peak 319 tok/s · 4.2s`
 *   `       TTFT 420ms · input 1.2k tok`
 *
 * OpenCode adaptation notes (vs Pi):
 * - Pi prefers cumulative provider-reported `usage.output` while streaming
 *   and falls back to a chars/4 heuristic. OpenCode only exposes provider
 *   token counts at step boundaries (`session.step.ended`), never during
 *   the stream, so all live figures are heuristic estimates (chars/4 over
 *   text, reasoning, and tool-input deltas), labeled `est.`/`~` per Pi's
 *   fallback convention. The final summary always uses provider-reported
 *   step tokens.
 * - Pi measures TTFT from `before_provider_request` to first output. Here
 *   TTFT is measured from `session.execution.started` (fallback:
 *   `session.step.started`) to the first substantive delta, using local
 *   receipt timestamps throughout so the window is self-consistent.
 * - Throughput measurement starts only after a second output token has
 *   been observed, so TTFT never dilutes rolling/average/peak rates. The
 *   token counters still report cumulative response output.
 *
 * Pure module with no plugin entrypoint: only `src/index.ts` (`.`) and
 * `src/tui.tsx` (`./tui`) are package entries.
 */

import { formatTokenCount, type UsageLine, type UsageSegment } from "./core"

export const THROUGHPUT_WINDOW_MS = 3_000
export const THROUGHPUT_CHARS_PER_TOKEN = 4
export const THROUGHPUT_MIN_TOKENS = 2

export type ThroughputSample = {
  readonly t: number
  readonly tokens: number
}

export type StreamingThroughput = {
  readonly kind: "streaming"
  responseStartTime: number
  requestTime: number | undefined
  firstOutputTime: number | undefined
  measurementStartTime: number | undefined
  measurementBaseline: number
  totalChars: number
  samples: ThroughputSample[]
  peakRate: number
  model: string
}

export type ThroughputPromptMetrics = {
  readonly inputTokens: number | undefined
  readonly cacheReadTokens: number | undefined
  readonly cacheWriteTokens: number | undefined
  readonly ttftMs: number | undefined
  readonly approximatePromptRate: number | undefined
}

export type FinalThroughput = {
  readonly kind: "final"
  readonly outputTokens: number
  readonly elapsedSec: number
  readonly averageRate: number
  readonly peakRate: number
  readonly model: string
  readonly prompt: ThroughputPromptMetrics
}

export type ThroughputState = StreamingThroughput | FinalThroughput

export const formatThroughputRate = (rate: number): string =>
  rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)

const formatTtft = (ms: number): string =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(2)}s`

const positiveMetric = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0 ? value : undefined

const separator = (): UsageSegment => ({ text: " · ", tone: "separator" })
const metric = (text: string): UsageSegment => ({ text, tone: "metric" })
const value = (text: string): UsageSegment => ({ text, tone: "value" })
const label = (text: string): UsageSegment => ({ text, tone: "label" })

const lineText = (line: UsageLine): string => line.map(segment => segment.text).join("")

export function createStreamingThroughput(now: number, requestTime?: number, model = ""): StreamingThroughput {
  return {
    kind: "streaming",
    responseStartTime: now,
    requestTime,
    firstOutputTime: undefined,
    measurementStartTime: undefined,
    measurementBaseline: 0,
    totalChars: 0,
    samples: [],
    peakRate: 0,
    model,
  }
}

export const estimatedTokens = (chars: number): number => chars / THROUGHPUT_CHARS_PER_TOKEN

export const liveOutputTokens = (stream: StreamingThroughput): number =>
  estimatedTokens(stream.totalChars)

const measuredOutputTokens = (stream: StreamingThroughput, total: number): number => {
  if (stream.measurementStartTime === undefined) return 0
  return Math.max(0, total - stream.measurementBaseline)
}

/** Prune samples outside the rolling window and return the rolling rate. */
export function rollingRate(stream: StreamingThroughput, now: number): number {
  if (stream.measurementStartTime === undefined) return 0
  const windowStart = Math.max(stream.measurementStartTime, now - THROUGHPUT_WINDOW_MS)
  stream.samples = stream.samples.filter(sample => sample.t >= windowStart)
  const elapsedMs = now - windowStart
  if (elapsedMs <= 0 || stream.samples.length === 0) return 0
  const tokens = stream.samples.reduce((sum, sample) => sum + sample.tokens, 0)
  return tokens / (elapsedMs / 1_000)
}

const startMeasurementIfReady = (stream: StreamingThroughput, now: number): boolean => {
  if (stream.measurementStartTime !== undefined) return false
  if (liveOutputTokens(stream) < THROUGHPUT_MIN_TOKENS) return false
  stream.measurementStartTime = now
  stream.measurementBaseline = liveOutputTokens(stream)
  stream.samples = []
  stream.peakRate = 0
  return true
}

/**
 * Record streamed characters (text, reasoning, or tool-input delta length).
 * Returns true when measurement just started, so the caller can render
 * immediately even inside a throttle window.
 */
export function recordThroughputDelta(stream: StreamingThroughput, chars: number, now: number): boolean {
  if (chars > 0) {
    if (stream.firstOutputTime === undefined) stream.firstOutputTime = now
    stream.totalChars += chars
    if (stream.measurementStartTime !== undefined) {
      stream.samples.push({ t: now, tokens: estimatedTokens(chars) })
    }
  }
  return startMeasurementIfReady(stream, now)
}

export const liveAverageRate = (stream: StreamingThroughput, now: number): number => {
  if (stream.measurementStartTime === undefined) return 0
  const elapsedSec = (now - stream.measurementStartTime) / 1_000
  return elapsedSec > 0 ? measuredOutputTokens(stream, liveOutputTokens(stream)) / elapsedSec : 0
}

export const liveElapsedSec = (stream: StreamingThroughput, now: number): number =>
  stream.measurementStartTime === undefined
    ? (now - stream.responseStartTime) / 1_000
    : (now - stream.measurementStartTime) / 1_000

const ttftMs = (stream: StreamingThroughput): number | undefined =>
  stream.requestTime !== undefined && stream.firstOutputTime !== undefined
    ? Math.max(0, stream.firstOutputTime - stream.requestTime)
    : undefined

const promptMetrics = (
  stream: StreamingThroughput,
  usage: { input: number; cacheRead: number; cacheWrite: number },
): ThroughputPromptMetrics => {
  const inputTokens = positiveMetric(usage.input)
  const cacheReadTokens = positiveMetric(usage.cacheRead)
  const cacheWriteTokens = positiveMetric(usage.cacheWrite)
  const ttft = ttftMs(stream)
  const processedTokens = (inputTokens ?? 0) + (cacheWriteTokens ?? 0)
  const approximatePromptRate =
    processedTokens > 0 && ttft !== undefined && ttft > 0 ? processedTokens / (ttft / 1_000) : undefined
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ttftMs: ttft,
    approximatePromptRate,
  }
}

/**
 * Finalize with provider-reported step tokens. When the measured window
 * captured less than one full output token, whole-response timing is used
 * instead of reporting a misleading near-zero rate.
 */
export function finalizeThroughput(
  stream: StreamingThroughput,
  providerTokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  now: number,
  model = stream.model,
): FinalThroughput {
  let measurementStart = stream.measurementStartTime ?? stream.responseStartTime
  let measuredTokens =
    stream.measurementStartTime === undefined
      ? providerTokens.output
      : measuredOutputTokens(stream, providerTokens.output)
  if (measuredTokens < 1) {
    measurementStart = stream.responseStartTime
    measuredTokens = providerTokens.output
  }
  const elapsedSec = (now - measurementStart) / 1_000
  const averageRate = measuredTokens / Math.max(elapsedSec, 0.001)
  const peakRate = Math.max(stream.peakRate, rollingRate(stream, now), averageRate)
  return {
    kind: "final",
    outputTokens: providerTokens.output,
    elapsedSec,
    averageRate,
    peakRate,
    model,
    prompt: promptMetrics(stream, providerTokens),
  }
}

/** Finalize without provider totals (execution ended with no step report). */
export function finalizeThroughputEstimate(stream: StreamingThroughput, now: number): FinalThroughput {
  const outputTokens = Math.round(liveOutputTokens(stream))
  return finalizeThroughput(
    stream,
    { input: 0, output: outputTokens, cacheRead: 0, cacheWrite: 0 },
    now,
  )
}

/**
 * Label column mirrors the MAIN/TOT sections in core.ts: a 7-cell label
 * followed by metrics, with continuation lines indented 7 spaces. The
 * state icons double as the labels (⚡ spans 2 cells + 5 spaces, ✓ spans
 * 1 cell + 6 spaces), so the block reads as a sibling of MAIN/TOT.
 */
const liveLabel = (): UsageSegment => ({ text: "⚡     ", tone: "label" })
const doneLabel = (): UsageSegment => ({ text: "✓      ", tone: "label" })
const continuation = (content: UsageLine): UsageLine => [label("       "), ...content]

const refreshLiveRate = (stream: StreamingThroughput, now: number): number => {
  const live = rollingRate(stream, now)
  stream.peakRate = Math.max(stream.peakRate, live)
  return live
}

const livePendingLine = (stream: StreamingThroughput, now: number): UsageLine => [
  liveLabel(),
  metric("~"),
  value(formatTokenCount(liveOutputTokens(stream))),
  metric(" tok"),
  separator(),
  value(Math.max(0, (now - stream.responseStartTime) / 1_000).toFixed(1)),
  metric("s"),
]

const livePrimaryLines = (stream: StreamingThroughput, now: number): UsageLine[] => {
  if (stream.measurementStartTime === undefined) return [livePendingLine(stream, now)]
  const live = refreshLiveRate(stream, now)
  const average = liveAverageRate(stream, now)
  const elapsed = liveElapsedSec(stream, now)
  return [
    [
      liveLabel(),
      metric("~"),
      value(formatThroughputRate(live)),
      metric(" tok/s"),
      separator(),
      metric("avg "),
      value(formatThroughputRate(average)),
    ],
    continuation([
      metric("~"),
      value(formatTokenCount(liveOutputTokens(stream))),
      metric(" tok"),
      separator(),
      value(Math.max(0, elapsed).toFixed(1)),
      metric("s"),
    ]),
  ]
}

/** Same metrics as primary, one per line — mirrors core's narrow layout. */
const liveNarrowLines = (stream: StreamingThroughput, now: number): UsageLine[] => {
  if (stream.measurementStartTime === undefined) return [livePendingLine(stream, now)]
  const live = refreshLiveRate(stream, now)
  const average = liveAverageRate(stream, now)
  const elapsed = liveElapsedSec(stream, now)
  return [
    [liveLabel(), metric("~"), value(formatThroughputRate(live)), metric(" tok/s")],
    continuation([metric("~"), value(formatTokenCount(liveOutputTokens(stream))), metric(" tok")]),
    continuation([metric("avg "), value(formatThroughputRate(average)), metric(" tok/s")]),
    continuation([value(Math.max(0, elapsed).toFixed(1)), metric("s")]),
  ]
}

const finalHeadline = (final: FinalThroughput): UsageLine => [
  doneLabel(),
  value(formatTokenCount(final.outputTokens)),
  metric(" tok · "),
  value(formatThroughputRate(final.averageRate)),
  metric(" tok/s avg"),
]

const finalSubline = (final: FinalThroughput): UsageLine =>
  continuation([
    metric("peak "),
    value(formatThroughputRate(final.peakRate)),
    metric(" tok/s"),
    separator(),
    value(final.elapsedSec.toFixed(1)),
    metric("s"),
  ])

const finalPrimaryLines = (final: FinalThroughput, width: number): UsageLine[] => {
  const lines = [finalHeadline(final), finalSubline(final)]
  // Prompt details ride a third continuation line, dropping trailing
  // groups (model first) until it fits.
  const remaining = [...finalPromptGroups(final)]
  while (remaining.length > 0) {
    const extra = continuation(joinGroups(remaining))
    if (lineText(extra).length <= width) return [...lines, extra]
    remaining.pop()
  }
  return lines
}

/** Same metrics as primary, one per line — mirrors core's narrow layout. */
const finalNarrowLines = (final: FinalThroughput, width: number): UsageLine[] => {
  const lines: UsageLine[] = [
    [doneLabel(), value(formatTokenCount(final.outputTokens)), metric(" tok")],
    continuation([value(formatThroughputRate(final.averageRate)), metric(" tok/s avg")]),
    continuation([metric("peak "), value(formatThroughputRate(final.peakRate)), metric(" tok/s")]),
    continuation([value(final.elapsedSec.toFixed(1)), metric("s")]),
  ]
  for (const group of finalPromptGroups(final)) {
    const extra = continuation(group)
    if (lineText(extra).length <= width) lines.push(extra)
  }
  return lines
}

const finalPromptGroups = (final: FinalThroughput): UsageLine[] => {
  const groups: UsageLine[] = []
  if (final.prompt.inputTokens !== undefined) {
    groups.push([metric("input "), value(formatTokenCount(final.prompt.inputTokens)), metric(" tok")])
  }
  if (final.prompt.cacheReadTokens !== undefined) {
    groups.push([metric("cache read "), value(formatTokenCount(final.prompt.cacheReadTokens)), metric(" tok")])
  }
  if (final.prompt.cacheWriteTokens !== undefined) {
    groups.push([metric("cache write "), value(formatTokenCount(final.prompt.cacheWriteTokens)), metric(" tok")])
  }
  if (final.prompt.ttftMs !== undefined) {
    groups.push([metric("TTFT "), value(formatTtft(final.prompt.ttftMs))])
  }
  if (final.prompt.approximatePromptRate !== undefined) {
    groups.push([
      metric("approx. prompt "),
      value(formatThroughputRate(final.prompt.approximatePromptRate)),
      metric(" tok/s"),
    ])
  }
  if (final.model) groups.push([metric(final.model)])
  return groups
}

const joinGroups = (groups: ReadonlyArray<UsageLine>): UsageLine =>
  groups.flatMap((group, index) => (index === 0 ? group : [separator(), ...group]))

/**
 * Format the throughput snapshot as styled footer lines. The layout mirrors
 * the MAIN/TOT sections: primary lines first, falling back to a narrow
 * one-metric-per-line layout when any primary row exceeds the width.
 */
export function formatThroughputLines(
  state: ThroughputState | undefined,
  width = 48,
  now = Date.now(),
): readonly UsageLine[] {
  const normalizedWidth = Math.max(1, Math.floor(width))
  if (state === undefined) return []
  if (state.kind === "streaming") {
    const primary = livePrimaryLines(state, now)
    if (primary.every(line => lineText(line).length <= normalizedWidth)) return primary
    return liveNarrowLines(state, now)
  }
  const primary = finalPrimaryLines(state, normalizedWidth)
  if (primary.every(line => lineText(line).length <= normalizedWidth)) return primary
  return finalNarrowLines(state, normalizedWidth)
}

/** Join formatted throughput lines for change detection. */
export function throughputTextKey(
  state: ThroughputState | undefined,
  width = 48,
  now = Date.now(),
): string {
  if (state === undefined) return ""
  return formatThroughputLines(state, width, now).map(lineText).join("\n")
}
