/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * A live throughput section (design reference: `npm:pi-live-throughput` as
 * used in the Pi agent) is prepended while an assistant response streams:
 * rolling tok/s plus estimated output tokens. When streaming finishes, a
 * final `✓` summary with provider-reported step tokens (output tokens +
 * average rate) persists until the next response. Only headline numbers
 * are shown; the model is already visible in the main panel and prompt
 * totals live in the TOT lines. OpenCode exposes provider token counts
 * only at step boundaries, never during the stream, so all live figures
 * are estimates; the final summary always uses provider-reported totals.
 *
 * Update model: refreshes are driven by server events
 * (`session.usage.updated`, execution start/finish, session viewed/created,
 * server connect — debounced at 400ms) with live delta events
 * (`session.text.delta`, `session.reasoning.delta`,
 * `session.tool.input.delta` — throttled at 250ms, no server sync) plus a
 * slow fallback poll for session switches and missed events. Each refresh
 * with changed content re-registers the slot claim with fully static
 * content: the render closes over plain values and uses no signals,
 * effects, or conditional helpers, because signal updates do not propagate
 * into slot JSX from an installed package while fresh mounts render
 * reliably.
 */

/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot } from "solid-js"
import {
  formatUsageSegments,
  sessionTreeUsage,
  type FamilySessionUsage,
  type SessionTreeUsage,
  type UsageLine,
  type UsageSegmentTone,
} from "./core"
import {
  createStreamingThroughput,
  finalizeThroughput,
  finalizeThroughputEstimate,
  formatThroughputLines,
  recordThroughputDelta,
  type StreamingThroughput,
  type ThroughputState,
} from "./throughput"

const DEBOUNCE_MS = 400
const ROUTER_POLL_MS = 1_000
const QUIET_REFRESH_MS = 5_000
const LIVE_THROTTLE_MS = 250
const THROUGHPUT_STORE_LIMIT = 100

export default Plugin.define({
  id: "token-tracker.tui",
  setup(context) {
    let disposeSlot: (() => void) | undefined
    let disposed = false
    const inFlight = new Set<string>()
    const queued = new Set<string>()
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let lastSessionID: string | undefined
    let lastUsage: SessionTreeUsage | undefined
    let lastFooterKey = ""
    let lastRefreshAt = 0
    let lastLivePublishAt = 0
    let liveTimer: ReturnType<typeof setTimeout> | undefined
    const throughputBySession = new Map<string, ThroughputState>()
    const unsubscribers: (() => void)[] = []

    const segmentColor = (tone: UsageSegmentTone) => {
      if (tone === "label") return context.theme.text.action.primary.base
      if (tone === "metric" || tone === "separator") return context.theme.text.muted
      return context.theme.text.base
    }

    const publish = (lines: readonly UsageLine[]): void => {
      if (disposed) return
      try {
        disposeSlot?.()
      } catch {
        // Best effort: a stale claim is replaced below regardless.
      }
      disposeSlot = context.ui.slot({
        append: "sidebar.footer",
        render: () => (
          <box>
            {lines.map(line => (
              <text>
                {line.map(segment => (
                  <span style={{ fg: segmentColor(segment.tone) }}>{segment.text}</span>
                ))}
              </text>
            ))}
          </box>
        ),
      })
    }

    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current()
        return route.type === "session" ? route.sessionID : undefined
      } catch {
        return undefined
      }
    }

    const treeIsBusy = (usage: SessionTreeUsage): boolean => {
      try {
        return usage.sessionIDs.some(sessionID => context.data.session.status(sessionID) === "running")
      } catch {
        return true
      }
    }

    const rememberBounded = <Value,>(store: Map<string, Value>, key: string, val: Value): void => {
      if (!store.has(key)) {
        while (store.size >= THROUGHPUT_STORE_LIMIT) {
          const oldest = store.keys().next()
          if (oldest.done) break
          store.delete(oldest.value)
        }
      }
      store.set(key, val)
    }

    const ensureStreaming = (sessionID: string, now: number): StreamingThroughput => {
      const existing = throughputBySession.get(sessionID)
      if (existing !== undefined && existing.kind === "streaming") return existing
      const stream = createStreamingThroughput(now)
      rememberBounded(throughputBySession, sessionID, stream)
      return stream
    }

    /** Throughput snapshot for the visible session: live first, else own final. */
    const displayedThroughput = (): ThroughputState | undefined => {
      const current = currentSessionID()
      if (current === undefined) return undefined
      const own = throughputBySession.get(current)
      if (own !== undefined && own.kind === "streaming") return own
      try {
        for (const memberID of context.data.session.family(current)) {
          const member = throughputBySession.get(memberID)
          if (member !== undefined && member.kind === "streaming") return member
        }
      } catch {
        // Family lookup failed: fall through to the session's own snapshot.
      }
      return own
    }

    const footerLinesKey = (ownerSessionID: string, lines: readonly UsageLine[]): string =>
      `${ownerSessionID}:${lastUsage === undefined ? "pending" : JSON.stringify(lastUsage.tree)}:${lines.map(line => line.map(segment => segment.text).join("")).join("\n")}`

    const renderFooter = (ownerSessionID: string): void => {
      if (disposed || currentSessionID() !== ownerSessionID) return
      const now = Date.now()
      const width = context.renderer.width
      const throughputLines = formatThroughputLines(displayedThroughput(), width, now)
      const usageLines = lastUsage === undefined ? [placeholder] : formatUsageSegments(lastUsage, width)
      const lines = [...throughputLines, ...usageLines]
      const key = footerLinesKey(ownerSessionID, lines)
      if (key === lastFooterKey) return
      lastFooterKey = key
      publish(lines)
    }

    const publishLive = (sessionID: string, force: boolean): void => {
      if (disposed) return
      const current = currentSessionID()
      if (current === undefined) return
      if (sessionID !== current) {
        try {
          if (!context.data.session.family(current).includes(sessionID)) return
        } catch {
          // Family lookup failed: still refresh the visible footer.
        }
      }
      const now = Date.now()
      if (!force && now - lastLivePublishAt < LIVE_THROTTLE_MS) {
        if (liveTimer === undefined) {
          liveTimer = setTimeout(
            () => {
              liveTimer = undefined
              if (!disposed) {
                const visible = currentSessionID()
                if (visible !== undefined) renderFooter(visible)
              }
            },
            LIVE_THROTTLE_MS - (now - lastLivePublishAt),
          )
        }
        return
      }
      lastLivePublishAt = now
      renderFooter(current)
    }

    const deltaText = (data: unknown): string => {
      if (typeof data !== "object" || data === null) return ""
      const record = data as { delta?: unknown; text?: unknown }
      if (typeof record.delta === "string") return record.delta
      if (typeof record.text === "string") return record.text
      return ""
    }

    const handleThroughputDelta = (sessionID: string, chars: number): void => {
      if (disposed || chars <= 0) return
      const now = Date.now()
      const started = recordThroughputDelta(ensureStreaming(sessionID, now), chars, now)
      publishLive(sessionID, started)
    }

    const finiteOrZero = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) ? value : 0

    const finalizeStreaming = (sessionID: string, outputTokens?: number): void => {
      const stream = throughputBySession.get(sessionID)
      if (stream === undefined || stream.kind !== "streaming") return
      const now = Date.now()
      rememberBounded(
        throughputBySession,
        sessionID,
        outputTokens === undefined
          ? finalizeThroughputEstimate(stream, now)
          : finalizeThroughput(stream, outputTokens, now),
      )
      publishLive(sessionID, true)
    }

    const refresh = async (sessionID: string): Promise<void> => {
      if (disposed || inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      lastRefreshAt = Date.now()
      try {
        const familyIDs = context.data.session.family(sessionID)
        const sessionIDs = [...new Set([sessionID, ...familyIDs])]
        await Promise.all(
          sessionIDs.map(async memberID => {
            try {
              await context.data.session.sync(memberID)
            } catch {
              // Fall through to message sync; member degrades to cached data.
            }
            try {
              await context.data.session.message.sync(memberID)
            } catch {
              // Request count degrades to the cached message list below.
            }
          }),
        )
        const family: FamilySessionUsage[] = sessionIDs.map(memberID => {
          const info = context.data.session.get(memberID)
          let cost = info?.cost ?? 0
          try {
            cost = context.data.session.cost(memberID)
          } catch {
            // Keep the SessionInfo cost when the accessor is unavailable.
          }
          let assistantCount = 0
          try {
            assistantCount = context.data.session.message
              .list(memberID)
              .filter(message => message.type === "assistant").length
          } catch {
            // Keep a zero request count for this member.
          }
          return {
            id: memberID,
            tokens: {
              input: info?.tokens.input ?? 0,
              output: info?.tokens.output ?? 0,
              reasoning: info?.tokens.reasoning ?? 0,
              cacheRead: info?.tokens.cache.read ?? 0,
              cacheWrite: info?.tokens.cache.write ?? 0,
            },
            cost,
            requests: assistantCount,
          }
        })
        const usage = sessionTreeUsage(sessionID, family)
        if (disposed) return
        // Drop stale completions: only the router-current session owns the footer.
        if (currentSessionID() !== sessionID) return
        lastSessionID = sessionID
        lastUsage = usage
        renderFooter(sessionID)
      } catch {
        // Keep the last published snapshot on transient failures.
      } finally {
        inFlight.delete(sessionID)
        if (queued.delete(sessionID) && !disposed) scheduleRefresh(sessionID)
      }
    }

    const scheduleRefresh = (sessionID: string): void => {
      if (disposed) return
      if (inFlight.has(sessionID)) {
        queued.add(sessionID)
        return
      }
      queued.add(sessionID)
      if (debounceTimer !== undefined) return
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined
        if (disposed) return
        const ids = [...queued]
        queued.clear()
        for (const id of ids) void refresh(id)
      }, DEBOUNCE_MS)
    }

    /** Refresh the visible session when one of its family members reports usage. */
    const onFamilyEvent = (eventSessionID: string): void => {
      const current = currentSessionID()
      if (current === undefined) return
      if (eventSessionID === current) {
        scheduleRefresh(current)
        return
      }
      try {
        if (context.data.session.family(current).includes(eventSessionID)) scheduleRefresh(current)
      } catch {
        scheduleRefresh(current)
      }
    }

    unsubscribers.push(
      context.data.on("session.usage.updated", event => onFamilyEvent(event.data.sessionID)),
      context.data.on("session.execution.started", event => onFamilyEvent(event.data.sessionID)),
      context.data.on("session.execution.succeeded", event => {
        finalizeStreaming(event.data.sessionID)
        onFamilyEvent(event.data.sessionID)
      }),
      context.data.on("session.execution.failed", event => {
        finalizeStreaming(event.data.sessionID)
        onFamilyEvent(event.data.sessionID)
      }),
      context.data.on("session.execution.interrupted", event => {
        finalizeStreaming(event.data.sessionID)
        onFamilyEvent(event.data.sessionID)
      }),
      context.data.on("session.step.started", event => {
        const sessionID = event.data.sessionID
        ensureStreaming(sessionID, Date.now())
        publishLive(sessionID, true)
      }),
      context.data.on("session.text.started", event => {
        ensureStreaming(event.data.sessionID, Date.now())
      }),
      context.data.on("session.reasoning.started", event => {
        ensureStreaming(event.data.sessionID, Date.now())
      }),
      context.data.on("session.tool.input.started", event => {
        ensureStreaming(event.data.sessionID, Date.now())
      }),
      context.data.on("session.text.delta", event => {
        handleThroughputDelta(event.data.sessionID, deltaText(event.data).length)
      }),
      context.data.on("session.reasoning.delta", event => {
        handleThroughputDelta(event.data.sessionID, deltaText(event.data).length)
      }),
      context.data.on("session.tool.input.delta", event => {
        handleThroughputDelta(event.data.sessionID, deltaText(event.data).length)
      }),
      context.data.on("session.step.ended", event => {
        finalizeStreaming(event.data.sessionID, finiteOrZero(event.data.tokens.output))
        onFamilyEvent(event.data.sessionID)
      }),
      context.data.on("session.step.failed", event => {
        const tokens = event.data.tokens
        finalizeStreaming(event.data.sessionID, tokens === undefined ? undefined : finiteOrZero(tokens.output))
        onFamilyEvent(event.data.sessionID)
      }),
      // Opened or viewed sessions refresh directly: at event time the
      // router may not have caught up yet, so bypass the current-session gate.
      // (Publish still drops the result if another session is current then.)
      context.data.on("session.viewed", event => scheduleRefresh(event.data.sessionID)),
      context.data.on("session.created", event => scheduleRefresh(event.data.sessionID)),
      context.data.on("tui.session.select", () => tick()),
      context.data.on("server.connected", () => tick()),
    )

    // Tab switches are CLI-local state: the server emits nothing for them,
    // so the router is polled with a cheap local read. Syncs happen only on
    // session change, event triggers, or a quiet-but-busy tree.
    const tick = (): void => {
      if (disposed) return
      const sessionID = currentSessionID()
      if (sessionID === undefined) return
      if (sessionID !== lastSessionID || lastUsage === undefined) {
        scheduleRefresh(sessionID)
        return
      }
      // Keep live rates fresh (rolling-window decay, elapsed time) even
      // without delta traffic. renderFooter no-ops when nothing changed.
      const visible = displayedThroughput()
      if (visible !== undefined && visible.kind === "streaming") {
        lastLivePublishAt = Date.now()
        renderFooter(sessionID)
      }
      if (treeIsBusy(lastUsage) && Date.now() - lastRefreshAt > QUIET_REFRESH_MS) {
        scheduleRefresh(sessionID)
      }
    }

    // Route watcher: tab switches are CLI-local (no server event), but the
    // router is a reactive source. When it notifies, refresh instantly
    // instead of waiting for the poll below. If the router is not reactive
    // in this host, the effect simply runs once and the poll covers switches.
    const disposeRouteWatcher = createRoot(dispose => {
      createEffect(() => {
        if (disposed) return
        const route = context.ui.router.current()
        if (route.type === "session") scheduleRefresh(route.sessionID)
      })
      return dispose
    })

    // Placeholder until the first snapshot lands.
    const placeholder: UsageLine = [{ text: "…", tone: "metric" }]
    publish([placeholder])
    tick()
    const timer = setInterval(tick, ROUTER_POLL_MS)

    return () => {
      disposed = true
      clearInterval(timer)
      if (liveTimer !== undefined) clearTimeout(liveTimer)
      disposeRouteWatcher()
      if (debounceTimer !== undefined) clearTimeout(debounceTimer)
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe()
        } catch {
          // Best effort on teardown.
        }
      }
      try {
        disposeSlot?.()
      } catch {
        // Best effort on teardown.
      }
    }
  },
})
