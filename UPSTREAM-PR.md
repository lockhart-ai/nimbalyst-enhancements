# Upstream sketch: add `archived` to `update_session_board`

The extension in this directory is a hot-patch. The right fix is upstream, in
the same file that already owns the tool. Two edits in
`src/main/.../mcpToolSchemas` + the session-context dispatcher (both inlined
next to each other in the packaged `main/index.js`).

## 1. Schema

```diff
   {
     name: "update_session_board",
-    description: "Update a session's kanban board metadata (phase and/or tags). ...",
+    description: "Update a session's kanban board metadata (phase, tags, and/or archived state). Phase controls which column the session appears in on the Sessions Board. Tags are free-form strings for categorization. Archiving removes a finished session from the session list without deleting it. Any field can be provided independently.",
     inputSchema: {
       type: "object",
       properties: {
         sessionId: { type: "string", description: "ID of the session to update. Use list_recent_sessions to find session IDs." },
         phase: { type: ["string", "null"], enum: [...], description: "..." },
         tags: { type: "array", items: { type: "string" }, description: "..." },
+        archived: {
+          type: "boolean",
+          description: "True to archive the session (removes it from the session list without deleting it; list_recent_sessions still returns it with includeArchived: true). False to unarchive. Omit to leave unchanged."
+        },
       },
       required: ["sessionId"],
     },
   },
```

## 2. Dispatcher

```diff
       case "update_session_board": {
         const sessionId = args?.sessionId;
         const phase = args?.phase;
         const tags = args?.tags;
+        const archived = args?.archived;
         if (!sessionId) { ...unchanged... }
-        if (phase === undefined && tags === undefined) {
-          return { ... "Error: at least one of phase or tags must be provided" ... };
+        if (phase === undefined && tags === undefined && archived === undefined) {
+          return { ... "Error: at least one of phase, tags, or archived must be provided" ... };
         }
         ...phase / tags validation unchanged...
+        if (archived !== undefined && typeof archived !== "boolean") {
+          return { content: [{ type: "text", text: "Error: archived must be a boolean" }], isError: true };
+        }

         const metadataUpdate = {};
         if (phase !== undefined) metadataUpdate.phase = phase ?? undefined;
         if (tags !== undefined) metadataUpdate.tags = tags;
-        await AISessionsRepository.updateMetadata(sessionId, { metadata: metadataUpdate });
+        await AISessionsRepository.updateMetadata(sessionId, {
+          ...(Object.keys(metadataUpdate).length > 0 ? { metadata: metadataUpdate } : {}),
+          ...(archived !== undefined ? { isArchived: archived } : {}),
+        });
+        if (archived === true) {
+          destroyProviderForArchivedSession(
+            sessionId,
+            (id) => ProviderFactory.destroyProvider(id),
+            (id, err) => console.error(`[update_session_board] provider cleanup failed for ${id}:`, err),
+          );
+        }

         const rendererUpdate = {};
         if (phase !== undefined) rendererUpdate.phase = phase;
         if (tags !== undefined) rendererUpdate.tags = tags;
+        if (archived !== undefined) rendererUpdate.isArchived = archived;
         ...broadcast unchanged...
```

## Why `isArchived` sits outside `metadata`

`phase` and `tags` live in the `metadata` JSONB blob; `isArchived` is a
top-level `ai_sessions` column and one of the fields the sync layer forwards:

```js
// SyncedSessionMetadata columns
columns: ["title","mode","isArchived","isPinned","hasBeenNamed","provider","model", ...]
```

Nesting it under `metadata` would write a JSON key nobody reads and leave the
column untouched.

## Don't skip the provider teardown

The `sessions:update-metadata` IPC handler does more than the column write:

```js
await AISessionsRepository.updateMetadata(sessionId, updates);
if (updates.isArchived === true) {
  destroyProviderForArchivedSession(sessionId, ...);
}
```

A tool that only writes the column would archive a session while leaving its
provider alive. The diff above replicates the teardown. The alternative — have
the tool call the same shared helper the IPC handler calls — is cleaner still,
and is what a real PR should do rather than duplicating the two call sites.

## Tests worth adding

- `archived: true` sets the column and leaves `phase`/`tags` untouched.
- `archived` alone (no phase, no tags) is accepted — the current
  "at least one of phase or tags" guard rejects it.
- Archiving a session with a live provider destroys the provider.
- `update_session_board` + `list_recent_sessions` round trip: archived sessions
  are excluded by default and returned with `[ARCHIVED]` under
  `includeArchived: true`.
