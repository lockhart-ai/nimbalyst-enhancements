/**
 * Bottom-right panel
 *
 * A column on the right of the terminal bottom panel. Nimbalyst's own
 * `bottom` placement for extension panels stacks a second container *under*
 * the terminals rather than beside them, and the terminal panel has no split
 * support, so this is a `hostComponents` entry that appends a column to
 * `.terminal-bottom-panel-container` and portals into it. The matching rules
 * in styles.css turn that container into a row.
 *
 * The container is `display: none` while the terminal panel is closed, so this
 * panel is visible exactly when the terminals are.
 *
 * Currently a placeholder; the intended occupant is Nekomata, the cat-cafe
 * fleet visualizer, which serves a plain web page on localhost.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const TERMINAL_CONTAINER_SELECTOR = '.terminal-bottom-panel-container';
const PANEL_CLASS = 'enhancements-bottom-panel';
const PANEL_MARK = 'data-enhancements-bottom-panel';
const PANEL_TITLE = 'Nekomata';
const PLACEHOLDER_TEXT = 'Empty panel. Nekomata goes here.';

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

function BottomRightPanel() {
  return (
    <div className="enhancements-bottom-panel-inner">
      <div className="enhancements-bottom-panel-header">
        <span className="enhancements-bottom-panel-title">{PANEL_TITLE}</span>
      </div>
      <div className="enhancements-bottom-panel-body">{PLACEHOLDER_TEXT}</div>
    </div>
  );
}

/** The host component: one portal per terminal bottom-panel container. */
export function BottomRightPanelHost() {
  const mounts = useTerminalContainers();
  return <>{mounts.map((mount, i) => createPortal(<BottomRightPanel />, mount, `bottom-${i}`))}</>;
}
