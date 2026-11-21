import * as Y from 'yjs';
import * as monaco from 'monaco-editor';
import type { Awareness } from 'y-protocols/awareness';
import { ensureUserEditStyle } from './cursorStyles';

class RelativeSelection {
  constructor(
    public start: Y.RelativePosition,
    public end: Y.RelativePosition,
    public direction: monaco.SelectionDirection
  ) {}
}

interface ActiveEditHighlight {
  id: string;
  clientId: number;
  userName: string;
  userColor: string;
  fadeTimer: ReturnType<typeof setTimeout> | null;
  removeTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Creates a RelativeSelection from the editor's current selection.
 * For a caret cursor (collapsed selection), assoc = -1 is used for both start and end.
 * This guarantees that when a remote peer types or hits Enter at this exact position,
 * the local cursor DOES NOT get dragged along with the peer's typing.
 */
function createRelativeSelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoModel: monaco.editor.ITextModel,
  type: Y.Text
): RelativeSelection | null {
  const sel = editor.getSelection();
  if (!sel) return null;

  const startPos = sel.getStartPosition();
  const endPos = sel.getEndPosition();
  const startOffset = monacoModel.getOffsetAt(startPos);
  const endOffset = monacoModel.getOffsetAt(endPos);
  const isCaret = startOffset === endOffset;

  // assoc = -1 associates with the character before/left of the insertion point.
  // When text is inserted at startOffset, the relative position remains at startOffset.
  const start = Y.createRelativePositionFromTypeIndex(type, startOffset, -1);
  const end = Y.createRelativePositionFromTypeIndex(type, endOffset, isCaret ? -1 : 0);

  return new RelativeSelection(start, end, sel.getDirection());
}

function createMonacoSelectionFromRelativeSelection(
  editor: monaco.editor.IStandaloneCodeEditor,
  type: Y.Text,
  relSel: RelativeSelection,
  doc: Y.Doc
): monaco.Selection | null {
  const start = Y.createAbsolutePositionFromRelativePosition(relSel.start, doc);
  const end = Y.createAbsolutePositionFromRelativePosition(relSel.end, doc);

  if (start !== null && end !== null && start.type === type && end.type === type) {
    const model = editor.getModel();
    if (!model) return null;
    const startPos = model.getPositionAt(start.index);
    const endPos = model.getPositionAt(end.index);
    return monaco.Selection.createWithDirection(
      startPos.lineNumber,
      startPos.column,
      endPos.lineNumber,
      endPos.column,
      relSel.direction
    );
  }
  return null;
}

function createMutex(): (cb: () => void) => void {
  let hasMutex = false;
  return (cb: () => void) => {
    if (!hasMutex) {
      hasMutex = true;
      try {
        cb();
      } finally {
        hasMutex = false;
      }
    }
  };
}

export class MonacoCollabBinding {
  public doc: Y.Doc;
  public ytext: Y.Text;
  public monacoModel: monaco.editor.ITextModel;
  public editors: Set<monaco.editor.IStandaloneCodeEditor>;
  public awareness: Awareness | null;

  private mux: (cb: () => void) => void;
  private _savedSelections: Map<monaco.editor.IStandaloneCodeEditor, RelativeSelection>;
  private _beforeTransaction: () => void;
  private _decorations: Map<monaco.editor.IStandaloneCodeEditor, string[]>;
  private _allowLiveHighlights: boolean = false;
  private _editDecorations: Map<
    monaco.editor.IStandaloneCodeEditor,
    Map<string, ActiveEditHighlight>
  > = new Map();
  private _offlineHighlightDecorations: Map<
    monaco.editor.IStandaloneCodeEditor,
    string[]
  > = new Map();
  private _offlineHighlightTimers: (ReturnType<typeof setTimeout>)[] = [];
  private _rerenderDecorations: () => void;
  private _ytextObserver: (event: Y.YTextEvent) => void;
  private _monacoChangeHandler: monaco.IDisposable;
  private _monacoDisposeHandler: monaco.IDisposable;
  private _cursorListeners: monaco.IDisposable[] = [];

  constructor(
    ytext: Y.Text,
    monacoModel: monaco.editor.ITextModel,
    editors: Set<monaco.editor.IStandaloneCodeEditor> = new Set(),
    awareness: Awareness | null = null
  ) {
    this.doc = ytext.doc as Y.Doc;
    this.ytext = ytext;
    this.monacoModel = monacoModel;
    this.editors = editors;
    this.awareness = awareness;
    this.mux = createMutex();
    this._savedSelections = new Map();
    this._decorations = new Map();
    this._editDecorations = new Map();

    // 1. Before remote transactions are applied, snapshot the local selection with assoc = -1
    this._beforeTransaction = () => {
      this.mux(() => {
        this._savedSelections = new Map();
        this.editors.forEach((editor) => {
          if (editor.getModel() === this.monacoModel) {
            const rsel = createRelativeSelection(editor, this.monacoModel, this.ytext);
            if (rsel !== null) {
              this._savedSelections.set(editor, rsel);
            }
          }
        });
      });
    };
    this.doc.on('beforeAllTransactions', this._beforeTransaction);

    // 2. Remote text updates handler
    this._ytextObserver = (event: Y.YTextEvent) => {
      this.mux(() => {
        // Detect initial file/seed transactions that should never be highlighted
        const origin = event.transaction ? event.transaction.origin : null;
        const isInitialTransaction =
          origin === 'initialization' ||
          origin === 'initial-seed' ||
          origin === 'file-initial-content' ||
          origin === 'file-upload' ||
          origin === 'initial-load' ||
          origin === 'offline-duplicate-reconcile' ||
          origin === 'offline-duplicate-block-reconcile' ||
          origin === 'deduplicate-exact-halves' ||
          origin === 'deduplicate-exact-chunks';

        // Identify which remote peer made this edit (only if live highlights are enabled and not an initial file dump)
        let remoteClientId: number | null = null;
        if (
          this._allowLiveHighlights &&
          !isInitialTransaction &&
          event.transaction &&
          event.transaction.origin !== this
        ) {
          event.transaction.afterState.forEach((clock, client) => {
            const prev = event.transaction.beforeState.get(client) || 0;
            if (clock > prev && client !== this.doc.clientID) {
              remoteClientId = client;
            }
          });
        }

        let index = 0;
        const insertedSnippets: { range: monaco.Range; clientId: number }[] = [];

        event.delta.forEach((op) => {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const startPos = this.monacoModel.getPositionAt(index);
            const range = new monaco.Selection(
              startPos.lineNumber,
              startPos.column,
              startPos.lineNumber,
              startPos.column
            );
            const insert = op.insert as string;
            this.monacoModel.applyEdits([{ range, text: insert }]);

            if (
              this._allowLiveHighlights &&
              !isInitialTransaction &&
              remoteClientId !== null &&
              insert.length > 0 &&
              // Ignore whole-file initial insertions
              !(insert.length >= this.ytext.length && this.ytext.length > 30)
            ) {
              const endPos = this.monacoModel.getPositionAt(index + insert.length);
              if (
                startPos.lineNumber !== endPos.lineNumber ||
                startPos.column !== endPos.column
              ) {
                insertedSnippets.push({
                  range: new monaco.Range(
                    startPos.lineNumber,
                    startPos.column,
                    endPos.lineNumber,
                    endPos.column
                  ),
                  clientId: remoteClientId,
                });
              }
            }

            index += insert.length;
          } else if (op.delete !== undefined) {
            const pos = this.monacoModel.getPositionAt(index);
            const endPos = this.monacoModel.getPositionAt(index + op.delete);
            const range = new monaco.Selection(
              pos.lineNumber,
              pos.column,
              endPos.lineNumber,
              endPos.column
            );
            this.monacoModel.applyEdits([{ range, text: '' }]);
          }
        });

        // Add translucent character-level edit highlight strictly for live remote snippet insertions
        if (this._allowLiveHighlights && !isInitialTransaction && insertedSnippets.length > 0) {
          this._addRemoteEditHighlights(insertedSnippets);
        }

        // Restore local selections: thanks to assoc = -1, caret cursors at insertion points
        // stay before the newly inserted characters and are NOT dragged to new lines or along with remote edits!
        this._savedSelections.forEach((rsel, editor) => {
          const sel = createMonacoSelectionFromRelativeSelection(
            editor,
            this.ytext,
            rsel,
            this.doc
          );
          if (sel !== null) {
            const current = editor.getSelection();
            if (!current || !current.equalsSelection(sel)) {
              editor.setSelection(sel);
            }
          }
        });
      });
      this._rerenderDecorations();
    };
    this.ytext.observe(this._ytextObserver);

    // Initial content check
    const ytextValue = this.ytext.toString();
    if (this.monacoModel.getValue() !== ytextValue) {
      this.monacoModel.setValue(ytextValue);
    }

    // 3. Local editor changes: apply to Y.Text with origin `this` (for per-user UndoManager tracking)
    this._monacoChangeHandler = this.monacoModel.onDidChangeContent((event) => {
      this.mux(() => {
        this.doc.transact(() => {
          const sorted = [...event.changes].sort(
            (c1, c2) => c2.rangeOffset - c1.rangeOffset
          );
          sorted.forEach((change) => {
            this.ytext.delete(change.rangeOffset, change.rangeLength);
            this.ytext.insert(change.rangeOffset, change.text);
          });
        }, this);
      });
    });

    this._monacoDisposeHandler = this.monacoModel.onWillDispose(() => {
      this.destroy();
    });

    // 4. Remote cursor rendering & Awareness broadcasting
    this._rerenderDecorations = () => {
      if (!this.awareness) return;

      this.editors.forEach((editor) => {
        if (editor.getModel() !== this.monacoModel) {
          const oldDecs = this._decorations.get(editor);
          if (oldDecs && oldDecs.length > 0) {
            editor.deltaDecorations(oldDecs, []);
            this._decorations.delete(editor);
          }
          return;
        }

        const currentDecorations = this._decorations.get(editor) || [];
        const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];

        // Track how many remote cursors occupy the exact same line & column so we can stack them cleanly
        const positionCounts = new Map<string, number>();

        this.awareness!.getStates().forEach((state: any, clientID: number) => {
          if (
            clientID !== this.doc.clientID &&
            state.selection != null &&
            state.selection.anchor != null &&
            state.selection.head != null
          ) {
            const anchorAbs = Y.createAbsolutePositionFromRelativePosition(
              state.selection.anchor,
              this.doc
            );
            const headAbs = Y.createAbsolutePositionFromRelativePosition(
              state.selection.head,
              this.doc
            );

            if (
              anchorAbs !== null &&
              headAbs !== null &&
              anchorAbs.type === this.ytext &&
              headAbs.type === this.ytext
            ) {
              let start: monaco.Position;
              let end: monaco.Position;
              let afterContentClassName: string | null = null;
              let beforeContentClassName: string | null = null;

              if (anchorAbs.index < headAbs.index) {
                start = this.monacoModel.getPositionAt(anchorAbs.index);
                end = this.monacoModel.getPositionAt(headAbs.index);
                afterContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`;
              } else {
                start = this.monacoModel.getPositionAt(headAbs.index);
                end = this.monacoModel.getPositionAt(anchorAbs.index);
                beforeContentClassName = `yRemoteSelectionHead yRemoteSelectionHead-${clientID}`;
              }

              // Overlap avoidance: if multiple remote cursors sit at the same position, stagger them
              const isCaret = anchorAbs.index === headAbs.index;
              if (isCaret) {
                const posKey = `${start.lineNumber}:${start.column}`;
                const stackIndex = positionCounts.get(posKey) || 0;
                positionCounts.set(posKey, stackIndex + 1);

                if (stackIndex > 0) {
                  const stackClass = ` yRemoteSelectionHead-stack-${Math.min(stackIndex, 4)}`;
                  if (beforeContentClassName) {
                    beforeContentClassName += stackClass;
                  }
                  if (afterContentClassName) {
                    afterContentClassName += stackClass;
                  }
                }
              }

              newDecorations.push({
                range: new monaco.Range(
                  start.lineNumber,
                  start.column,
                  end.lineNumber,
                  end.column
                ),
                options: {
                  className: `yRemoteSelection yRemoteSelection-${clientID}`,
                  afterContentClassName,
                  beforeContentClassName,
                },
              });
            }
          }
        });

        const applied = editor.deltaDecorations(currentDecorations, newDecorations);
        this._decorations.set(editor, applied);
      });
    };

    if (awareness) {
      editors.forEach((editor) => {
        const cursorSub = editor.onDidChangeCursorSelection(() => {
          if (editor.getModel() === this.monacoModel) {
            const sel = editor.getSelection();
            if (!sel) return;

            let anchor = this.monacoModel.getOffsetAt(sel.getStartPosition());
            let head = this.monacoModel.getOffsetAt(sel.getEndPosition());

            if (sel.getDirection() === monaco.SelectionDirection.RTL) {
              const tmp = anchor;
              anchor = head;
              head = tmp;
            }

            const isCaret = anchor === head;
            // BROADCAST WITH assoc = -1 for caret positions!
            // This prevents the peer's screen from moving this user's cursor decoration
            // when the peer inserts text right at this user's position!
            awareness.setLocalStateField('selection', {
              anchor: Y.createRelativePositionFromTypeIndex(
                this.ytext,
                anchor,
                isCaret ? -1 : 0
              ),
              head: Y.createRelativePositionFromTypeIndex(
                this.ytext,
                head,
                isCaret ? -1 : 0
              ),
            });
          }
        });

        this._cursorListeners.push(cursorSub);
      });

      awareness.on('change', this._rerenderDecorations);
    }
  }

  /**
   * Dynamically adds and merges character-level translucent edit highlights
   * strictly for newly edited snippets of code (never whole lines).
   */
  private _addRemoteEditHighlights(
    snippets: { range: monaco.Range; clientId: number }[]
  ): void {
    this.editors.forEach((editor) => {
      if (editor.getModel() !== this.monacoModel) return;

      let editorHighlights = this._editDecorations.get(editor);
      if (!editorHighlights) {
        editorHighlights = new Map<string, ActiveEditHighlight>();
        this._editDecorations.set(editor, editorHighlights);
      }

      snippets.forEach((snippet) => {
        const state = this.awareness?.getStates().get(snippet.clientId);
        const userName = (state?.user?.name || 'Peer').replace(/"/g, '\\"');
        const userColor = state?.user?.color || '#3B82F6';

        // Ensure dynamic CSS rule exists for this peer's unique color
        ensureUserEditStyle(snippet.clientId, userColor, userName);

        // Check if there is an existing recent highlight for this client that touches or is adjacent
        let existingToMerge: ActiveEditHighlight | null = null;
        let mergedRange: monaco.Range = snippet.range;

        for (const [, highlight] of editorHighlights!) {
          if (highlight.clientId === snippet.clientId) {
            const currentRange = editor.getModel()?.getDecorationRange(highlight.id);
            if (currentRange) {
              const isAdjacentOrOverlapping =
                (currentRange.endLineNumber === snippet.range.startLineNumber &&
                  Math.abs(currentRange.endColumn - snippet.range.startColumn) <= 2) ||
                (snippet.range.endLineNumber === currentRange.startLineNumber &&
                  Math.abs(snippet.range.endColumn - currentRange.startColumn) <= 2) ||
                currentRange.intersectRanges(snippet.range) !== null;

              if (isAdjacentOrOverlapping) {
                existingToMerge = highlight;
                const startLine = Math.min(
                  currentRange.startLineNumber,
                  snippet.range.startLineNumber
                );
                const startCol =
                  currentRange.startLineNumber === snippet.range.startLineNumber
                    ? Math.min(currentRange.startColumn, snippet.range.startColumn)
                    : currentRange.startLineNumber < snippet.range.startLineNumber
                    ? currentRange.startColumn
                    : snippet.range.startColumn;

                const endLine = Math.max(
                  currentRange.endLineNumber,
                  snippet.range.endLineNumber
                );
                const endCol =
                  currentRange.endLineNumber === snippet.range.endLineNumber
                    ? Math.max(currentRange.endColumn, snippet.range.endColumn)
                    : currentRange.endLineNumber > snippet.range.endLineNumber
                    ? currentRange.endColumn
                    : snippet.range.endColumn;

                mergedRange = new monaco.Range(startLine, startCol, endLine, endCol);
                break;
              }
            }
          }
        }

        const decorationOptions: monaco.editor.IModelDecorationOptions = {
          isWholeLine: false, // Strictly snippet only, NEVER whole line!
          className: `yRemoteEdit yRemoteEdit-${snippet.clientId}`,
          inlineClassName: `yRemoteEditInline yRemoteEditInline-${snippet.clientId}`,
          hoverMessage: {
            value: `✍️ **${userName}** edited this snippet (visible for 15s)`,
          },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          zIndex: 10,
        };

        const oldIds = existingToMerge ? [existingToMerge.id] : [];
        if (existingToMerge) {
          if (existingToMerge.fadeTimer) clearTimeout(existingToMerge.fadeTimer);
          if (existingToMerge.removeTimer) clearTimeout(existingToMerge.removeTimer);
          editorHighlights!.delete(existingToMerge.id);
        }

        const newIds = editor.deltaDecorations(oldIds, [
          {
            range: mergedRange,
            options: decorationOptions,
          },
        ]);

        if (newIds && newIds.length > 0) {
          const decId = newIds[0];
          const entry: ActiveEditHighlight = {
            id: decId,
            clientId: snippet.clientId,
            userName,
            userColor,
            fadeTimer: null,
            removeTimer: null,
          };

          // Visible for 15 seconds! Trigger smooth CSS fadeout at 15 seconds
          entry.fadeTimer = setTimeout(() => {
            const currentRange = editor.getModel()?.getDecorationRange(decId);
            if (currentRange) {
              editor.deltaDecorations([decId], [
                {
                  range: currentRange,
                  options: {
                    ...decorationOptions,
                    className: `yRemoteEdit yRemoteEdit-${snippet.clientId} yRemoteEdit-fading`,
                  },
                },
              ]);
            }
          }, 15000);

          // After smooth 2s CSS dissolution, remove decoration completely at 17 seconds
          entry.removeTimer = setTimeout(() => {
            editor.deltaDecorations([decId], []);
            editorHighlights?.delete(decId);
          }, 17000);

          editorHighlights!.set(decId, entry);
        }
      });
    });
  }

  /**
   * Highlights code snippets edited by remote online peers while this user was offline.
   * Highlights are rendered in the unique color of the user who committed the change,
   * at the snippet level (strictly character-level, never whole line), and persist for
   * at least 2 minutes (120,000ms) with a smooth 2.5s CSS fade dissolution.
   */
  public highlightOfflineEdits(
    baselineStateVector: Uint8Array,
    knownMembersMap?: Map<string, { name: string; color?: string; id?: string }>
  ): { count: number; authors: string[] } {
    // 1. Clear any active offline highlight timers
    this._offlineHighlightTimers.forEach((timer) => clearTimeout(timer));
    this._offlineHighlightTimers = [];

    // 2. Clear any active offline decorations
    this.editors.forEach((editor) => {
      const existing = this._offlineHighlightDecorations.get(editor);
      if (existing && existing.length > 0) {
        try {
          editor.deltaDecorations(existing, []);
        } catch {}
      }
    });
    this._offlineHighlightDecorations.clear();

    // 3. Decode baseline state vector to isolate updates applied since user went offline
    const baseline = Y.decodeStateVector(baselineStateVector);
    if (baseline.size === 0) {
      // Baseline was uninitialized or empty: this is a new document or first-time join
      return { count: 0, authors: [] };
    }
    const metaMap = this.doc.getMap<any>('_clientMeta');

    // Palette of vibrant colors for reliable fallback
    const fallbackPalette = [
      '#3B82F6', // Blue
      '#10B981', // Emerald
      '#F59E0B', // Amber
      '#EF4444', // Red
      '#8B5CF6', // Purple
      '#EC4899', // Pink
      '#06B6D4', // Cyan
      '#14B8A6', // Teal
      '#F97316', // Orange
      '#6366F1', // Indigo
      '#84CC16', // Lime
      '#E11D48', // Rose
    ];

    // 4. Walk the Y.Text linked list to discover non-deleted items inserted by remote peers
    interface OfflineSnippet {
      startOffset: number;
      endOffset: number;
      clientId: number;
    }

    const snippets: OfflineSnippet[] = [];
    let item = (this.ytext as any)._start;
    let offset = 0;
    let currentSnippet: OfflineSnippet | null = null;

    while (item !== null) {
      if (!item.deleted) {
        const len = item.length;
        const client = item.id.client;
        const clock = item.id.clock;
        const baseClock = baseline.get(client) || 0;

        // Check if this item was inserted by a remote peer after baseline
        if (client !== this.doc.clientID && clock >= baseClock) {
          if (
            currentSnippet &&
            currentSnippet.clientId === client &&
            currentSnippet.endOffset === offset
          ) {
            currentSnippet.endOffset += len;
          } else {
            if (currentSnippet) {
              snippets.push(currentSnippet);
            }
            currentSnippet = {
              startOffset: offset,
              endOffset: offset + len,
              clientId: client,
            };
          }
        } else {
          if (currentSnippet) {
            snippets.push(currentSnippet);
            currentSnippet = null;
          }
        }
        offset += len;
      }
      item = item.right;
    }
    if (currentSnippet) {
      snippets.push(currentSnippet);
    }

    if (snippets.length === 0) {
      return { count: 0, authors: [] };
    }

    const totalSnippetLength = snippets.reduce(
      (sum, s) => sum + (s.endOffset - s.startOffset),
      0
    );
    // If the snippets span the entire file (e.g. newly created/uploaded file), do not highlight initial files
    if (totalSnippetLength >= this.ytext.length && this.ytext.length > 0) {
      return { count: 0, authors: [] };
    }

    // 5. Build decorations for each editor and resolve author color & name
    const authorNames = new Set<string>();

    this.editors.forEach((editor) => {
      if (editor.getModel() !== this.monacoModel) return;

      const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];

      snippets.forEach((snippet) => {
        // Resolve author identity: awareness -> _clientMeta -> knownMembers -> fallback
        const awarenessState = this.awareness?.getStates().get(snippet.clientId);
        const clientMeta = metaMap.get(String(snippet.clientId));
        const authorId = clientMeta?.id || awarenessState?.user?.id;

        const userName =
          clientMeta?.name ||
          awarenessState?.user?.name ||
          (authorId && knownMembersMap?.get(authorId)?.name) ||
          'Peer';
        const userColor =
          clientMeta?.color ||
          awarenessState?.user?.color ||
          (authorId && knownMembersMap?.get(authorId)?.color) ||
          fallbackPalette[Math.abs(snippet.clientId) % fallbackPalette.length];

        authorNames.add(userName);

        // Ensure CSS rules exist for this specific user's color
        ensureUserEditStyle(snippet.clientId, userColor, userName);

        const startPos = this.monacoModel.getPositionAt(snippet.startOffset);
        const endPos = this.monacoModel.getPositionAt(snippet.endOffset);

        if (
          startPos.lineNumber === endPos.lineNumber &&
          startPos.column === endPos.column
        ) {
          return;
        }

        const range = new monaco.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column
        );

        newDecorations.push({
          range,
          options: {
            isWholeLine: false, // Character-level snippet only, NEVER whole line!
            className: `yRemoteEdit yRemoteEdit-${snippet.clientId}`,
            inlineClassName: `yRemoteEditInline yRemoteEditInline-${snippet.clientId}`,
            hoverMessage: {
              value: `✍️ **${userName}** edited this while you were offline (visible for 2 min)`,
            },
            overviewRuler: {
              color: userColor,
              position: 4,
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            zIndex: 10,
          },
        });
      });

      if (newDecorations.length > 0) {
        const appliedIds = editor.deltaDecorations([], newDecorations);
        this._offlineHighlightDecorations.set(editor, appliedIds);

        // Visible for at least 2 minutes (120,000ms). Trigger smooth 2.5s CSS fade dissolution at 120,000ms
        const fadeTimer = setTimeout(() => {
          try {
            const currentIds = this._offlineHighlightDecorations.get(editor) || [];
            if (currentIds.length === 0) return;

            const fadingDecorations: monaco.editor.IModelDeltaDecoration[] = [];
            currentIds.forEach((id) => {
              const decRange = editor.getModel()?.getDecorationRange(id);
              if (decRange) {
                fadingDecorations.push({
                  range: decRange,
                  options: {
                    isWholeLine: false,
                    className: `yRemoteEdit yRemoteEdit-fading`,
                    inlineClassName: `yRemoteEditInline`,
                    hoverMessage: {
                      value: `✍️ Edited while offline (fading)`,
                    },
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    zIndex: 10,
                  },
                });
              }
            });

            if (fadingDecorations.length > 0) {
              const fadingIds = editor.deltaDecorations(currentIds, fadingDecorations);
              this._offlineHighlightDecorations.set(editor, fadingIds);
            }
          } catch {}
        }, 120000);

        // Dispose completely after smooth dissolution at 122,500ms
        const removeTimer = setTimeout(() => {
          try {
            const idsToRemove = this._offlineHighlightDecorations.get(editor) || [];
            if (idsToRemove.length > 0) {
              editor.deltaDecorations(idsToRemove, []);
            }
            this._offlineHighlightDecorations.delete(editor);
          } catch {}
        }, 122500);

        this._offlineHighlightTimers.push(fadeTimer, removeTimer);
      }
    });

    return {
      count: snippets.length,
      authors: Array.from(authorNames),
    };
  }

  /**
   * Activates real-time snippet edit highlights after initial file load/sync has settled.
   * This guarantees that initial file contents, uploaded files, and newly joined users
   * do not show any highlights for existing code.
   */
  public enableLiveHighlights(): void {
    this._allowLiveHighlights = true;
  }

  destroy(): void {
    this._monacoChangeHandler.dispose();
    this._monacoDisposeHandler.dispose();
    this._cursorListeners.forEach((l) => l.dispose());
    this._cursorListeners = [];

    this.ytext.unobserve(this._ytextObserver);
    this.doc.off('beforeAllTransactions', this._beforeTransaction);

    if (this.awareness) {
      this.awareness.off('change', this._rerenderDecorations);
    }

    // Clear cursor decorations
    this.editors.forEach((editor) => {
      const decs = this._decorations.get(editor);
      if (decs && decs.length > 0) {
        try {
          editor.deltaDecorations(decs, []);
        } catch {}
      }
    });
    this._decorations.clear();

    // Clear all snippet edit highlights and their timers
    this._editDecorations.forEach((highlightsMap, editor) => {
      const decIds: string[] = [];
      highlightsMap.forEach((entry) => {
        if (entry.fadeTimer) clearTimeout(entry.fadeTimer);
        if (entry.removeTimer) clearTimeout(entry.removeTimer);
        decIds.push(entry.id);
      });
      if (decIds.length > 0) {
        try {
          editor.deltaDecorations(decIds, []);
        } catch {}
      }
    });
    this._editDecorations.clear();

    // Clear offline highlights and timers
    this._offlineHighlightTimers.forEach((t) => clearTimeout(t));
    this._offlineHighlightTimers = [];

    this.editors.forEach((editor) => {
      const offlineDecs = this._offlineHighlightDecorations.get(editor);
      if (offlineDecs && offlineDecs.length > 0) {
        try {
          editor.deltaDecorations(offlineDecs, []);
        } catch {}
      }
    });
    this._offlineHighlightDecorations.clear();
  }
}
