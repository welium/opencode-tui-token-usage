/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * State lives at setup scope (never inside the slot render): the footer
 * render is a pure reader of the latest snapshot, refreshed on a setup-owned
 * 2s timer while the tree is running. Per-render signals/timers miss updates
 * when the host disposes render roots, freezing the footer at zeros.
 */

/** @jsxImportSource @opentui/solid */
import { appendFileSync } from "node:fs"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import {
  emptySession,
  formatUsageSegments,
  sessionTreeUsage,
  type FamilySessionUsage,
  type SessionTreeUsage,
  type UsageSegmentTone,
} from "./core"

// TEMPORARY diagnostic tracing (removed before the final cleanup).
const DEBUG_LOG = "/tmp/opencode/tui-token-usage-debug.log"
const DEBUG_BUILD = "diag3"
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

type Snapshot = {
  readonly sessionID: string
  readonly usage: SessionTreeUsage
}

function TokenFooter(props: {
  sessionID: string
  snapshot: () => Snapshot | undefined
  ensure: (sessionID: string) => void
}) {
  const context = usePlugin()

  const data = (): SessionTreeUsage | undefined => {
    const snap = props.snapshot()
    return snap !== undefined && snap.sessionID === props.sessionID ? snap.usage : undefined
  }

  createEffect(() => {
    if (data() === undefined) props.ensure(props.sessionID)
  })

  const usageLines = () => {
    const usage = data()
    if (usage === undefined) return []
    try {
      const width = context.renderer.width
      const lines = formatUsageSegments(usage, width)
      debug("render-lines", {
        sessionID: props.sessionID,
        width,
        tree: usage.tree,
        texts: lines.map(line => line.map(segment => segment.text).join("")),
      })
      return lines
    } catch (error) {
      debug("render-lines-error", { sessionID: props.sessionID, error: String(error) })
      throw error
    }
  }

  const segmentColor = (tone: UsageSegmentTone) => {
    try {
      if (tone === "label") return context.theme.text.action.primary.base
      if (tone === "metric" || tone === "separator") return context.theme.text.muted
      return context.theme.text.base
    } catch (error) {
      debug("render-color-error", { sessionID: props.sessionID, tone, error: String(error) })
      try {
        return context.theme.text.base
      } catch {
        return undefined
      }
    }
  }

  return (
    <Show
      when={data()}
      fallback={
        <text>
          <span>…</span>
        </text>
      }
    >
      <box>
        {usageLines().map(line => (
          <text>
            {line.map(segment => (
              <span style={{ fg: segmentColor(segment.tone) }}>{segment.text}</span>
            ))}
          </text>
        ))}
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "token-tracker.tui",
  setup(context) {
    debug("setup", { options: context.options })
    const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)
    const inFlight = new Set<string>()
    let disposed = false

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
            let sessionSync = "ok"
            try {
              await context.data.session.sync(memberID)
            } catch (error) {
              sessionSync = String(error)
            }
            let messageSync = "ok"
            try {
              await context.data.session.message.sync(memberID)
            } catch (error) {
              messageSync = String(error)
            }
            return { memberID, sessionSync, messageSync }
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
        debug("totals", { sessionID, root: usage.root, tree: usage.tree })
        if (!disposed) setSnapshot({ sessionID, usage })
      } catch (error) {
        debug("refresh-error", { sessionID, error: String(error) })
      } finally {
        inFlight.delete(sessionID)
      }
    }

    const ensure = (sessionID: string): void => {
      if (snapshot()?.sessionID !== sessionID) {
        debug("ensure", { sessionID })
        void refresh(sessionID)
      }
    }

    const tick = (): void => {
      const sessionID = currentSessionID()
      if (sessionID === undefined || disposed) return
      const snap = snapshot()
      if (snap?.sessionID !== sessionID || treeIsBusy(snap.usage)) void refresh(sessionID)
    }

    void tick()
    const timer = setInterval(tick, 2000)

    const disposeSlot = context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => (
        <TokenFooter sessionID={sessionID} snapshot={snapshot} ensure={ensure} />
      ),
    })
    return () => {
      disposed = true
      clearInterval(timer)
      disposeSlot()
    }
  },
})
