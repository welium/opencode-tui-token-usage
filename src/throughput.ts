/**
 * Live token-throughput tracking for the token-tracker footer.
 *
 * Design reference: `npm:pi-live-throughput` as used in the Pi coding agent.
 * While an assistant response streams, the footer shows one friendly line
 * with the rolling decode rate and tokens so far:
 *
 *   `⚡       ~92.3 tok/s · ~1.2k tok`
 *
 * When streaming finishes it is replaced with a final summary that stays
 * visible until the next response starts:
 *
 *   `✓        512 tok · 120 tok/s`
 *
 * Only the highest-signal numbers are shown: live rate + output tokens
 * while streaming, output tokens + average rate when done. Peak, elapsed,
 * TTFT, per-step prompt details, and model are deliberately omitted — the
 * model is already visible in the main panel and prompt totals live in the
 * TOT lines. The block mirrors the MAIN/TOT sections in core.ts (7-cell
 * label column, continuation indent).
 *
 * OpenCode adaptation notes (vs Pi):
 * - Pi prefers cumulative provider-reported `usage.output` while streaming
 *   and falls back to a chars/4 heuristic. OpenCode only exposes provider
 *   token counts at step boundaries (`session.step.ended`), never during
 *   the stream, so live figures are heuristic estimates (chars/4 over
 *   text, reasoning, and tool-input deltas), marked `~`. The final summary
 *   always uses provider-reported step tokens.
 * - Rate measurement starts only after a second output token has been
 *   observed, so time-to-first-token never dilutes the rolling or average
 *   rates. The token counters still report cumulative response output.
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
  measurementStartTime: number | undefined
  measurementBaseline: number
  totalChars: number
  samples: ThroughputSample[]
}

export type FinalThroughput = {
  readonly kind: "final"
  readonly outputTokens: number
  readonly averageRate: number
}

export type ThroughputState = StreamingThroughput | FinalThroughput

export const formatThroughputRate = (rate: number): string =>
  rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)

const separator = (): UsageSegment => ({ text: " · ", tone: "separator" })
const metric = (text: string): UsageSegment => ({ text, tone: "metric" })
const value = (text: string): UsageSegment => ({ text, tone: "value" })

const lineText = (line: UsageLine): string => line.map(segment => segment.text).join("")

export function createStreamingThroughput(now: number): StreamingThroughput {
  return {
    kind: "streaming",
    responseStartTime: now,
    measurementStartTime: undefined,
    measurementBaseline: 0,
    totalChars: 0,
    samples: [],
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
  return true
}

/**
 * Record streamed characters (text, reasoning, or tool-input delta length).
 * Returns true when measurement just started, so the caller can render
 * immediately even inside a throttle window.
 */
export function recordThroughputDelta(stream: StreamingThroughput, chars: number, now: number): boolean {
  if (chars > 0) {
    stream.totalChars += chars
    if (stream.measurementStartTime !== undefined) {
      stream.samples.push({ t: now, tokens: estimatedTokens(chars) })
    }
  }
  return startMeasurementIfReady(stream, now)
}

/**
 * Finalize with provider-reported step output tokens. When the measured
 * window captured less than one full output token, whole-response timing
 * is used instead of reporting a misleading near-zero rate.
 */
export function finalizeThroughput(
  stream: StreamingThroughput,
  outputTokens: number,
  now: number,
): FinalThroughput {
  const output = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0
  let measurementStart = stream.measurementStartTime ?? stream.responseStartTime
  let measuredTokens = stream.measurementStartTime === undefined ? output : measuredOutputTokens(stream, output)
  if (measuredTokens < 1) {
    measurementStart = stream.responseStartTime
    measuredTokens = output
  }
  const elapsedSec = (now - measurementStart) / 1_000
  return {
    kind: "final",
    outputTokens: output,
    averageRate: measuredTokens / Math.max(elapsedSec, 0.001),
  }
}

/** Finalize without provider totals (execution ended with no step report). */
export function finalizeThroughputEstimate(stream: StreamingThroughput, now: number): FinalThroughput {
  return finalizeThroughput(stream, Math.round(liveOutputTokens(stream)), now)
}

/**
 * Label column mirrors the MAIN/TOT sections in core.ts: a 7-cell label
 * with metrics after it. The state icons double as the labels (⚡ spans 2
 * cells + 5 spaces, ✓ spans 1 cell + 6 spaces).
 */
const liveLabel = (): UsageSegment => ({ text: "⚡     ", tone: "label" })
const doneLabel = (): UsageSegment => ({ text: "✓      ", tone: "label" })

const livePendingLine = (stream: StreamingThroughput): UsageLine => [
  liveLabel(),
  metric("~"),
  value(formatTokenCount(liveOutputTokens(stream))),
  metric(" tok"),
]

const liveFullLine = (stream: StreamingThroughput, now: number): UsageLine => [
  liveLabel(),
  metric("~"),
  value(formatThroughputRate(rollingRate(stream, now))),
  metric(" tok/s"),
  separator(),
  metric("~"),
  value(formatTokenCount(liveOutputTokens(stream))),
  metric(" tok"),
]

/** Rate-only fallback for very narrow terminals. */
const liveRateLine = (stream: StreamingThroughput, now: number): UsageLine => [
  liveLabel(),
  metric("~"),
  value(formatThroughputRate(rollingRate(stream, now))),
  metric(" tok/s"),
]

const finalFullLine = (final: FinalThroughput): UsageLine => [
  doneLabel(),
  value(formatTokenCount(final.outputTokens)),
  metric(" tok · "),
  value(formatThroughputRate(final.averageRate)),
  metric(" tok/s"),
]

/** Tokens-only fallback for very narrow terminals. */
const finalTokensLine = (final: FinalThroughput): UsageLine => [
  doneLabel(),
  value(formatTokenCount(final.outputTokens)),
  metric(" tok"),
]

/**
 * Format the throughput snapshot as a single friendly footer line: live
 * rate + tokens while streaming, tokens + average rate when done. On very
 * narrow terminals the secondary metric is dropped, keeping the headline
 * number (rate while live, tokens when done).
 */
export function formatThroughputLines(
  state: ThroughputState | undefined,
  width = 48,
  now = Date.now(),
): readonly UsageLine[] {
  const normalizedWidth = Math.max(1, Math.floor(width))
  if (state === undefined) return []
  if (state.kind === "streaming") {
    if (state.measurementStartTime === undefined) return [livePendingLine(state)]
    const full = liveFullLine(state, now)
    if (lineText(full).length <= normalizedWidth) return [full]
    return [liveRateLine(state, now)]
  }
  const full = finalFullLine(state)
  if (lineText(full).length <= normalizedWidth) return [full]
  return [finalTokensLine(state)]
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
