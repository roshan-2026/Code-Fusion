import { useEffect, useState, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { MonacoBinding } from 'y-monaco';
import type * as monacoEditor from 'monaco-editor';
import { buildDocumentName } from '@hostelcode/shared';
import type { ConnectionStatus, AuthUser, RoomMember } from '@hostelcode/shared';
import { config } from '../lib/config';
import { updateCursorStyles } from './cursorStyles';

interface UseRoomCollabOptions {
  roomCode: string;
  activeFileId: string;
  initialContent: string;
  currentUser: AuthUser;
  creatorUser: { id: string; name: string; email: string; color?: string };
  editor: monacoEditor.editor.IStandaloneCodeEditor | null;
}

/**
 * Deduplicates concurrent identical line insertions or intra-line duplicate statements.
 * If user A (online) and user B (offline) made the same edits on a line, this eliminates
 * the duplicate copies and identifies line numbers that were synced/reconciled.
 */
function deduplicateAndReconcile(
  content: string,
  baselineContent?: string | null
): {
  deduped: string;
  hasDuplicates: boolean;
  affectedLines: number[];
} {
  const lines = content.split('\n');
  const result: string[] = [];
  const affectedLines: number[] = [];
  let hasDuplicates = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check intra-line duplicate: e.g. "const x = 1;const x = 1;"
    const trimmed = line.trim();
    if (trimmed.length >= 6 && trimmed.length % 2 === 0) {
      const halfLen = trimmed.length / 2;
      const first = trimmed.slice(0, halfLen);
      const second = trimmed.slice(halfLen);
      if (first === second) {
        const leadingSpaces = line.match(/^\s*/)?.[0] || '';
        line = leadingSpaces + first;
        hasDuplicates = true;
        affectedLines.push(result.length + 1);
      }
    }

    // Check consecutive identical duplicate lines (e.g. line inserted twice concurrently)
    if (result.length > 0) {
      const prevLine = result[result.length - 1];
      if (line.trim().length > 0 && line === prevLine) {
        hasDuplicates = true;
        affectedLines.push(result.length); // 1-based index of retained line
        continue; // Skip the duplicate copy!
      }
    }

    result.push(line);
  }

  // Also check 2-line block duplicate
  const finalLines: string[] = [];
  for (let i = 0; i < result.length; i++) {
    if (
      i + 3 < result.length &&
      result[i].trim().length > 0 &&
      result[i] === result[i + 2] &&
      result[i + 1] === result[i + 3]
    ) {
      finalLines.push(result[i]);
      finalLines.push(result[i + 1]);
      affectedLines.push(finalLines.length - 1, finalLines.length);
      i += 3;
      hasDuplicates = true;
      continue;
    }
    finalLines.push(result[i]);
  }

  const finalOutput = finalLines.join('\n');

  // Also if baseline was provided, detect any lines that changed between baseline and merged output
  if (baselineContent) {
    const baselineLines = baselineContent.split('\n');
    const outLines = finalOutput.split('\n');
    for (let i = 0; i < outLines.length; i++) {
      if (outLines[i] !== baselineLines[i] && outLines[i].trim().length > 0) {
        affectedLines.push(i + 1);
      }
    }
  }

  return {
    deduped: finalOutput,
    hasDuplicates,
    affectedLines: Array.from(new Set(affectedLines)).sort((a, b) => a - b),
  };
}

export function useRoomCollab({
  roomCode,
  activeFileId,
  initialContent,
  currentUser,
  creatorUser,
  editor,
}: UseRoomCollabOptions) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Track known members across sessions
  const knownMembersRef = useRef<Map<string, RoomMember>>(new Map());

  // Offline reconciliation tracking
  const wasOfflineRef = useRef<boolean>(false);
  const offlineBaselineTextRef = useRef<string | null>(null);
  const decorationsRef = useRef<any>(null);

  // Refs for cleanup and stable callbacks
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const indexeddbRef = useRef<IndexeddbPersistence | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);

  // Function to apply semi-transparent yellow highlight to synced lines in Monaco
  const applyYellowHighlights = useCallback(
    (ed: monacoEditor.editor.IStandaloneCodeEditor, lines: number[]) => {
      try {
        const model = ed.getModel();
        if (!model) return;

        const maxLine = model.getLineCount();
        const validLines = lines.filter((l) => l >= 1 && l <= maxLine);
        if (validLines.length === 0) return;

        const newDecorations = validLines.map((lineNumber) => ({
          range: {
            startLineNumber: lineNumber,
            startColumn: 1,
            endLineNumber: lineNumber,
            endColumn: model.getLineMaxColumn(lineNumber),
          },
          options: {
            isWholeLine: true,
            className: 'hostelcode-offline-sync-highlight',
            overviewRuler: {
              color: '#EAB308',
              position: 4, // OverviewRulerLane.Right
            },
            hoverMessage: {
              value: '⚡ **Synced from Offline User**: Changes merged cleanly without duplicate text.',
            },
          },
        }));

        if ((ed as any).createDecorationsCollection) {
          if (decorationsRef.current) {
            decorationsRef.current.clear();
          }
          decorationsRef.current = (ed as any).createDecorationsCollection(newDecorations);
        } else {
          (ed as any)._offlineDecs = ed.deltaDecorations(
            (ed as any)._offlineDecs || [],
            newDecorations
          );
        }

        // Highlight stays visible for 20 seconds for clear collaborator visibility
        setTimeout(() => {
          try {
            if (decorationsRef.current) {
              decorationsRef.current.clear();
              decorationsRef.current = null;
            } else if ((ed as any)._offlineDecs) {
              (ed as any)._offlineDecs = ed.deltaDecorations((ed as any)._offlineDecs, []);
            }
          } catch {}
        }, 20000);
      } catch (err) {
        console.warn('[Collab] Failed to apply yellow highlight:', err);
      }
    },
    []
  );

  useEffect(() => {
    if (!roomCode || !activeFileId) return;

    const docName = buildDocumentName(roomCode, activeFileId);
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    // 1. Setup local IndexedDB persistence (offline survival)
    const indexeddb = new IndexeddbPersistence(docName, ydoc);
    indexeddbRef.current = indexeddb;

    // Populate initial content if document is fresh
    indexeddb.once('synced', () => {
      const yText = ydoc.getText('monaco');
      if (yText.length === 0 && initialContent) {
        ydoc.transact(() => {
          yText.insert(0, initialContent);
        }, 'initialization');
      }
    });

    // 2. Setup Hocuspocus WebSocket Provider
    const provider = new HocuspocusProvider({
      url: config.collabServerUrl,
      name: docName,
      document: ydoc,
      token: JSON.stringify({
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
      }),
      onConnect() {
        setConnectionStatus('syncing');
      },
      onSynced() {
        setConnectionStatus('online');

        // Check if we just reconnected from being offline, or if document has duplicate lines to reconcile
        const yText = ydoc.getText('monaco');
        const currentContent = yText.toString();

        if (wasOfflineRef.current || currentContent.length > 0) {
          const { deduped, hasDuplicates, affectedLines } = deduplicateAndReconcile(
            currentContent,
            offlineBaselineTextRef.current
          );

          if (hasDuplicates) {
            ydoc.transact(() => {
              yText.delete(0, yText.length);
              yText.insert(0, deduped);
            }, 'reconciliation');
          }

          if (affectedLines.length > 0 && editor) {
            applyYellowHighlights(editor, affectedLines);
            setSyncNotice(
              `⚡ Synced changes (${affectedLines.length} line(s) merged & highlighted in yellow).`
            );
            setTimeout(() => setSyncNotice(null), 8000);
          }
        }

        wasOfflineRef.current = false;
        offlineBaselineTextRef.current = null;
      },
      onDisconnect() {
        setConnectionStatus('offline');
        wasOfflineRef.current = true;
        if (ydocRef.current) {
          offlineBaselineTextRef.current = ydocRef.current.getText('monaco').toString();
        }
      },
      onClose() {
        setConnectionStatus('offline');
        wasOfflineRef.current = true;
        if (ydocRef.current) {
          offlineBaselineTextRef.current = ydocRef.current.getText('monaco').toString();
        }
      },
      onAuthenticationFailed({ reason }) {
        console.error('[Hocuspocus Auth Failed]', reason);
        setConnectionStatus('offline');
      },
    });
    providerRef.current = provider;

    // Register creator as a known member
    knownMembersRef.current.set(creatorUser.id, {
      id: creatorUser.id,
      name: creatorUser.name,
      email: creatorUser.email,
      color: creatorUser.color || '#3B82F6',
      isOnline: creatorUser.id === currentUser.id,
      isCreator: true,
    });

    // Register current user as online member
    knownMembersRef.current.set(currentUser.id, {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      color: currentUser.color,
      isOnline: true,
      isCreator: currentUser.id === creatorUser.id,
    });

    // 3. Setup Awareness (User Presence & Cursors)
    const awareness = provider.awareness;
    const updateMembersAndCursors = () => {
      if (!awareness) return;

      // Update cursor styling rules in DOM
      updateCursorStyles(awareness);

      const onlineUserIds = new Set<string>();
      const states = awareness.getStates();

      states.forEach((state: any) => {
        if (state.user && state.user.id) {
          onlineUserIds.add(state.user.id);
          knownMembersRef.current.set(state.user.id, {
            id: state.user.id,
            name: state.user.name,
            email: state.user.email,
            color: state.user.color,
            isOnline: true,
            isCreator: state.user.id === creatorUser.id,
          });
        }
      });

      // Update online/offline flags for all known members
      const updatedList: RoomMember[] = [];
      knownMembersRef.current.forEach((mem) => {
        updatedList.push({
          ...mem,
          isOnline: onlineUserIds.has(mem.id),
        });
      });

      // Sort: Creator first, then online members, then offline
      updatedList.sort((a, b) => {
        if (a.isCreator) return -1;
        if (b.isCreator) return 1;
        if (a.isOnline === b.isOnline) return a.name.localeCompare(b.name);
        return a.isOnline ? -1 : 1;
      });

      setMembers(updatedList);
    };

    if (awareness) {
      awareness.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color,
      });
      awareness.on('change', updateMembersAndCursors);
    }

    updateMembersAndCursors();

    // 4. Bind Monaco Editor to Yjs Text
    if (editor && editor.getModel() && awareness) {
      const yText = ydoc.getText('monaco');
      try {
        const binding = new MonacoBinding(
          yText,
          editor.getModel()!,
          new Set([editor]),
          awareness
        );
        bindingRef.current = binding;

        // 5. PER-USER UNDO/REDO via Y.UndoManager
        // Track ONLY transactions created by this local MonacoBinding instance.
        // Remote edits arriving from other users have different origins and are NOT tracked!
        const undoManager = new Y.UndoManager(yText, {
          trackedOrigins: new Set([binding]),
        });
        undoManagerRef.current = undoManager;

        const updateUndoState = () => {
          setCanUndo(undoManager.canUndo());
          setCanRedo(undoManager.canRedo());
        };

        undoManager.on('stack-item-added', updateUndoState);
        undoManager.on('stack-item-popped', updateUndoState);
        updateUndoState();

        // Bind keyboard shortcuts in Monaco to scoped UndoManager
        editor.addCommand(2048 /* KeyMod.CtrlCmd */ | 56 /* KeyCode.KeyZ */, () => {
          if (undoManager.canUndo()) {
            undoManager.undo();
          }
        });
        editor.addCommand(
          2048 /* KeyMod.CtrlCmd */ | 1024 /* KeyMod.Shift */ | 56 /* KeyCode.KeyZ */,
          () => {
            if (undoManager.canRedo()) {
              undoManager.redo();
            }
          }
        );
        editor.addCommand(2048 /* KeyMod.CtrlCmd */ | 55 /* KeyCode.KeyY */, () => {
          if (undoManager.canRedo()) {
            undoManager.redo();
          }
        });
      } catch (err) {
        console.warn('[Collab] Binding error:', err);
      }
    }

    return () => {
      if (awareness) {
        awareness.off('change', updateMembersAndCursors);
      }
      if (undoManagerRef.current) {
        undoManagerRef.current.destroy();
        undoManagerRef.current = null;
      }
      if (bindingRef.current) {
        bindingRef.current.destroy();
        bindingRef.current = null;
      }
      if (decorationsRef.current) {
        decorationsRef.current.clear();
        decorationsRef.current = null;
      }
      provider.destroy();
      indexeddb.destroy();
      ydoc.destroy();
    };
  }, [roomCode, activeFileId, currentUser.id, editor, applyYellowHighlights]);

  // Scoped undo method: undos ONLY current user's edits
  const handleUndo = useCallback(() => {
    if (undoManagerRef.current && undoManagerRef.current.canUndo()) {
      undoManagerRef.current.undo();
    }
  }, []);

  // Scoped redo method: redos ONLY current user's undone edits
  const handleRedo = useCallback(() => {
    if (undoManagerRef.current && undoManagerRef.current.canRedo()) {
      undoManagerRef.current.redo();
    }
  }, []);

  return {
    connectionStatus,
    members,
    canUndo,
    canRedo,
    undo: handleUndo,
    redo: handleRedo,
    syncNotice,
    ydoc: ydocRef.current,
    provider: providerRef.current,
  };
}
