import * as Y from 'yjs';
import * as monaco from 'monaco-editor';
import type { Awareness } from 'y-protocols/awareness';
import type { FileEditLogEntry } from '@hostelcode/shared';
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
  public fileId: string;
  public currentUser?: { id: string; name: string; color?: string };
  public editsMap: Y.Map<FileEditLogEntry>;

  private mux: (cb: () => void) => void;
  private _savedSelections: Map<monaco.editor.IStandaloneCodeEditor, RelativeSelection>;
  private _beforeTransaction: () => void;
  private _decorations: Map<monaco.editor.IStandaloneCodeEditor, string[]>;
  private _editDecorations: Map<
    monaco.editor.IStandaloneCodeEditor,
    Map<string, ActiveEditHighlight>
  > = new Map();
  private _offlineHighlightDecorations: Map<
    monaco.editor.IStandaloneCodeEditor,
    string[]
  > = new Map();
  private _editLogDecorations: Map<
    monaco.editor.IStandaloneCodeEditor,
    string[]
  > = new Map();
  private _offlineHighlightTimers: (ReturnType<typeof setTimeout>)[] = [];
  private _isDestroyed: boolean = false;
  private _rerenderDecorations: () => void;
  private _ytextObserver: (event: Y.YTextEvent) => void;
  private _editsMapObserver: (event: Y.YMapEvent<any>) => void;
  private _monacoChangeHandler: monaco.IDisposable;
  private _monacoDisposeHandler: monaco.IDisposable;
  private _cursorListeners: monaco.IDisposable[] = [];
  private _localTypingTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingLocalRanges: Array<{
    startRel: Y.RelativePosition;
    endRel: Y.RelativePosition;
  }> = [];
  private _remoteTypingTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private _pendingRemoteRanges: Map<
    number,
    Array<{ startRel: Y.RelativePosition; endRel: Y.RelativePosition }>
  > = new Map();

  constructor(
    ytext: Y.Text,
    monacoModel: monaco.editor.ITextModel,
    editors: Set<monaco.editor.IStandaloneCodeEditor> = new Set(),
    awareness: Awareness | null = null,
    options?: {
      fileId?: string;
      currentUser?: { id: string; name: string; color?: string };
    }
  ) {
    this.doc = ytext.doc as Y.Doc;
    this.ytext = ytext;
    this.monacoModel = monacoModel;
    this.editors = editors;
    this.awareness = awareness;
    this.fileId = options?.fileId || '';
    this.currentUser = options?.currentUser;
    this.editsMap = this.doc.getMap<FileEditLogEntry>('file-edits-log');
    this.mux = createMutex();
    this._savedSelections = new Map();
    this._decorations = new Map();
    this._editDecorations = new Map();
    this._editLogDecorations = new Map();

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

        // For initial document population or deduplication, set Monaco model value directly
        // to prevent incremental duplicate line insertions
        if (isInitialTransaction) {
          const fullVal = this.ytext.toString();
          if (this.monacoModel.getValue() !== fullVal) {
            this.monacoModel.setValue(fullVal);
          }
          return;
        }

        // Identify which remote peer made this edit
        let remoteClientId: number | null = null;
        if (
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

              // Buffer remote edit range for 5-second inactivity line-wise commit
              const startRel = Y.createRelativePositionFromTypeIndex(
                this.ytext,
                index,
                -1
              );
              const endRel = Y.createRelativePositionFromTypeIndex(
                this.ytext,
                index + insert.length,
                -1
              );
              let list = this._pendingRemoteRanges.get(remoteClientId);
              if (!list) {
                list = [];
                this._pendingRemoteRanges.set(remoteClientId, list);
              }
              list.push({ startRel, endRel });

              // Reset remote 5-second inactivity timer
              const prevTimer = this._remoteTypingTimers.get(remoteClientId);
              if (prevTimer) clearTimeout(prevTimer);
              this._remoteTypingTimers.set(
                remoteClientId,
                setTimeout(() => {
                  this._commitRemoteLineEdits(remoteClientId!);
                }, 5000)
              );
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

    // Initial content check: if Y.Text already has content, synchronize it to Monaco model
    const ytextValue = this.ytext.toString();
    if (ytextValue.length > 0) {
      if (this.monacoModel.getValue() !== ytextValue) {
        this.monacoModel.setValue(ytextValue);
      }
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

        // Do NOT update edit log per click/keystroke!
        // Buffer the edit ranges using relative positions so they track accurately across any subsequent edits
        event.changes.forEach((change) => {
          const startOffset = change.rangeOffset;
          const endOffset = change.rangeOffset + change.text.length;
          const startRel = Y.createRelativePositionFromTypeIndex(
            this.ytext,
            startOffset,
            -1
          );
          const endRel = Y.createRelativePositionFromTypeIndex(
            this.ytext,
            Math.max(startOffset, endOffset),
            -1
          );
          this._pendingLocalRanges.push({ startRel, endRel });
        });

        // Reset 5-second inactivity debounce timer
        // Wait for the user to complete typing; if user does not type for 5s, commit edits line-wise
        if (this._localTypingTimer) {
          clearTimeout(this._localTypingTimer);
        }
        this._localTypingTimer = setTimeout(() => {
          this._commitLocalLineEdits();
        }, 5000);
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

    // 5. Observe persistent CRDT edits map so all teammates stay in sync
    this._editsMapObserver = () => {
      this.renderLogHighlights();
    };
    this.editsMap.observe(this._editsMapObserver);

    // Initial render of existing edit log entries (e.g. from refresh or returning session)
    if (this.editsMap.size > 0) {
      setTimeout(() => {
        this.renderLogHighlights();
      }, 50);
    }
  }

  /**
   * Commits pending local edits line-wise to the CRDT editsMap after 5 seconds of typing inactivity.
   * Logs only the specific change text made by the user in that line (not whole line)
   * and highlights only that specific range on the editor.
   */
  private _commitLocalLineEdits(): void {
    if (this._isDestroyed) return;
    if (this._localTypingTimer) {
      clearTimeout(this._localTypingTimer);
      this._localTypingTimer = null;
    }

    if (this._pendingLocalRanges.length === 0) return;

    const ranges = [...this._pendingLocalRanges];
    this._pendingLocalRanges = [];

    interface LineSpan {
      lineNum: number;
      minOffset: number;
      maxOffset: number;
    }
    const lineSpans = new Map<number, LineSpan>();
    const totalLines = this.monacoModel.getLineCount();

    ranges.forEach((r) => {
      try {
        const absStart = Y.createAbsolutePositionFromRelativePosition(r.startRel, this.doc);
        const absEnd = Y.createAbsolutePositionFromRelativePosition(r.endRel, this.doc);
        if (
          absStart &&
          (absStart.type === this.ytext || (absStart.type as any)?._item === (this.ytext as any)?._item)
        ) {
          const startPos = this.monacoModel.getPositionAt(absStart.index);
          const endPos =
            absEnd &&
            (absEnd.type === this.ytext || (absEnd.type as any)?._item === (this.ytext as any)?._item)
              ? this.monacoModel.getPositionAt(absEnd.index)
              : startPos;

          const startLine = startPos.lineNumber;
          const endLine = endPos.lineNumber;
          const minL = Math.max(1, Math.min(startLine, endLine));
          const maxL = Math.min(totalLines, Math.max(startLine, endLine));

          for (let l = minL; l <= maxL; l++) {
            const startOff = absStart.index;
            const endOff = absEnd ? absEnd.index : absStart.index;
            const existing = lineSpans.get(l);
            if (!existing) {
              lineSpans.set(l, {
                lineNum: l,
                minOffset: Math.min(startOff, endOff),
                maxOffset: Math.max(startOff, endOff),
              });
            } else {
              existing.minOffset = Math.min(existing.minOffset, startOff, endOff);
              existing.maxOffset = Math.max(existing.maxOffset, startOff, endOff);
            }
          }
        }
      } catch {}
    });

    if (lineSpans.size === 0) return;

    const userId = this.currentUser?.id || `client_${this.doc.clientID}`;
    const userName = this.currentUser?.name || 'You';
    const userColor = this.currentUser?.color || '#6366F1';
    const now = Date.now();

    ensureUserEditStyle(userId, userColor, userName);
    ensureUserEditStyle(this.doc.clientID, userColor, userName);

    const existingEntries = Array.from(this.editsMap.values()) as FileEditLogEntry[];

    this.doc.transact(() => {
      lineSpans.forEach((span, lineNum) => {
        if (lineNum < 1 || lineNum > this.monacoModel.getLineCount()) return;

        const lineStartOffset = this.monacoModel.getOffsetAt({ lineNumber: lineNum, column: 1 });
        const lineMaxCol = this.monacoModel.getLineMaxColumn(lineNum);
        const lineEndOffset = this.monacoModel.getOffsetAt({ lineNumber: lineNum, column: lineMaxCol });

        // Clamp offsets to strictly within this line
        const clampedStart = Math.max(lineStartOffset, Math.min(lineEndOffset, span.minOffset));
        let clampedEnd = Math.max(clampedStart, Math.min(lineEndOffset, span.maxOffset));

        let changeText = '';
        if (clampedEnd > clampedStart) {
          const p1 = this.monacoModel.getPositionAt(clampedStart);
          const p2 = this.monacoModel.getPositionAt(clampedEnd);
          changeText = this.monacoModel
            .getValueInRange(new monaco.Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column))
            .trim();
        }

        if (!changeText) {
          const lineTrimmed = this.monacoModel.getLineContent(lineNum).trim();
          changeText = lineTrimmed ? '(edited)' : '(empty line)';
          clampedEnd = Math.min(lineEndOffset, clampedStart + 1);
        }

        const previewText =
          changeText.length > 70 ? changeText.slice(0, 70) + '...' : changeText;

        const startRelPos = Y.createRelativePositionFromTypeIndex(this.ytext, clampedStart, -1);
        const endRelPos = Y.createRelativePositionFromTypeIndex(
          this.ytext,
          Math.max(clampedStart, clampedEnd),
          -1
        );

        // Per-user deterministic line ID: guarantees 1 card per user per line without overwriting other users
        const targetId = `edit_${this.fileId || 'file'}_${userId}_line_${lineNum}`;

        // Clean up older micro-entries for THIS user on this line
        existingEntries.forEach((entry) => {
          if (entry && entry.userId === userId && entry.id !== targetId) {
            let matches = entry.linePreview === lineNum;
            if (!matches && entry.startRelPos) {
              try {
                const abs = Y.createAbsolutePositionFromRelativePosition(entry.startRelPos, this.doc);
                if (abs) {
                  const pos = this.monacoModel.getPositionAt(abs.index);
                  if (pos && pos.lineNumber === lineNum) matches = true;
                }
              } catch {}
            }
            if (matches) {
              this.editsMap.delete(entry.id);
            }
          }
        });

        this.editsMap.set(targetId, {
          id: targetId,
          fileId: this.fileId,
          userId,
          userName,
          userColor,
          startRelPos,
          endRelPos,
          text: previewText,
          timestamp: now,
          linePreview: lineNum,
        });
      });
    }, this);

    this.renderLogHighlights();
  }

  /**
   * Commits pending remote peer edits line-wise after 5 seconds of remote typing inactivity.
   */
  private _commitRemoteLineEdits(remoteClientId: number): void {
    if (this._isDestroyed) return;
    const timer = this._remoteTypingTimers.get(remoteClientId);
    if (timer) {
      clearTimeout(timer);
      this._remoteTypingTimers.delete(remoteClientId);
    }

    const ranges = this._pendingRemoteRanges.get(remoteClientId);
    if (!ranges || ranges.length === 0) return;
    this._pendingRemoteRanges.delete(remoteClientId);

    interface LineSpan {
      lineNum: number;
      minOffset: number;
      maxOffset: number;
    }
    const lineSpans = new Map<number, LineSpan>();
    const totalLines = this.monacoModel.getLineCount();

    ranges.forEach((r) => {
      try {
        const absStart = Y.createAbsolutePositionFromRelativePosition(r.startRel, this.doc);
        const absEnd = Y.createAbsolutePositionFromRelativePosition(r.endRel, this.doc);
        if (
          absStart &&
          (absStart.type === this.ytext || (absStart.type as any)?._item === (this.ytext as any)?._item)
        ) {
          const startPos = this.monacoModel.getPositionAt(absStart.index);
          const endPos =
            absEnd &&
            (absEnd.type === this.ytext || (absEnd.type as any)?._item === (this.ytext as any)?._item)
              ? this.monacoModel.getPositionAt(absEnd.index)
              : startPos;

          const startLine = startPos.lineNumber;
          const endLine = endPos.lineNumber;
          const minL = Math.max(1, Math.min(startLine, endLine));
          const maxL = Math.min(totalLines, Math.max(startLine, endLine));

          for (let l = minL; l <= maxL; l++) {
            const startOff = absStart.index;
            const endOff = absEnd ? absEnd.index : absStart.index;
            const existing = lineSpans.get(l);
            if (!existing) {
              lineSpans.set(l, {
                lineNum: l,
                minOffset: Math.min(startOff, endOff),
                maxOffset: Math.max(startOff, endOff),
              });
            } else {
              existing.minOffset = Math.min(existing.minOffset, startOff, endOff);
              existing.maxOffset = Math.max(existing.maxOffset, startOff, endOff);
            }
          }
        }
      } catch {}
    });

    if (lineSpans.size === 0) return;

    const awarenessState = this.awareness?.getStates().get(remoteClientId);
    const metaMap = this.doc.getMap<any>('_clientMeta');
    const clientMeta = metaMap.get(String(remoteClientId));
    const remoteUserId =
      clientMeta?.id || awarenessState?.user?.id || `client_${remoteClientId}`;
    const remoteUserName =
      clientMeta?.name || awarenessState?.user?.name || 'Peer';
    const remoteUserColor =
      clientMeta?.color || awarenessState?.user?.color || '#3B82F6';
    const now = Date.now();

    ensureUserEditStyle(remoteUserId, remoteUserColor, remoteUserName);
    ensureUserEditStyle(remoteClientId, remoteUserColor, remoteUserName);

    const existingEntries = Array.from(this.editsMap.values()) as FileEditLogEntry[];

    this.doc.transact(() => {
      lineSpans.forEach((span, lineNum) => {
        if (lineNum < 1 || lineNum > this.monacoModel.getLineCount()) return;

        const lineStartOffset = this.monacoModel.getOffsetAt({ lineNumber: lineNum, column: 1 });
        const lineMaxCol = this.monacoModel.getLineMaxColumn(lineNum);
        const lineEndOffset = this.monacoModel.getOffsetAt({ lineNumber: lineNum, column: lineMaxCol });

        const clampedStart = Math.max(lineStartOffset, Math.min(lineEndOffset, span.minOffset));
        let clampedEnd = Math.max(clampedStart, Math.min(lineEndOffset, span.maxOffset));

        let changeText = '';
        if (clampedEnd > clampedStart) {
          const p1 = this.monacoModel.getPositionAt(clampedStart);
          const p2 = this.monacoModel.getPositionAt(clampedEnd);
          changeText = this.monacoModel
            .getValueInRange(new monaco.Range(p1.lineNumber, p1.column, p2.lineNumber, p2.column))
            .trim();
        }

        if (!changeText) {
          const lineTrimmed = this.monacoModel.getLineContent(lineNum).trim();
          changeText = lineTrimmed ? '(edited)' : '(empty line)';
          clampedEnd = Math.min(lineEndOffset, clampedStart + 1);
        }

        const previewText =
          changeText.length > 70 ? changeText.slice(0, 70) + '...' : changeText;

        const startRelPos = Y.createRelativePositionFromTypeIndex(this.ytext, clampedStart, -1);
        const endRelPos = Y.createRelativePositionFromTypeIndex(
          this.ytext,
          Math.max(clampedStart, clampedEnd),
          -1
        );

        const targetId = `edit_${this.fileId || 'file'}_${remoteUserId}_line_${lineNum}`;

        existingEntries.forEach((entry) => {
          if (entry && entry.userId === remoteUserId && entry.id !== targetId) {
            let matches = entry.linePreview === lineNum;
            if (!matches && entry.startRelPos) {
              try {
                const abs = Y.createAbsolutePositionFromRelativePosition(entry.startRelPos, this.doc);
                if (abs) {
                  const pos = this.monacoModel.getPositionAt(abs.index);
                  if (pos && pos.lineNumber === lineNum) matches = true;
                }
              } catch {}
            }
            if (matches) {
              this.editsMap.delete(entry.id);
            }
          }
        });

        this.editsMap.set(targetId, {
          id: targetId,
          fileId: this.fileId,
          userId: remoteUserId,
          userName: remoteUserName,
          userColor: remoteUserColor,
          startRelPos,
          endRelPos,
          text: previewText,
          timestamp: now,
          linePreview: lineNum,
        });
      });
    }, this);

    this.renderLogHighlights();
  }

  /**
   * Permanently renders snippet-level edit highlights from the CRDT edit log.
   * Highlights ONLY the exact characters/range touched by that user on that line
   * (never covering full lines), and displays distinct user colors and hover tooltips
   * even when multiple users have edited the exact same line.
   */
  public renderLogHighlights(): void {
    if (this._isDestroyed) return;

    const entries = Array.from(this.editsMap.values()) as FileEditLogEntry[];
    if (entries.length === 0) {
      this.editors.forEach((editor) => {
        const oldDecs = this._editLogDecorations.get(editor);
        if (oldDecs && oldDecs.length > 0) {
          try {
            editor.deltaDecorations(oldDecs, []);
          } catch {}
          this._editLogDecorations.delete(editor);
        }
      });
      return;
    }

    const currentUserId = this.currentUser?.id;

    this.editors.forEach((editor) => {
      if (editor.getModel() !== this.monacoModel) return;

      // Clean up any transient edit decorations so permanent log decorations take precedence cleanly
      const oldSnippets = this._editDecorations.get(editor);
      if (oldSnippets && oldSnippets.size > 0) {
        try {
          editor.deltaDecorations(Array.from(oldSnippets.keys()), []);
        } catch {}
        oldSnippets.clear();
      }

      // Consolidate per user per line so each collaborator has their specific edit highlighted on that line
      const userLineMap = new Map<string, FileEditLogEntry>();
      const sortedEntries = [...entries].sort((a, b) => a.timestamp - b.timestamp);
      sortedEntries.forEach((entry) => {
        if (!entry || !entry.startRelPos) return;
        try {
          const abs = Y.createAbsolutePositionFromRelativePosition(entry.startRelPos, this.doc);
          if (
            abs &&
            (abs.type === this.ytext || (abs.type as any)?._item === (this.ytext as any)?._item)
          ) {
            const pos = this.monacoModel.getPositionAt(abs.index);
            if (pos) {
              const key = `${entry.userId || entry.userName}_${pos.lineNumber}`;
              userLineMap.set(key, entry);
            }
          }
        } catch {}
      });

      const decorations: monaco.editor.IModelDeltaDecoration[] = [];

      userLineMap.forEach((entry) => {
        try {
          const absStart = Y.createAbsolutePositionFromRelativePosition(entry.startRelPos, this.doc);
          const absEnd = entry.endRelPos
            ? Y.createAbsolutePositionFromRelativePosition(entry.endRelPos, this.doc)
            : null;

          if (
            !absStart ||
            !(absStart.type === this.ytext || (absStart.type as any)?._item === (this.ytext as any)?._item)
          ) {
            return;
          }

          const startPos = this.monacoModel.getPositionAt(absStart.index);
          const endPos =
            absEnd &&
            (absEnd.type === this.ytext || (absEnd.type as any)?._item === (this.ytext as any)?._item)
              ? this.monacoModel.getPositionAt(absEnd.index)
              : startPos;

          const totalLines = this.monacoModel.getLineCount();
          if (startPos.lineNumber < 1 || startPos.lineNumber > totalLines) return;

          let range: monaco.Range;
          if (absEnd && absEnd.index > absStart.index) {
            // Strictly highlight ONLY the edit made by the user in that line (character span, NOT whole line)
            range = new monaco.Range(
              startPos.lineNumber,
              startPos.column,
              endPos.lineNumber,
              endPos.column
            );
          } else {
            // Single character/insertion point or deletion
            const maxCol = this.monacoModel.getLineMaxColumn(startPos.lineNumber);
            const col = Math.min(startPos.column, maxCol);
            const nextCol = Math.min(col + 1, maxCol);
            if (nextCol > col) {
              range = new monaco.Range(startPos.lineNumber, col, startPos.lineNumber, nextCol);
            } else if (col > 1) {
              range = new monaco.Range(startPos.lineNumber, col - 1, startPos.lineNumber, col);
            } else {
              range = new monaco.Range(startPos.lineNumber, 1, startPos.lineNumber, 2);
            }
          }

          const isMe = entry.userId === currentUserId;
          const safeKey = String(entry.userId || entry.userName).replace(
            /[^a-zA-Z0-9_-]/g,
            '_'
          );
          ensureUserEditStyle(safeKey, entry.userColor, entry.userName);
          if (entry.userId) ensureUserEditStyle(entry.userId, entry.userColor, entry.userName);
          if (entry.userName) ensureUserEditStyle(entry.userName, entry.userColor, entry.userName);

          const snippet = entry.text ? `: "${entry.text}"` : '';
          const hoverText = isMe
            ? `✍️ **You (${entry.userName})** edited${snippet} (Line ${startPos.lineNumber})`
            : `✍️ **${entry.userName}** edited${snippet} (Line ${startPos.lineNumber})`;

          decorations.push({
            range,
            options: {
              isWholeLine: false,
              className: `yRemoteEdit yRemoteEdit-${safeKey}`,
              inlineClassName: `yRemoteEditInline yRemoteEditInline-${safeKey}`,
              hoverMessage: {
                value: hoverText,
              },
              overviewRuler: {
                color: entry.userColor,
                position: 4,
              },
              stickiness:
                monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              zIndex: 10,
            },
          });
        } catch {}
      });

      const oldDecs = this._editLogDecorations.get(editor) || [];
      const newDecs = editor.deltaDecorations(oldDecs, decorations);
      this._editLogDecorations.set(editor, newDecs);
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
              value: `✍️ **${userName}** edited this snippet`,
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
        // Permanent edit highlight: stays active so users can check who edited where at any point
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
    this.renderLogHighlights();
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._isDestroyed = true;

    // Immediately flush any pending local edits so they are not lost on unmount or file switch
    if (this._localTypingTimer) {
      clearTimeout(this._localTypingTimer);
      this._localTypingTimer = null;
      try {
        this._commitLocalLineEdits();
      } catch {}
    }

    this._remoteTypingTimers.forEach((timer) => clearTimeout(timer));
    this._remoteTypingTimers.clear();
    this._pendingRemoteRanges.clear();
    this._pendingLocalRanges = [];

    try {
      this.editsMap.unobserve(this._editsMapObserver);
    } catch {}

    try {
      this._monacoChangeHandler.dispose();
    } catch {}
    try {
      this._monacoDisposeHandler.dispose();
    } catch {}
    this._cursorListeners.forEach((l) => {
      try {
        l.dispose();
      } catch {}
    });
    this._cursorListeners = [];

    try {
      this.ytext.unobserve(this._ytextObserver);
    } catch {}
    try {
      this.doc.off('beforeAllTransactions', this._beforeTransaction);
    } catch {}

    if (this.awareness) {
      try {
        this.awareness.off('change', this._rerenderDecorations);
      } catch {}
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

    // Clear all snippet edit highlights
    this._editDecorations.forEach((highlightsMap, editor) => {
      const decIds = Array.from(highlightsMap.keys());
      if (decIds.length > 0) {
        try {
          editor.deltaDecorations(decIds, []);
        } catch {}
      }
    });
    this._editDecorations.clear();

    // Clear CRDT edit log decorations
    this._editLogDecorations.forEach((decs, editor) => {
      if (decs && decs.length > 0) {
        try {
          editor.deltaDecorations(decs, []);
        } catch {}
      }
    });
    this._editLogDecorations.clear();

    // Clear offline highlights
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
