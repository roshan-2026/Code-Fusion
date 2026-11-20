import type { Awareness } from 'y-protocols/awareness';

const STYLE_ELEMENT_ID = 'hostelcode-dynamic-cursors';

/**
 * Injects and dynamically updates CSS rules for Monaco Editor remote cursors
 * based on Yjs Awareness client states.
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
      position: absolute;
    }
    .yRemoteSelectionHead {
      position: absolute;
      box-sizing: border-box;
      height: 100%;
      border-left: 2px solid #6366F1;
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
          border-left: 2px solid ${color} !important;
          border-top: 1px solid ${color} !important;
          border-bottom: 1px solid ${color} !important;
        }
        .yRemoteSelectionHead-${clientID}::before {
          content: "${name}";
          position: absolute;
          top: -1.35em;
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
          z-index: 50;
          line-height: normal;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
        }
        .yRemoteSelectionHead-${clientID}::after {
          position: absolute;
          content: ' ';
          border: 3px solid ${color};
          background-color: ${color};
          border-radius: 4px;
          left: -4px;
          top: -5px;
        }
      `;
    }
  });

  styleEl.textContent = css;
}
