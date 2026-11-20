import type { Awareness } from 'y-protocols/awareness';

const STYLE_ELEMENT_ID = 'hostelcode-dynamic-cursors';

/**
 * Injects and dynamically updates CSS rules for Monaco Editor remote cursors
 * based on Yjs Awareness client states, including collision stacking when multiple
 * users share the same line and column.
 */
export function updateCursorStyles(awareness: Awareness): void {
  let styleEl = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  let css = `
    /* Base styles for Yjs Monaco remote selections */
    .yRemoteSelection {
      background-color: rgba(99, 102, 241, 0.25);
    }
    .yRemoteSelectionHead {
      position: absolute;
      box-sizing: border-box;
      height: 100%;
      border-left: 2.5px solid #6366F1;
      pointer-events: none;
      z-index: 20;
    }
    .yRemoteSelectionHead::after {
      position: absolute;
      content: ' ';
      border: 3px solid #6366F1;
      background-color: #6366F1;
      border-radius: 4px;
      left: -4px;
      top: -5px;
      pointer-events: none;
    }

    /* Stagger rules when multiple cursors meet at the same line & col */
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-1 {
      margin-left: 3px !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-1::before {
      top: -2.7em !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-2 {
      margin-left: 6px !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-2::before {
      top: -4.0em !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-3 {
      margin-left: 9px !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-3::before {
      top: -5.3em !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-4 {
      margin-left: 12px !important;
    }
    .yRemoteSelectionHead.yRemoteSelectionHead-stack-4::before {
      top: -6.6em !important;
    }
  `;

  const states = awareness.getStates();
  states.forEach((state: any, clientID: number) => {
    if (state.user && state.user.color) {
      const color = state.user.color;
      const name = (state.user.name || 'Peer').replace(/"/g, '\\"');

      css += `
        .yRemoteSelection-${clientID} {
          background-color: ${color}33 !important;
        }
        .yRemoteSelectionHead-${clientID} {
          border-left: 2.5px solid ${color} !important;
          border-top: none !important;
          border-bottom: none !important;
          border-right: none !important;
        }
        .yRemoteSelectionHead-${clientID}::before {
          content: "${name}";
          position: absolute;
          top: -1.4em;
          left: -2px;
          font-size: 10px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-weight: 600;
          color: #ffffff;
          background-color: ${color};
          padding: 1px 5px;
          border-radius: 3px;
          white-space: nowrap;
          pointer-events: none;
          z-index: 100;
          line-height: normal;
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
        }
        .yRemoteSelectionHead-${clientID}::after {
          position: absolute;
          content: ' ';
          border: 3px solid ${color} !important;
          background-color: ${color} !important;
          border-radius: 4px;
          left: -4px;
          top: -5px;
        }
      `;
    }
  });

  styleEl.textContent = css;
}
