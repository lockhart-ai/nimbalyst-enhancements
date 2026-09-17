/**
 * Tool-call sidebar
 *
 * A column to the right of the agent chat transcript that lists the session's
 * tool calls in sequence, independent of the "Show Tool Calls in Chat" setting
 * (which, when off, removes the tool cards from the DOM entirely).
 *
 * The host offers no right-dock slot for extension panels, so this is a
 * `hostComponents` entry: it renders at the app root, watches the document for
 * mounted `.agent-transcript-panel` elements (already a flex row whose right
 * column is empty in agent mode), appends a column element to each, and
 * portals the list into it.
 *
 * Data comes from the same projection the transcript itself uses:
 * `transcript:get-tail-messages` for the initial load, then a reload on every
 * `transcript:event` for that session. Reloading rather than merging keeps the
 * placeholder simple and avoids re-deriving the projector's status rules.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const TRANSCRIPT_PANEL_SELECTOR = '.agent-transcript-panel';
const SESSION_ID_SELECTOR = '[data-session-id]';
const SIDEBAR_CLASS = 'enhancements-tool-sidebar';
const SIDEBAR_MARK = 'data-enhancements-tool-sidebar';

const GET_TAIL_MESSAGES_CHANNEL = 'transcript:get-tail-messages';
const TRANSCRIPT_EVENT_CHANNEL = 'transcript:event';
const TAIL_MESSAGE_COUNT = 5000;
const RELOAD_DEBOUNCE_MS = 150;

const TOOL_LIKE_TYPES = new Set(['tool_call', 'interactive_prompt', 'subagent']);

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

interface ToolCall {
  toolName: string;
  toolDisplayName?: string;
  status?: string;
  description?: string | null;
  arguments?: Record<string, unknown> | null;
  targetFilePath?: string | null;
  isError?: boolean;
  durationMs?: number;
}

interface TranscriptMessage {
  id: string;
  sequence?: number;
  type: string;
  toolCall?: ToolCall;
}

interface TranscriptEvent {
  sessionId?: string;
  eventType?: string;
}

interface PanelBinding {
  panel: HTMLElement;
  sessionId: string;
  mount: HTMLElement;
}

function getBridge(): ElectronBridge | null {
  const maybeWindow = globalThis as { electronAPI?: ElectronBridge };
  const api = maybeWindow.electronAPI;
  if (!api || typeof api.invoke !== 'function' || typeof api.on !== 'function') return null;
  return api;
}

/** One line of context for a call: the file it targets, else its first string argument. */
function summarizeArguments(call: ToolCall): string {
  if (call.targetFilePath) return call.targetFilePath;
  if (call.description) return call.description;
  const args = call.arguments ?? {};
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function statusGlyph(call: ToolCall): { glyph: string; className: string } {
  if (call.isError) return { glyph: '✕', className: 'error' };
  if (call.status === 'running') return { glyph: '…', className: 'running' };
  return { glyph: '✓', className: 'done' };
}

/**
 * Locate every mounted transcript panel, ensure each has a sidebar column
 * appended, and pair it with the session id from the enclosing panel.
 */
function collectBindings(): PanelBinding[] {
  const bindings: PanelBinding[] = [];
  const panels = document.querySelectorAll<HTMLElement>(TRANSCRIPT_PANEL_SELECTOR);
  for (const panel of panels) {
    const owner = panel.closest<HTMLElement>(SESSION_ID_SELECTOR);
    const sessionId = owner?.dataset.sessionId;
    if (!sessionId) continue;
    let mount = panel.querySelector<HTMLElement>(`:scope > [${SIDEBAR_MARK}]`);
    if (!mount) {
      mount = document.createElement('div');
      mount.className = SIDEBAR_CLASS;
      mount.setAttribute(SIDEBAR_MARK, 'true');
      panel.appendChild(mount);
    }
    bindings.push({ panel, sessionId, mount });
  }
  return bindings;
}

function sameBindings(a: PanelBinding[], b: PanelBinding[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.mount === b[i].mount && x.sessionId === b[i].sessionId);
}

/** Watch the document for transcript panels appearing, disappearing, or switching session. */
function useTranscriptPanels(): PanelBinding[] {
  const [bindings, setBindings] = useState<PanelBinding[]>([]);
  const latest = useRef<PanelBinding[]>([]);

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const next = collectBindings();
      if (!sameBindings(latest.current, next)) {
        latest.current = next;
        setBindings(next);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-session-id'],
    });
    sync();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const binding of latest.current) binding.mount.remove();
      latest.current = [];
    };
  }, []);

  return bindings;
}

/** Load a session's tool-like messages and keep them fresh from the event stream. */
function useToolCalls(sessionId: string): { calls: TranscriptMessage[]; error: string | null } {
  const [calls, setCalls] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) {
      setError('Nimbalyst IPC bridge is not available.');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const messages = (await bridge.invoke(
          GET_TAIL_MESSAGES_CHANNEL,
          sessionId,
          TAIL_MESSAGE_COUNT,
        )) as TranscriptMessage[];
        if (cancelled) return;
        setCalls(messages.filter((m) => TOOL_LIKE_TYPES.has(m.type) && m.toolCall));
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };
    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    };
    const unsubscribe = bridge.on(TRANSCRIPT_EVENT_CHANNEL, (raw: unknown) => {
      const event = raw as TranscriptEvent | undefined;
      if (event?.sessionId === sessionId) scheduleReload();
    });

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [sessionId]);

  return { calls, error };
}

function ToolCallRow({ index, message }: { index: number; message: TranscriptMessage }) {
  const call = message.toolCall as ToolCall;
  const name = call.toolDisplayName || call.toolName;
  const summary = summarizeArguments(call);
  const status = statusGlyph(call);
  return (
    <li className="enhancements-tool-row" title={summary}>
      <span className="enhancements-tool-index">{index + 1}</span>
      <span className={`enhancements-tool-status ${status.className}`}>{status.glyph}</span>
      <span className="enhancements-tool-name">{name}</span>
      {summary ? <span className="enhancements-tool-summary">{summary}</span> : null}
    </li>
  );
}

function ToolCallList({ sessionId }: { sessionId: string }) {
  const { calls, error } = useToolCalls(sessionId);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [calls.length]);

  return (
    <div className="enhancements-tool-panel">
      <div className="enhancements-tool-header">
        <span className="enhancements-tool-title">Tool calls</span>
        <span className="enhancements-tool-count">{calls.length}</span>
      </div>
      {error ? <div className="enhancements-tool-error">{error}</div> : null}
      {!error && calls.length === 0 ? (
        <div className="enhancements-tool-empty">No tool calls yet</div>
      ) : null}
      <ol ref={listRef} className="enhancements-tool-list">
        {calls.map((message, index) => (
          <ToolCallRow key={message.id} index={index} message={message} />
        ))}
      </ol>
    </div>
  );
}

/** The host component: one portal per mounted transcript panel. */
export function ToolCallSidebarHost() {
  const bindings = useTranscriptPanels();
  return (
    <>
      {bindings.map((binding) =>
        createPortal(
          <ToolCallList key={binding.sessionId} sessionId={binding.sessionId} />,
          binding.mount,
          binding.sessionId,
        ),
      )}
    </>
  );
}
