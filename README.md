# opencode-tui-token-usage

Sidebar token-usage footer for OpenCode, built as a native **V2** plugin
package. It replaces the legacy V1 loose files (`session-usage.tsx` /
`session-usage-core.ts` plus the V1 `tui.jsonc` reference) that V2 can no
longer load.

The footer renders `MAIN` / `TOT` usage lines (input/out/cache/think/write,
request and agent counts, cache hit-rate, cost) for the current session and
its whole session family, refreshing every 2 seconds while the tree is
running.

Tested against OpenCode `v2.0.11` (`@opencode/plugin@2.0.11`).

## Layout

```text
./
  package.json   # exports "." (server) + "./tui" (CLI); @opencode/plugin dep
  src/index.ts   # minimal server entry (id "token-tracker", no behavior)
  src/tui.tsx    # V2 CLI entry: sidebar.footer slot + TokenFooter
  src/core.ts    # usage aggregation / formatting (no plugin entrypoint)
```

Only `src/index.ts` and `src/tui.tsx` are package entries, so `src/core.ts`
is never probed as a plugin — this is what caused the old
`Missing key at ["default"]` load failure when the helper lived directly
under the global `plugins/` directory.

## Install (consumer side)

```sh
opencode plugin add github:welium/opencode-tui-token-usage
```

Replace the version with a tag or commit (`#vX.Y.Z`) once stable so
`plugin update` does not move it silently.

A package in `opencode.json(c)` that exposes a `./tui` component is loaded
automatically by the CLI, so no `cli.json` entry is needed. Use
`cli.json` only if the footer must stay active against a remote server.

## Retire the legacy files (consumer side, `~/.config/opencode`)

1. In `opencode.jsonc`, rename `plugin` to `plugins` and keep the new
   package entry; touch nothing else.
2. Delete `plugins/session-usage.tsx` and `plugins/session-usage-core.ts`.
3. Remove the stale `./plugins/session-usage.tsx` entry from `tui.jsonc`
   (delete the file if it holds nothing else).

Then verify:

```sh
opencode plugin list          # token-tracker served from the GitHub package
opencode service restart
grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log  # expect nothing
```

Open the TUI on a session with subagents and confirm the `MAIN` / `TOT`
lines, the narrow-layout fallback, and the 2-second refresh while busy.

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
  `session.sync` + `message.sync` for every known family member —
  without that the footer reads empty and sticks at zero. Caveat: the
  plugin-facing API exposes no full-history loader, so on very long
  sessions totals cover the synced window rather than all history.
- Theme/renderer: `theme().primary / textMuted / text` became
  `theme.text.action.primary.base / theme.text.muted / theme.text.base`;
  width still comes from `renderer.width`.
- Telemetry: V2 moved token/cost telemetry from messages to the session
  (`SessionInfo.tokens`/`cost`; messages carry neither), so totals are
  summed per family member via `data.session.get`/`cost`, with the request
  count still derived from each session's assistant message count.

## Development

```sh
npm install
./node_modules/.bin/tsc --noEmit
```
