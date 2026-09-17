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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  mcpServer?: string | null;
  mcpTool?: string | null;
  result?: unknown;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  providerToolCallId?: string;
}

const TOOLTIP_WIDTH = 440;
const TOOLTIP_GAP = 8;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_TEXT_LIMIT = 6000;

interface HoverTarget {
  message: TranscriptMessage;
  anchor: DOMRect;
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

/** Render any value as readable text, JSON for structures, clipped past the limit. */
function formatDetail(value: unknown): string {
  let text: string;
  if (value === undefined || value === null) text = '';
  else if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length > TOOLTIP_TEXT_LIMIT) {
    const omitted = text.length - TOOLTIP_TEXT_LIMIT;
    return `${text.slice(0, TOOLTIP_TEXT_LIMIT)}\n… ${omitted} more characters`;
  }
  return text;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
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

/**
 * Fixed-position detail card, portaled to the body so the sidebar's overflow
 * clipping cannot cut it off. Prefers the left of the row (the sidebar hugs
 * the right edge), falls back to the right, and is clamped to the viewport
 * vertically after measuring its real height.
 */
function ToolCallTooltip({ target }: { target: HoverTarget }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({
    left: target.anchor.left - TOOLTIP_WIDTH - TOOLTIP_GAP,
    top: target.anchor.top,
  });

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const height = card.offsetHeight;
    let left = target.anchor.left - TOOLTIP_WIDTH - TOOLTIP_GAP;
    if (left < TOOLTIP_MARGIN) left = target.anchor.right + TOOLTIP_GAP;
    let top = target.anchor.top;
    const maxTop = window.innerHeight - height - TOOLTIP_MARGIN;
    if (top > maxTop) top = Math.max(TOOLTIP_MARGIN, maxTop);
    setPosition({ left, top });
  }, [target]);

  const call = target.message.toolCall as ToolCall;
  const name = call.toolDisplayName || call.toolName;
  const status = statusGlyph(call);
  const args = formatDetail(call.arguments);
  const result = formatDetail(call.result);
  const meta: Array<[string, string]> = [];
  if (call.status) meta.push(['Status', call.isError ? `${call.status} (error)` : call.status]);
  if (call.durationMs !== undefined) meta.push(['Duration', formatDuration(call.durationMs)]);
  if (call.exitCode !== undefined) meta.push(['Exit code', String(call.exitCode)]);
  if (call.targetFilePath) meta.push(['File', call.targetFilePath]);
  if (call.mcpServer) meta.push(['MCP', `${call.mcpServer} / ${call.mcpTool ?? ''}`]);
  if (call.description) meta.push(['Description', call.description]);
  if (call.providerToolCallId) meta.push(['Call id', call.providerToolCallId]);

  return createPortal(
    <div
      ref={cardRef}
      className="enhancements-tool-tooltip"
      style={{ left: position.left, top: position.top, width: TOOLTIP_WIDTH }}
    >
      <div className="enhancements-tool-tooltip-title">
        <span className={`enhancements-tool-status ${status.className}`}>{status.glyph}</span>
        <span className="enhancements-tool-tooltip-name">{name}</span>
        {call.toolDisplayName && call.toolDisplayName !== call.toolName ? (
          <span className="enhancements-tool-tooltip-raw">{call.toolName}</span>
        ) : null}
      </div>
      {meta.length ? (
        <dl className="enhancements-tool-tooltip-meta">
          {meta.map(([label, value]) => (
            <div key={label} className="enhancements-tool-tooltip-meta-row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {args ? (
        <div className="enhancements-tool-tooltip-section">
          <div className="enhancements-tool-tooltip-label">Arguments</div>
          <pre className="enhancements-tool-tooltip-pre">{args}</pre>
        </div>
      ) : null}
      {result ? (
        <div className="enhancements-tool-tooltip-section">
          <div className="enhancements-tool-tooltip-label">Result</div>
          <pre className="enhancements-tool-tooltip-pre">{result}</pre>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function ToolCallRow({
  index,
  message,
  onHover,
}: {
  index: number;
  message: TranscriptMessage;
  onHover: (target: HoverTarget | null) => void;
}) {
  const call = message.toolCall as ToolCall;
  const name = call.toolDisplayName || call.toolName;
  const summary = summarizeArguments(call);
  const status = statusGlyph(call);
  return (
    <li
      className="enhancements-tool-row"
      onMouseEnter={(event) =>
        onHover({ message, anchor: event.currentTarget.getBoundingClientRect() })
      }
      onMouseLeave={() => onHover(null)}
    >
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
  const [hovered, setHovered] = useState<HoverTarget | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [calls.length]);

  // A scroll or a data refresh moves the rows out from under the card.
  useEffect(() => {
    setHovered(null);
  }, [calls]);

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
      <ol ref={listRef} className="enhancements-tool-list" onScroll={() => setHovered(null)}>
        {calls.map((message, index) => (
          <ToolCallRow key={message.id} index={index} message={message} onHover={setHovered} />
        ))}
      </ol>
      {hovered ? <ToolCallTooltip target={hovered} /> : null}
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
