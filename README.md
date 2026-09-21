# opencode-tui-token-usage

Sidebar token-usage footer for OpenCode, built as a native **V2** plugin
package. It replaces the legacy V1 loose files (`session-usage.tsx` /
`session-usage-core.ts` plus the V1 `tui.jsonc` reference) that V2 can no
longer load.

The footer renders `MAIN` / `TOT` usage lines (input/out/cache/think/write,
request and agent counts, cache hit-rate, cost) for the current session and
its whole session family. A live throughput section is prepended while an
assistant response streams (rolling tok/s, average tok/s, estimated
output tokens, elapsed time), replaced by a final `✓` summary with
provider-reported totals when the step ends. Refreshes are event-driven
(`session.usage.updated`,
execution start/finish, session viewed/created, server connect — debounced
at 400ms). Tab switches emit no server event, so a reactive route watcher
refreshes instantly when the host notifies, backed by a 1s router poll that
syncs only on session change; a quiet-but-busy tree re-syncs after 5s
without event traffic.

Tested against OpenCode `v2.0.11` (`@opencode/plugin@2.0.11`).

## Layout

```text
./
  package.json   # exports "." (server) + "./tui" (CLI); @opencode/plugin dep
  src/index.ts   # minimal server entry (id "token-tracker", no behavior)
  src/tui.tsx    # V2 CLI entry (id "token-tracker.tui"): event subscriptions,
                 # refresh loop, and static sidebar.footer slot content
  src/core.ts    # usage aggregation / formatting (no plugin entrypoint)
  src/throughput.ts  # live/final tok/s tracking + formatting (no entrypoint)
```

## Live throughput

Design reference: `npm:pi-live-throughput` as used in the Pi coding agent.
While a response streams, the footer prepends a labeled section styled
like the MAIN/TOT blocks (7-cell label column, continuation indent):

```text
⚡       ~92.3 tok/s · avg 84.5
       ~1.2k tok · 14.2s
```

When the step ends it is replaced by a final summary that persists until
the next response starts:

```text
✓        512 tok · 120 tok/s avg
       peak 319 tok/s · 4.2s
       TTFT 420ms · input 1.2k tok
```

Over-wide rows fall back to a narrow one-metric-per-line layout, the same
primary/narrow strategy `core.ts` uses for MAIN/TOT.

Adaptations for OpenCode: provider token counts are exposed only at step
boundaries (`session.step.ended`), never during the stream, so all live
figures are chars/4 heuristic estimates over text, reasoning, and
tool-input deltas (labeled `est.` / `~`); the final summary always uses
provider-reported step tokens. TTFT runs from `session.execution.started`
(fallback: `session.step.started`) to the first delta, and rate measurement
starts only after a second output token so TTFT never dilutes the rolling
(3s window), average, or peak rates. Live updates are delta-driven at up to
4Hz plus a 1Hz tick refresh, perform no server sync, and reuse the static
slot re-registration path; over-wide rows fall back to compact or
continuation layouts instead of wrapping.

Only `src/index.ts` and `src/tui.tsx` are package entries, so `src/core.ts`
is never probed as a plugin — this is what caused the old
`Missing key at ["default"]` load failure when the helper lived directly
under the global `plugins/` directory.

## Install

```sh
opencode plugin add github:welium/opencode-tui-token-usage
```

Pin a tag or commit (`github:welium/opencode-tui-token-usage#vX.Y.Z`) once
stable so `plugin update` does not move it silently.

A package in `opencode.json(c)` that exposes a `./tui` component is loaded
automatically by the CLI, so no `cli.json` entry is needed. Use
`cli.json` only if the footer must stay active against a remote server.

Verify after install or update (restart the TUI to load a new `./tui` entry):

```sh
opencode plugin list   # token-tracker served from the GitHub package
```

Open the TUI on a session with subagents and confirm the `MAIN` / `TOT`
lines, the narrow-layout fallback on slim terminals, prompt updates while
tokens stream, and instant refresh on tab switches.

## V1 -> V2 mapping notes

- Entrypoint: `TuiPlugin` + `api.slots.register({ slots: { sidebar_footer } })`
  became `Plugin.define({ id: "token-tracker.tui", setup })` with
  `context.ui.slot({ append: "sidebar.footer", render })`.
- Child discovery: `client.session.children()` (per-session BFS) became the
  cached `context.data.session.family(sessionID)` call.
- Messages/status: `state.session.messages/status` became
  `context.data.session.message.list` / `context.data.session.status`,
  which returns `"idle"` / `"running"` (was `{ type: "busy" }`).
  The data API serves a local cache, so each refresh first calls
  `session.sync` + `message.sync` for every known family member.
- Theme/renderer: `theme().primary / textMuted / text` became
  `theme.text.action.primary.base / theme.text.muted / theme.text.base`;
  width still comes from `renderer.width`.
- Telemetry: V2 moved token/cost telemetry from messages to the session
  (`SessionInfo.tokens`/`cost`; messages carry neither), so totals are
  summed per family member via `data.session.get`/`cost`, with the request
  count still derived from each session's assistant message count.
- Updates: refreshes trigger on `session.usage.updated`, execution
  start/finish, `session.viewed`/`created` (refreshing the event's session
  directly, since the router may lag the event), and `server.connected`
  (debounced). Tab switches emit no server event, so a reactive route
  watcher refreshes instantly when the host notifies, backed by a 1s router
  poll that syncs only on change; a quiet-but-busy tree re-syncs after 5s.
- Rendering: the slot claim is re-registered per changed snapshot with
  fully static content. Signal updates were observed never to propagate
  into slot JSX from an installed package (while fresh mounts render
  reliably), so the render path uses no signals, effects, or conditional
  helpers. Suspected cause: the managed install materializes nested
  `solid-js`/`@opentui` copies that shadow the host runtime.

## Development

```sh
npm install
./node_modules/.bin/tsc --noEmit
```
