/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * Updates every 2 seconds while a session in the tree is running.
 */

/** @jsxImportSource @opentui/solid */
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
      const sessionIDs = [...new Set([props.sessionID, ...context.data.session.family(props.sessionID)])]
      await Promise.all(
        sessionIDs.map(async sessionID => {
          try {
            await context.data.session.sync(sessionID)
          } catch {
            // Fall through to message sync; the outer catch keeps the last snapshot.
          }
          await context.data.session.message.sync(sessionID)
        }),
      )
      const family: FamilySessionUsage[] = sessionIDs.map(sessionID => {
        const info = context.data.session.get(sessionID)
        let cost = info?.cost ?? 0
        try {
          cost = context.data.session.cost(sessionID)
        } catch {
          // Keep the SessionInfo cost when the accessor is unavailable.
        }
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
          requests: context.data.session.message
            .list(sessionID)
            .filter(message => message.type === "assistant").length,
        }
      })
      if (!disposed) {
        setTokenData(sessionTreeUsage(props.sessionID, family))
        hasSuccessfulRefresh = true
      }
    } catch {
      // Keep the last successful snapshot when the cached session data is transiently unavailable.
    } finally {
      refreshInProgress = false
    }
  }

  const treeIsBusy = (): boolean =>
    tokenData().sessionIDs.some(sessionID => context.data.session.status(sessionID) === "running")

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
    const disposeSlot = context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => <TokenFooter sessionID={sessionID} />,
    })
    return () => {
      disposeSlot()
    }
  },
})
