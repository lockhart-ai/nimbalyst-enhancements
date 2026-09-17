/**
 * Bottom-right panel: Nekomata
 *
 * A column on the right of the terminal bottom panel hosting Nekomata, the
 * cat-cafe fleet visualizer. Nimbalyst's own `bottom` placement for extension
 * panels stacks a second container *under* the terminals rather than beside
 * them, and the terminal panel has no split support, so this is a
 * `hostComponents` entry that appends a column to
 * `.terminal-bottom-panel-container` and portals into it. The matching rules
 * in styles.css turn that container into a row.
 *
 * Nekomata is a stdlib Python server on localhost serving one page, so the
 * panel is an iframe. The renderer ships no content-security policy, so the
 * localhost frame loads. Before showing the frame the panel probes the server;
 * if it is down it offers to start it through the host's `extension:exec`
 * channel (gated on the manifest's filesystem permission), backgrounding the
 * process so the call returns at once.
 *
 * The container is `display: none` while the terminal panel is closed, so this
 * panel is visible exactly when the terminals are.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const TERMINAL_CONTAINER_SELECTOR = '.terminal-bottom-panel-container';
const PANEL_CLASS = 'enhancements-bottom-panel';
const PANEL_MARK = 'data-enhancements-bottom-panel';
const PANEL_TITLE = 'Nekomata';

const EXTENSION_ID = 'com.jaredlockhart.enhancements';
const EXEC_CHANNEL = 'extension:exec';

const NEKOMATA_URL = 'http://localhost:8787/';
const NEKOMATA_PROBE_URL = 'http://localhost:8787/data';
const NEKOMATA_SCRIPT = '$HOME/Documents/nekomata/fleet_dashboard.py';
const NEKOMATA_START_COMMAND = `nohup python3 ${NEKOMATA_SCRIPT} >/dev/null 2>&1 &`;

const PROBE_TIMEOUT_MS = 1500;
const PROBE_INTERVAL_DOWN_MS = 3000;
const PROBE_INTERVAL_UP_MS = 15000;

type ServerState = 'probing' | 'up' | 'down' | 'starting';

interface ElectronBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function getBridge(): ElectronBridge | null {
  const maybeWindow = globalThis as { electronAPI?: ElectronBridge };
  const api = maybeWindow.electronAPI;
  if (!api || typeof api.invoke !== 'function') return null;
  return api;
}

/**
 * Is the server reachable? The renderer is a different origin and the server
 * sets no CORS headers, so the response is opaque; the promise still rejects
 * on a refused connection, which is the only signal needed.
 */
async function probeServer(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(NEKOMATA_PROBE_URL, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Track the server's reachability, re-probing faster while it is down. */
function useNekomataServer(): { state: ServerState; error: string | null; start: () => void } {
  const [state, setState] = useState<ServerState>('probing');
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<ServerState>('probing');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      const up = await probeServer();
      if (cancelled) return;
      const next: ServerState = up ? 'up' : stateRef.current === 'starting' ? 'starting' : 'down';
      stateRef.current = next;
      setState(next);
      timer = setTimeout(() => void loop(), up ? PROBE_INTERVAL_UP_MS : PROBE_INTERVAL_DOWN_MS);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const start = useCallback(() => {
    const bridge = getBridge();
    if (!bridge) {
      setError('Nimbalyst IPC bridge is not available.');
      return;
    }
    stateRef.current = 'starting';
    setState('starting');
    setError(null);
    void bridge
      .invoke(EXEC_CHANNEL, { extensionId: EXTENSION_ID, command: NEKOMATA_START_COMMAND })
      .then((raw) => {
        const result = raw as ExecResult;
        if (!result.success) {
          stateRef.current = 'down';
          setState('down');
          setError(result.stderr || `exit ${result.exitCode}`);
        }
      })
      .catch((startError) => {
        stateRef.current = 'down';
        setState('down');
        setError(startError instanceof Error ? startError.message : String(startError));
      });
  }, []);

  return { state, error, start };
}

/**
 * Ensure every terminal bottom-panel container has a mount column appended and
 * return the mounts. Usually one, but each window owns its own container.
 */
function collectMounts(): HTMLElement[] {
  const mounts: HTMLElement[] = [];
  const containers = document.querySelectorAll<HTMLElement>(TERMINAL_CONTAINER_SELECTOR);
  for (const container of containers) {
    let mount = container.querySelector<HTMLElement>(`:scope > [${PANEL_MARK}]`);
    if (!mount) {
      mount = document.createElement('div');
      mount.className = PANEL_CLASS;
      mount.setAttribute(PANEL_MARK, 'true');
      container.appendChild(mount);
    }
    mounts.push(mount);
  }
  return mounts;
}

function sameMounts(a: HTMLElement[], b: HTMLElement[]): boolean {
  return a.length === b.length && a.every((mount, i) => mount === b[i]);
}

/** Watch the document for terminal bottom panels mounting or unmounting. */
function useTerminalContainers(): HTMLElement[] {
  const [mounts, setMounts] = useState<HTMLElement[]>([]);
  const latest = useRef<HTMLElement[]>([]);

  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const next = collectMounts();
      if (!sameMounts(latest.current, next)) {
        latest.current = next;
        setMounts(next);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const mount of latest.current) mount.remove();
      latest.current = [];
    };
  }, []);

  return mounts;
}

function ServerDownNotice({
  state,
  error,
  onStart,
}: {
  state: ServerState;
  error: string | null;
  onStart: () => void;
}) {
  return (
    <div className="enhancements-bottom-panel-notice">
      <div>{state === 'starting' ? 'Starting Nekomata…' : 'Nekomata is not running.'}</div>
      {state === 'down' ? (
        <button type="button" className="enhancements-bottom-panel-button" onClick={onStart}>
          Start server
        </button>
      ) : null}
      {error ? <div className="enhancements-bottom-panel-error">{error}</div> : null}
      <code className="enhancements-bottom-panel-command">python3 {NEKOMATA_SCRIPT}</code>
    </div>
  );
}

function BottomRightPanel() {
  const { state, error, start } = useNekomataServer();
  return (
    <div className="enhancements-bottom-panel-inner">
      <div className="enhancements-bottom-panel-header">
        <span className="enhancements-bottom-panel-title">{PANEL_TITLE}</span>
        <span className={`enhancements-bottom-panel-status ${state}`}>{state}</span>
      </div>
      <div className="enhancements-bottom-panel-body">
        {state === 'up' ? (
          <iframe className="enhancements-bottom-panel-frame" src={NEKOMATA_URL} title={PANEL_TITLE} />
        ) : state === 'probing' ? null : (
          <ServerDownNotice state={state} error={error} onStart={start} />
        )}
      </div>
    </div>
  );
}

/** The host component: one portal per terminal bottom-panel container. */
export function BottomRightPanelHost() {
  const mounts = useTerminalContainers();
  return <>{mounts.map((mount, i) => createPortal(<BottomRightPanel />, mount, `bottom-${i}`))}</>;
}
