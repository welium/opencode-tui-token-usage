/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * Updates every 2 seconds while a session in the tree is running.
 */

/** @jsxImportSource @opentui/solid */
import { appendFileSync } from "node:fs"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import {
  emptySession,
  formatUsageSegments,
  sessionTreeUsage,
  type FamilySessionUsage,
  type SessionTreeUsage,
  type UsageSegmentTone,
} from "./core"

// TEMPORARY diagnostic tracing (removed before the real fix). One JSON line
// per event so a stuck-at-zero footer can be attributed to a concrete cause.
const DEBUG_LOG = "/tmp/opencode/tui-token-usage-debug.log"
const DEBUG_BUILD = "diag1"
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

function TokenFooter(props: { sessionID: string }) {
  const context = usePlugin()

  const [tokenData, setTokenData] = createSignal<SessionTreeUsage>(
    sessionTreeUsage(props.sessionID, [emptySession(props.sessionID)]),
  )
  let refreshInProgress = false
  let hasSuccessfulRefresh = false
  let disposed = false

  const refresh = async (): Promise<void> => {
    if (refreshInProgress || disposed) return
    refreshInProgress = true

    try {
      // The data API serves a local cache: sync the family into it first,
      // otherwise reads come back empty and the footer sticks at zero.
      // Telemetry is session-level in V2 (messages carry no tokens/cost),
      // so totals are summed from each member's SessionInfo.
      let familyIDs: string[]
      try {
        familyIDs = context.data.session.family(props.sessionID)
        debug("family", { sessionID: props.sessionID, familyIDs })
      } catch (error) {
        debug("family-error", { sessionID: props.sessionID, error: String(error) })
        throw error
      }
      const sessionIDs = [...new Set([props.sessionID, ...familyIDs])]
      const syncResults = await Promise.all(
        sessionIDs.map(async sessionID => {
          let sessionSync = "ok"
          try {
            await context.data.session.sync(sessionID)
          } catch (error) {
            sessionSync = String(error)
          }
          let messageSync = "ok"
          try {
            await context.data.session.message.sync(sessionID)
          } catch (error) {
            messageSync = String(error)
          }
          return { sessionID, sessionSync, messageSync }
        }),
      )
      debug("sync", { sessionID: props.sessionID, syncResults })
      const family: FamilySessionUsage[] = sessionIDs.map(sessionID => {
        const info = context.data.session.get(sessionID)
        let cost = info?.cost ?? 0
        let costSource = "info"
        try {
          cost = context.data.session.cost(sessionID)
          costSource = "accessor"
        } catch (error) {
          debug("cost-error", { sessionID, error: String(error) })
        }
        let listLength = -1
        let assistantCount = -1
        try {
          const messages = context.data.session.message.list(sessionID)
          listLength = messages.length
          assistantCount = messages.filter(message => message.type === "assistant").length
        } catch (error) {
          debug("list-error", { sessionID, error: String(error) })
        }
        debug("member", {
          sessionID,
          hasInfo: info !== undefined,
          tokens: info?.tokens,
          infoCost: info?.cost,
          cost,
          costSource,
          listLength,
          assistantCount,
        })
        return {
          id: sessionID,
          tokens: {
            input: info?.tokens.input ?? 0,
            output: info?.tokens.output ?? 0,
            reasoning: info?.tokens.reasoning ?? 0,
            cacheRead: info?.tokens.cache.read ?? 0,
            cacheWrite: info?.tokens.cache.write ?? 0,
          },
          cost,
          requests: assistantCount < 0 ? 0 : assistantCount,
        }
      })
      const usage = sessionTreeUsage(props.sessionID, family)
      debug("totals", { sessionID: props.sessionID, root: usage.root, tree: usage.tree })
      if (!disposed) {
        setTokenData(usage)
        hasSuccessfulRefresh = true
      }
    } catch (error) {
      debug("refresh-error", { sessionID: props.sessionID, error: String(error) })
      // Keep the last successful snapshot when the cached session data is transiently unavailable.
    } finally {
      refreshInProgress = false
    }
  }

  const treeIsBusy = (): boolean => {
    try {
      return tokenData().sessionIDs.some(sessionID => context.data.session.status(sessionID) === "running")
    } catch (error) {
      debug("status-error", { error: String(error) })
      return true
    }
  }

  void refresh()
  const timer = setInterval(() => {
    if (!hasSuccessfulRefresh || treeIsBusy()) void refresh()
  }, 2000)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })

  const usageLines = () => formatUsageSegments(tokenData(), context.renderer.width)

  const segmentColor = (tone: UsageSegmentTone) => {
    if (tone === "label") return context.theme.text.action.primary.base
    if (tone === "metric" || tone === "separator") return context.theme.text.muted
    return context.theme.text.base
  }

  return (
    <box>
      {usageLines().map(line => (
        <text>
          {line.map(segment => (
            <span style={{ fg: segmentColor(segment.tone) }}>{segment.text}</span>
          ))}
        </text>
      ))}
    </box>
  )
}

export default Plugin.define({
  id: "token-tracker.tui",
  setup(context) {
    debug("setup", { options: context.options })
    const disposeSlot = context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => <TokenFooter sessionID={sessionID} />,
    })
    return () => {
      disposeSlot()
    }
  },
})
