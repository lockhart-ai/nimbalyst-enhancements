# Nimbalyst Enhancements

A Nimbalyst extension that gives AI agents the archive action the session list
already has.

## Why

Nimbalyst's agent-facing session tool, `update_session_board`, writes only
`phase` and `tags`:

```js
// main/index.js — update_session_board schema
phase: { type: ['string','null'], enum: ['backlog','planning','implementing','validating','complete', null] },
tags:  { type: 'array', items: { type: 'string' } }
```

The renderer archives a session with a single IPC call:

```js
// renderer — archiveSessionActionAtom
await window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true })
```

There is no agent path to that call, so finished child sessions ("kittens")
accumulate in the session list until a human archives each one by hand.

## What this does

Two global AI tools:

| Tool | Effect |
| --- | --- |
| `sessionarchive.archive_session(sessionId)` | Archives the session — same as the list's Archive context-menu item |
| `sessionarchive.unarchive_session(sessionId)` | Brings it back |

Over MCP they appear as
`mcp__nimbalyst-enhancements__sessionarchive_archive_session` (and
`..._unarchive_session`) on the deferred `nimbalyst-enhancements` server. The
server name is the last dot-segment of the extension id; the tool names keep
their `sessionarchive.` namespace because they describe the archive feature,
not the extension.

Each tool writes, then reads the session row back and reports the **stored**
state, so a silent no-op cannot be reported as success.

## UI additions

The extension also carries two UI changes, both outside any sanctioned
extension point and therefore pinned to the host build they were read from:

- **Sidebar trims** (`styles.css`): the manifest's `styles` file is injected
  into the main document head after the host's own CSS, so equal-specificity
  rules win. It hides the workspace path line, the "Agent Sessions" label,
  and the search row in the session list. Selectors are scoped under
  `.session-history` because `WorkspaceSummaryHeader` is reused elsewhere.
- **Tool-call sidebar** (`src/toolSidebar.tsx`, a `hostComponents` entry): a
  280px column appended to every mounted `.agent-transcript-panel`, listing
  the session's tool calls in order. It reads the session id from the
  enclosing `[data-session-id]`, loads messages with
  `transcript:get-tail-messages`, and reloads on each `transcript:event` for
  that session. It is independent of the "Show Tool Calls in Chat" setting,
  which removes tool cards from the DOM entirely when off. The transcript is
  virtualized, so DOM scraping was never an option.

## How it reaches session state

Extension AI tool handlers run in the renderer realm, and the preload exposes
`invoke(channel, ...args)` with no channel allowlist:

```js
// preload/index.js
invoke: (channel, ...args) => electron.ipcRenderer.invoke(channel, ...args),
```

The built-in Developer Tools extension does the same thing for git
(`window.electronAPI.invoke('git:log', ...)`). This extension calls
`sessions:update-metadata` and `sessions:get`.

Going through the IPC handler rather than the database directly matters: the
handler also tears down the session's provider when `isArchived === true`
(`destroyProviderForArchivedSession`) and broadcasts `sessions:session-updated`
to every window, so the session list updates live.

## Two host quirks this works around

1. **Injected `filePath`.** `getAvailableExtensionTools` appends a *required*
   `filePath` to any extension tool that does not already declare one —
   regardless of `scope: 'global'` or `access: { kind: 'filesystem' }`. The
   tools therefore declare an unused optional `filePath` to suppress it.
2. **Numeric booleans.** `sessions:get` returns `is_archived` straight from
   PGLite as `0`/`1`, not `false`/`true`, so the read-back coerces rather than
   comparing with `===`.

## Build and install

```bash
npm install
npm run typecheck
npm run build
```

Then, with Extension Dev Tools enabled (Settings > Advanced):

```
extension_install  { "path": "/Users/decker/Documents/nimbalyst-enhancements" }
```

`extension_reload` rebuilds via `npm run build` inside the app's environment,
which has no `npm` on its PATH — run `npm run build` yourself and call
`extension_install` again instead.

A newly installed extension gets its own MCP server entry, which agent sessions
read at startup. Sessions started **before** the install will not see the tools;
new sessions will.

## Status

Prototype. Verified end to end against a real session: archive → `is_archived=1`
→ `list_recent_sessions` shows `[ARCHIVED]`; unarchive → `is_archived=0`.
