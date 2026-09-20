/**
 * Session tree token usage panel (sidebar.footer slot)
 *
 * Displays recorded token usage for the current session and all descendants.
 *
 * Updates every 2 seconds while a session in the tree is running.
 */

/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { SessionMessageInfo } from "@opencode/client"
import { createSignal, onCleanup } from "solid-js"
import {
  aggregateRecordedMessages,
  collectSessionTreeUsage,
  formatUsageSegments,
  type MessageWithTelemetry,
  type SessionTreeUsage,
  type UsageSegmentTone,
} from "./core"

/** Adapt a cached V2 session message to the structural telemetry shape. */
function toTelemetry(message: SessionMessageInfo): MessageWithTelemetry {
  if (message.type !== "assistant") return { id: message.id, type: message.type }
  return { id: message.id, type: message.type, cost: message.cost, tokens: message.tokens }
}

function TokenFooter(props: { sessionID: string }) {
  const context = usePlugin()

  const [tokenData, setTokenData] = createSignal<SessionTreeUsage>({
    root: aggregateRecordedMessages([]),
    tree: aggregateRecordedMessages([]),
    sessionIDs: [props.sessionID],
  })
  let refreshInProgress = false
  let hasSuccessfulRefresh = false
  let disposed = false

  const refresh = async (): Promise<void> => {
    if (refreshInProgress || disposed) return
    refreshInProgress = true

    try {
      const usage = await collectSessionTreeUsage(
        props.sessionID,
        sessionID => Promise.resolve(context.data.session.family(sessionID).map(id => ({ id }))),
        sessionID => context.data.session.message.list(sessionID).map(toTelemetry),
      )
      if (!disposed) {
        setTokenData(usage)
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
