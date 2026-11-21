import type { Awareness } from 'y-protocols/awareness';

const CURSOR_STYLE_ELEMENT_ID = 'hostelcode-dynamic-cursors';
const EDIT_STYLE_ELEMENT_ID = 'collabcode-permanent-edit-styles';

/**
 * Ensures a specific client or user's permanent edit CSS rules exist in the document.
 * These styles are written to a dedicated permanent style tag and are NEVER overwritten
 * by transient cursor or awareness updates.
 */
export function ensureUserEditStyle(
  key: number | string,
  color: string,
  _name?: string
): void {
  let styleEl = document.getElementById(EDIT_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = EDIT_STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');

  const ruleTag = `/* user-edit-style-${safeKey} */`;
  if (styleEl.textContent?.includes(ruleTag)) {
    return;
  }

  const css = `
    ${ruleTag}
    /* Permanent edit highlight for ${safeKey}${_name ? ` (${_name})` : ''} */
    .yRemoteEdit-${safeKey} {
      pointer-events: auto !important;
      cursor: pointer !important;
    }
    .yRemoteEditInline-${safeKey} {
      background-color: ${color}1C !important; /* ~11% translucent tint: 100% preserves comment and syntax highlighting */
      border-bottom: 2px solid ${color}A6 !important; /* distinct colored underline */
      border-radius: 2px !important;
      color: inherit !important; /* PRESERVE original code & comment syntax highlighting */
      pointer-events: auto !important;
      cursor: pointer !important;
      transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease !important;
    }
    .yRemoteEditInline-${safeKey}:hover {
      background-color: ${color}40 !important; /* illuminates to ~25% on hover */
      border-bottom: 2px solid ${color} !important; /* vibrant colored underline */
      box-shadow: 0 0 8px ${color}59 !important; /* soft glow on hover */
    }
  `;
  styleEl.textContent += css;
}

/**
 * Injects and dynamically updates CSS rules for Monaco Editor remote cursors
 * based on Yjs Awareness client states.
 */
export function updateCursorStyles(awareness: Awareness): void {
  let styleEl = document.getElementById(CURSOR_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = CURSOR_STYLE_ELEMENT_ID;
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

    /* Base styles for translucent snippet edit highlights (strictly character-level, never whole line) */
    .yRemoteEdit {
      border-radius: 2px;
      box-sizing: border-box;
      pointer-events: auto !important;
      cursor: pointer !important;
      z-index: 10;
    }
    .yRemoteEditInline {
      color: inherit !important;
      pointer-events: auto !important;
      cursor: pointer !important;
    }
  `;

  const states = awareness.getStates();
  states.forEach((state: any, clientID: number) => {
    if (state.user && state.user.color) {
      const color = state.user.color;
      const name = (state.user.name || 'Peer').replace(/"/g, '\\"');
      const userId = state.user.id || String(clientID);

      ensureUserEditStyle(userId, color, name);
      ensureUserEditStyle(clientID, color, name);

      css += `
        /* Remote selection range */
        .yRemoteSelection-${clientID} {
          background-color: ${color}33 !important;
        }

        /* Remote cursor caret */
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

        /* Translucent snippet edit highlight for peer ${name} */
        .yRemoteEdit-${clientID} {
          pointer-events: auto !important;
          cursor: pointer !important;
        }
        .yRemoteEditInline-${clientID} {
          background-color: ${color}1C !important; /* ~11% translucent tint: preserves comment & code syntax colors */
          border-bottom: 2px solid ${color}A6 !important;
          border-radius: 2px !important;
          color: inherit !important;
          pointer-events: auto !important;
          cursor: pointer !important;
          transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease !important;
        }
        .yRemoteEditInline-${clientID}:hover {
          background-color: ${color}40 !important;
          border-bottom: 2px solid ${color} !important;
          box-shadow: 0 0 8px ${color}59 !important;
        }
        .yRemoteEditInline-${clientID}.yRemoteEdit-fading {
          background-color: transparent !important;
          border-bottom-color: transparent !important;
          box-shadow: none !important;
        }
      `;
    }
  });

  styleEl.textContent = css;
}
