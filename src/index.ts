/**
 * Nimbalyst Enhancements: session archive tools
 *
 * Nimbalyst's session list can archive a session from its context menu, but the
 * agent-facing MCP tool `update_session_board` only writes `phase` and `tags`.
 * A finished child session therefore stays in the list forever unless a human
 * archives it by hand.
 *
 * The renderer's archive action is one IPC call:
 *
 *   window.electronAPI.invoke('sessions:update-metadata', sessionId, { isArchived: true })
 *
 * Extension AI tool handlers run in that same renderer realm (the built-in
 * Developer Tools extension's `git_log` handler calls
 * `window.electronAPI.invoke('git:log', ...)` the same way), and the preload
 * exposes `invoke(channel, ...args)` without a channel allowlist. So the tool
 * below performs exactly the call the context menu performs -- no new privilege,
 * no private state, no database access.
 */

import type { ExtensionAITool, ExtensionToolResult } from '@nimbalyst/extension-sdk';
import { ToolCallSidebarHost } from './toolSidebar';

const UPDATE_METADATA_CHANNEL = 'sessions:update-metadata';
const GET_SESSION_CHANNEL = 'sessions:get';

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface UpdateMetadataResult {
  success: boolean;
  error?: string;
}

interface SessionSummary {
  id: string;
  title?: string;
  isArchived?: boolean;
}

/**
 * `sessions:get` passes the stored column through as-is, and PGLite hands back
 * `is_archived` as a number (0/1) rather than a boolean, so a strict `=== true`
 * comparison reads every archived session as unarchived.
 */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1' || value === 't';
  return false;
}

interface GetSessionResult {
  success: boolean;
  error?: string;
  session?: SessionSummary | null;
}

function getBridge(): ElectronBridge | null {
  const maybeWindow = globalThis as { electronAPI?: ElectronBridge };
  const api = maybeWindow.electronAPI;
  if (!api || typeof api.invoke !== 'function') return null;
  return api;
}

function readSessionId(args: Record<string, unknown>): string | null {
  const raw = args.sessionId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Set `isArchived` on one session and read the stored row back, so the tool
 * result states what is actually true rather than what was requested.
 */
async function setArchived(
  args: Record<string, unknown>,
  isArchived: boolean,
): Promise<ExtensionToolResult> {
  const sessionId = readSessionId(args);
  if (!sessionId) {
    return { success: false, error: 'sessionId is required and must be a non-empty string.' };
  }

  const bridge = getBridge();
  if (!bridge) {
    return { success: false, error: 'Nimbalyst IPC bridge (window.electronAPI) is not available.' };
  }

  const verb = isArchived ? 'archive' : 'unarchive';

  let update: UpdateMetadataResult;
  try {
    update = (await bridge.invoke(UPDATE_METADATA_CHANNEL, sessionId, {
      isArchived,
    })) as UpdateMetadataResult;
  } catch (error) {
    return {
      success: false,
      error: `Failed to ${verb} session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!update || update.success !== true) {
    return {
      success: false,
      error: `Nimbalyst rejected the ${verb} of session ${sessionId}: ${update?.error ?? 'unknown error'}`,
    };
  }

  const stored = await readBackSession(bridge, sessionId);
  if (stored && stored.isArchived !== isArchived) {
    return {
      success: false,
      error: `Session ${sessionId} still reads isArchived=${String(stored.isArchived)} after the ${verb}.`,
    };
  }

  const title = stored?.title;
  return {
    success: true,
    message: `Session ${sessionId}${title ? ` ("${title}")` : ''} is now ${isArchived ? 'archived' : 'unarchived'}.`,
    data: {
      sessionId,
      title,
      isArchived: stored ? stored.isArchived : isArchived,
      verified: stored !== null,
    },
  };
}

/**
 * Read the session row back after the write. A read-back failure is reported as
 * unverified rather than swallowed -- the write itself already succeeded.
 */
async function readBackSession(
  bridge: ElectronBridge,
  sessionId: string,
): Promise<SessionSummary | null> {
  try {
    const result = (await bridge.invoke(GET_SESSION_CHANNEL, sessionId)) as GetSessionResult;
    if (!result?.success || !result.session) return null;
    return {
      id: result.session.id,
      title: result.session.title,
      isArchived: toBoolean(result.session.isArchived),
    };
  } catch {
    return null;
  }
}

export const components = {};

/** Mounted once at the app root; see toolSidebar.tsx. */
export const hostComponents = {
  ToolCallSidebarHost,
};

export const aiTools: ExtensionAITool[] = [
  {
    name: 'sessionarchive.archive_session',
    description:
      "Archive a Nimbalyst session so it leaves the session list. Same effect as the session list's Archive context-menu action. Use it on finished child sessions once their work is merged or reported. Find session ids with list_recent_sessions or list_spawned_sessions. Archiving does not delete anything: the session is still readable, and list_recent_sessions with includeArchived: true still returns it.",
    scope: 'global',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the session to archive.',
        },
        // Declared only to suppress the host's injected `filePath`: the MCP
        // layer appends a *required* filePath to any extension tool that does
        // not already declare one, which would make this session-level tool
        // uncallable without naming an unrelated file. Never read.
        filePath: {
          type: 'string',
          description: 'Unused. This tool operates on a session, not a file.',
        },
      },
      required: ['sessionId'],
    },
    handler: async (args): Promise<ExtensionToolResult> =>
      setArchived((args ?? {}) as Record<string, unknown>, true),
  },
  {
    name: 'sessionarchive.unarchive_session',
    description:
      'Bring an archived Nimbalyst session back into the session list. Use it to undo an archive.',
    scope: 'global',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'ID of the session to unarchive.',
        },
        // See archive_session: declared only to suppress the injected required
        // `filePath`. Never read.
        filePath: {
          type: 'string',
          description: 'Unused. This tool operates on a session, not a file.',
        },
      },
      required: ['sessionId'],
    },
    handler: async (args): Promise<ExtensionToolResult> =>
      setArchived((args ?? {}) as Record<string, unknown>, false),
  },
];

export async function activate(): Promise<void> {
  console.log('[SessionArchive] Extension activated');
}

export async function deactivate(): Promise<void> {
  console.log('[SessionArchive] Extension deactivated');
}
