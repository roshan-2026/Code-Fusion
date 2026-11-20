import * as Y from 'yjs';
import * as monaco from 'monaco-editor';
import type { Awareness } from 'y-protocols/awareness';

class RelativeSelection {
  constructor(
    public start: Y.RelativePosition,
    public end: Y.RelativePosition,
    public direction: monaco.SelectionDirection
  ) {}
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
        let index = 0;
        event.delta.forEach((op) => {
          if (op.retain !== undefined) {
            index += op.retain;
          } else if (op.insert !== undefined) {
            const pos = this.monacoModel.getPositionAt(index);
            const range = new monaco.Selection(
              pos.lineNumber,
              pos.column,
              pos.lineNumber,
              pos.column
            );
            const insert = op.insert as string;
            this.monacoModel.applyEdits([{ range, text: insert }]);
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

    this.editors.forEach((editor) => {
      const decs = this._decorations.get(editor);
      if (decs && decs.length > 0) {
        try {
          editor.deltaDecorations(decs, []);
        } catch {}
      }
    });
    this._decorations.clear();
  }
}
