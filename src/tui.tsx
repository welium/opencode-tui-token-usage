/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * Update model: refreshes are driven by server events
 * (`session.usage.updated`, execution start/finish) with a debounced
 * re-sync, plus a slow fallback poll for session switches and missed
 * events. Each refresh with changed totals re-registers the slot claim
 * with fully static content: the render closes over plain values and uses
 * no signals, effects, or conditional helpers, because signal updates do
 * not propagate into slot JSX from an installed package while fresh
 * mounts render reliably.
 */

/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  formatUsageSegments,
  sessionTreeUsage,
  type FamilySessionUsage,
  type SessionTreeUsage,
  type UsageLine,
  type UsageSegmentTone,
} from "./core"

const DEBOUNCE_MS = 400
const FALLBACK_POLL_MS = 60_000

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
    let lastKey = ""
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

    const refresh = async (sessionID: string): Promise<void> => {
      if (disposed || inFlight.has(sessionID)) return
      inFlight.add(sessionID)
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
        const key = `${sessionID}:${JSON.stringify(usage.tree)}`
        if (key === lastKey) return
        lastKey = key
        publish(formatUsageSegments(usage, context.renderer.width))
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
      context.data.on("session.execution.succeeded", event => onFamilyEvent(event.data.sessionID)),
      context.data.on("session.execution.failed", event => onFamilyEvent(event.data.sessionID)),
      context.data.on("session.execution.interrupted", event => onFamilyEvent(event.data.sessionID)),
      // Session open/switch and fresh server connections: instant first paint.
      context.data.on("session.viewed", event => onFamilyEvent(event.data.sessionID)),
      context.data.on("session.created", event => onFamilyEvent(event.data.sessionID)),
      context.data.on("server.connected", () => tick()),
    )

    const tick = (): void => {
      if (disposed) return
      const sessionID = currentSessionID()
      if (sessionID === undefined) return
      if (sessionID !== lastSessionID || lastUsage === undefined || treeIsBusy(lastUsage)) {
        scheduleRefresh(sessionID)
      }
    }

    // Placeholder until the first snapshot lands.
    const placeholder: UsageLine = [{ text: "…", tone: "metric" }]
    publish([placeholder])
    tick()
    const timer = setInterval(tick, FALLBACK_POLL_MS)

    return () => {
      disposed = true
      clearInterval(timer)
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
