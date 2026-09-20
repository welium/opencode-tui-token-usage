/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * Update model: re-register the slot claim per refresh with fully static
 * content. Signal updates do not propagate into slot JSX from an installed
 * package (proven over diag1-diag4: 126 computed snapshots, zero
 * re-renders), while fresh mounts render reliably. Data (not components)
 * is therefore swapped by dispose + re-register; the render itself closes
 * over plain values and uses no signals, effects, or conditional helpers.
 */

/** @jsxImportSource @opentui/solid */
import { appendFileSync } from "node:fs"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  formatUsageSegments,
  sessionTreeUsage,
  type FamilySessionUsage,
  type SessionTreeUsage,
  type UsageLine,
  type UsageSegmentTone,
} from "./core"

// TEMPORARY diagnostic tracing (removed once numbers are confirmed live).
const DEBUG_LOG = "/tmp/opencode/tui-token-usage-debug.log"
const DEBUG_BUILD = "diag5"
const debug = (event: string, entry: Record<string, unknown>): void => {
  try {
    appendFileSync(
      DEBUG_LOG,
      JSON.stringify({ build: DEBUG_BUILD, t: new Date().toISOString(), event, ...entry }) + "\n",
    )
  } catch {
    // Logging must never break the footer.
  }
}

export default Plugin.define({
  id: "token-tracker.tui",
  setup(context) {
    debug("setup", { options: context.options })
    let disposeSlot: (() => void) | undefined
    let disposed = false
    const inFlight = new Set<string>()
    let lastKey = ""

    const segmentColor = (tone: UsageSegmentTone) => {
      if (tone === "label") return context.theme.text.action.primary.base
      if (tone === "metric" || tone === "separator") return context.theme.text.muted
      return context.theme.text.base
    }

    const publish = (lines: readonly UsageLine[]): void => {
      if (disposed) return
      try {
        disposeSlot?.()
      } catch (error) {
        debug("dispose-error", { error: String(error) })
      }
      try {
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
        debug("publish", { lines: lines.map(line => line.map(segment => segment.text).join("")) })
      } catch (error) {
        debug("publish-error", { error: String(error) })
        disposeSlot = undefined
      }
    }

    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current()
        return route.type === "session" ? route.sessionID : undefined
      } catch (error) {
        debug("router-error", { error: String(error) })
        return undefined
      }
    }

    const treeIsBusy = (usage: SessionTreeUsage): boolean => {
      try {
        return usage.sessionIDs.some(sessionID => context.data.session.status(sessionID) === "running")
      } catch (error) {
        debug("status-error", { error: String(error) })
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
            } catch (error) {
              debug("message-sync-error", { sessionID: memberID, error: String(error) })
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
          } catch (error) {
            debug("list-error", { sessionID: memberID, error: String(error) })
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
        debug("totals", { sessionID, tree: usage.tree })
        if (disposed) return
        storeAndPublish(sessionID, usage)
      } catch (error) {
        debug("refresh-error", { sessionID, error: String(error) })
      } finally {
        inFlight.delete(sessionID)
      }
    }

    let lastSessionID: string | undefined
    let lastUsage: SessionTreeUsage | undefined

    const tick = (): void => {
      if (disposed) return
      const sessionID = currentSessionID()
      if (sessionID === undefined) return
      if (sessionID !== lastSessionID || lastUsage === undefined || treeIsBusy(lastUsage)) {
        lastSessionID = sessionID
        void refresh(sessionID)
      }
    }

    const storeAndPublish = (sessionID: string, usage: SessionTreeUsage): void => {
      lastSessionID = sessionID
      lastUsage = usage
      const key = `${sessionID}:${JSON.stringify(usage.tree)}`
      if (key === lastKey) return
      lastKey = key
      publish(formatUsageSegments(usage, context.renderer.width))
    }

    // Placeholder until the first snapshot lands.
    const placeholder: UsageLine = [{ text: "…", tone: "metric" }]
    publish([placeholder])
    tick()
    const timer = setInterval(tick, 2000)

    return () => {
      disposed = true
      clearInterval(timer)
      try {
        disposeSlot?.()
      } catch {
        // Best effort on teardown.
      }
    }
  },
})
