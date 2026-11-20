import { useEffect, useState, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { MonacoBinding } from 'y-monaco';
import type * as monacoEditor from 'monaco-editor';
import { buildDocumentName } from '@hostelcode/shared';
import type { ConnectionStatus, AuthUser, RoomMember, SupportedLanguage } from '@hostelcode/shared';
import type { WorkspaceFile } from '../types/workspace';
import { config } from '../lib/config';
import { updateCursorStyles } from './cursorStyles';
import {
  updateRoomFilesLocally,
  recycleFileOnServer,
  restoreFileOnServer,
  votePermanentDeleteOnServer,
} from '../lib/roomStorage';

interface UseRoomCollabOptions {
  roomCode: string;
  initialFiles: WorkspaceFile[];
  activeFileId: string;
  initialContent: string;
  currentUser: AuthUser;
  creatorUser: { id: string; name: string; email: string; color?: string };
  editor: monacoEditor.editor.IStandaloneCodeEditor | null;
}

/**
 * Deduplicates concurrent identical line insertions or intra-line duplicate statements.
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

    // Check consecutive identical duplicate lines
    if (result.length > 0) {
      const prevLine = result[result.length - 1];
      if (line.trim().length > 0 && line === prevLine) {
        hasDuplicates = true;
        affectedLines.push(result.length);
        continue;
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
  initialFiles,
  activeFileId,
  initialContent,
  currentUser,
  creatorUser,
  editor,
}: UseRoomCollabOptions) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>(() => initialFiles);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Known members tracking
  const knownMembersRef = useRef<Map<string, RoomMember>>(new Map());

  // Room Provider refs (Room-level presence and real-time CRDT files map)
  const roomDocRef = useRef<Y.Doc | null>(null);
  const roomProviderRef = useRef<HocuspocusProvider | null>(null);
  const yFilesMapRef = useRef<Y.Map<WorkspaceFile> | null>(null);

  // File Provider refs (Active file editor binding, cursors, per-user undo)
  const fileDocRef = useRef<Y.Doc | null>(null);
  const fileProviderRef = useRef<HocuspocusProvider | null>(null);
  const fileIndexeddbRef = useRef<IndexeddbPersistence | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);

  // Offline highlight tracking
  const wasOfflineRef = useRef<boolean>(false);
  const offlineBaselineTextRef = useRef<string | null>(null);
  const decorationsRef = useRef<any>(null);

  // Helper to apply semi-transparent yellow highlight to synced lines
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
              position: 4,
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

  // =========================================================================
  // 1. ROOM PROVIDER: Manages Room Awareness & Real-Time CRDT Files Map
  // =========================================================================
  useEffect(() => {
    if (!roomCode) return;

    const roomDocName = `room:${roomCode.trim().toUpperCase()}`;
    const roomDoc = new Y.Doc();
    roomDocRef.current = roomDoc;

    const yFilesMap = roomDoc.getMap<WorkspaceFile>('files');
    yFilesMapRef.current = yFilesMap;

    // Register creator
    knownMembersRef.current.set(creatorUser.id, {
      id: creatorUser.id,
      name: creatorUser.name,
      email: creatorUser.email,
      color: creatorUser.color || '#3B82F6',
      isOnline: creatorUser.id === currentUser.id,
      isCreator: true,
    });

    // Register current user
    knownMembersRef.current.set(currentUser.id, {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      color: currentUser.color,
      isOnline: true,
      isCreator: currentUser.id === creatorUser.id,
    });

    const roomProvider = new HocuspocusProvider({
      url: config.collabServerUrl,
      name: roomDocName,
      document: roomDoc,
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

        // Initialize shared files map if empty
        if (yFilesMap.size === 0 && initialFiles && initialFiles.length > 0) {
          roomDoc.transact(() => {
            initialFiles.forEach((file) => {
              yFilesMap.set(file.id, file);
            });
          }, 'initial-load');
        } else if (yFilesMap.size > 0) {
          const loaded = Array.from(yFilesMap.values());
          setFiles(loaded);
        }
      },
      onDisconnect() {
        setConnectionStatus('offline');
      },
      onClose() {
        setConnectionStatus('offline');
      },
      onAuthenticationFailed({ reason }) {
        console.error('[Hocuspocus Room Auth Failed]', reason);
        setConnectionStatus('offline');
      },
    });
    roomProviderRef.current = roomProvider;

    // Observe changes to shared files map — syncs file creations, deletions, and recycling across all peers in realtime!
    const filesObserver = () => {
      const currentList = Array.from(yFilesMap.values());
      setFiles(currentList);
    };
    yFilesMap.observe(filesObserver);

    // Setup Room Awareness
    const roomAwareness = roomProvider.awareness;
    const updateRoomMembers = () => {
      if (!roomAwareness) return;

      const onlineUsers = new Map<string, any>();
      const states = roomAwareness.getStates();

      states.forEach((state: any) => {
        if (state.user && state.user.id) {
          onlineUsers.set(state.user.id, state.user);
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

      const updatedMembers: RoomMember[] = [];
      knownMembersRef.current.forEach((mem) => {
        updatedMembers.push({
          ...mem,
          isOnline: onlineUsers.has(mem.id),
        });
      });

      // Sort: Creator first, then online, then name
      updatedMembers.sort((a, b) => {
        if (a.isCreator) return -1;
        if (b.isCreator) return 1;
        if (a.isOnline === b.isOnline) return a.name.localeCompare(b.name);
        return a.isOnline ? -1 : 1;
      });

      setMembers(updatedMembers);
    };

    if (roomAwareness) {
      roomAwareness.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color,
        activeFileId,
      });
      roomAwareness.on('change', updateRoomMembers);
    }
    updateRoomMembers();

    return () => {
      if (roomAwareness) {
        roomAwareness.off('change', updateRoomMembers);
      }
      yFilesMap.unobserve(filesObserver);
      roomProvider.destroy();
      roomDoc.destroy();
      roomDocRef.current = null;
      roomProviderRef.current = null;
      yFilesMapRef.current = null;
    };
  }, [roomCode, currentUser.id]);

  // Update current user's active file in room awareness whenever activeFileId changes
  useEffect(() => {
    if (roomProviderRef.current && roomProviderRef.current.awareness) {
      roomProviderRef.current.awareness.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color,
        activeFileId,
      });
    }
  }, [activeFileId, currentUser]);

  // =========================================================================
  // 2. FILE PROVIDER: Active File CRDT Monaco Binding, Realtime Cursors & Undo
  // =========================================================================
  useEffect(() => {
    if (!roomCode || !activeFileId) return;

    const fileDocName = buildDocumentName(roomCode, activeFileId);
    const fileDoc = new Y.Doc();
    fileDocRef.current = fileDoc;

    // Offline IndexedDB persistence for active file
    const fileIndexeddb = new IndexeddbPersistence(fileDocName, fileDoc);
    fileIndexeddbRef.current = fileIndexeddb;

    fileIndexeddb.once('synced', () => {
      const yText = fileDoc.getText('monaco');
      if (yText.length === 0 && initialContent) {
        fileDoc.transact(() => {
          yText.insert(0, initialContent);
        }, 'initialization');
      }
    });

    const fileProvider = new HocuspocusProvider({
      url: config.collabServerUrl,
      name: fileDocName,
      document: fileDoc,
      token: JSON.stringify({
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
      }),
      onSynced() {
        const yText = fileDoc.getText('monaco');
        const currentContent = yText.toString();

        if (wasOfflineRef.current || currentContent.length > 0) {
          const { deduped, hasDuplicates, affectedLines } = deduplicateAndReconcile(
            currentContent,
            offlineBaselineTextRef.current
          );

          if (hasDuplicates) {
            fileDoc.transact(() => {
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
        wasOfflineRef.current = true;
        if (fileDocRef.current) {
          offlineBaselineTextRef.current = fileDocRef.current.getText('monaco').toString();
        }
      },
      onClose() {
        wasOfflineRef.current = true;
        if (fileDocRef.current) {
          offlineBaselineTextRef.current = fileDocRef.current.getText('monaco').toString();
        }
      },
    });
    fileProviderRef.current = fileProvider;

    const fileAwareness = fileProvider.awareness;
    const handleAwarenessChange = () => {
      if (!fileAwareness) return;
      updateCursorStyles(fileAwareness);
    };

    if (fileAwareness) {
      fileAwareness.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color,
      });
      fileAwareness.on('change', handleAwarenessChange);
      updateCursorStyles(fileAwareness);
    }

    // Bind Monaco Editor to Yjs Text
    if (editor && editor.getModel() && fileAwareness) {
      const yText = fileDoc.getText('monaco');
      try {
        const binding = new MonacoBinding(
          yText,
          editor.getModel()!,
          new Set([editor]),
          fileAwareness
        );
        bindingRef.current = binding;

        // Per-User UndoManager (only tracks local user edits)
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
      if (fileAwareness) {
        fileAwareness.off('change', handleAwarenessChange);
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
      fileProvider.destroy();
      fileIndexeddb.destroy();
      fileDoc.destroy();
      fileDocRef.current = null;
      fileProviderRef.current = null;
    };
  }, [roomCode, activeFileId, currentUser.id, editor, applyYellowHighlights]);

  // =========================================================================
  // 3. REAL-TIME FILE ACTIONS (Instant Yjs CRDT Broadcast across all peers)
  // =========================================================================

  const handleCreateFile = useCallback(
    (name: string, language: SupportedLanguage, content?: string) => {
      const newFile: WorkspaceFile = {
        id: `file-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        name,
        path: `/${name}`,
        language,
        content: content !== undefined ? content : `// ${name}\n`,
        isRecycled: false,
        deleteVotes: [],
      };

      if (yFilesMapRef.current) {
        yFilesMapRef.current.set(newFile.id, newFile);
      } else {
        setFiles((prev) => [...prev, newFile]);
      }

      updateRoomFilesLocally(
        roomCode,
        [
          {
            ...newFile,
            projectId: roomCode,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        currentUser
      );
      return newFile;
    },
    [roomCode, currentUser]
  );

  const handleRecycleFile = useCallback(
    (fileId: string) => {
      if (yFilesMapRef.current) {
        const existing = yFilesMapRef.current.get(fileId);
        if (existing) {
          const updated: WorkspaceFile = {
            ...existing,
            isRecycled: true,
            recycledBy: currentUser.name,
            recycledAt: new Date().toISOString(),
            deleteVotes: [currentUser.id],
          };
          yFilesMapRef.current.set(fileId, updated);
        }
      } else {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId
              ? {
                  ...f,
                  isRecycled: true,
                  recycledBy: currentUser.name,
                  recycledAt: new Date().toISOString(),
                  deleteVotes: [currentUser.id],
                }
              : f
          )
        );
      }

      recycleFileOnServer(roomCode, fileId, currentUser);
    },
    [roomCode, currentUser]
  );

  const handleRestoreFile = useCallback(
    (fileId: string) => {
      if (yFilesMapRef.current) {
        const existing = yFilesMapRef.current.get(fileId);
        if (existing) {
          const updated: WorkspaceFile = {
            ...existing,
            isRecycled: false,
            recycledBy: undefined,
            recycledAt: undefined,
            deleteVotes: [],
          };
          yFilesMapRef.current.set(fileId, updated);
        }
      } else {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId
              ? {
                  ...f,
                  isRecycled: false,
                  recycledBy: undefined,
                  recycledAt: undefined,
                  deleteVotes: [],
                }
              : f
          )
        );
      }

      restoreFileOnServer(roomCode, fileId, currentUser);
    },
    [roomCode, currentUser]
  );

  const handleVotePermanentDelete = useCallback(
    async (fileId: string) => {
      const currentList = yFilesMapRef.current
        ? Array.from(yFilesMapRef.current.values())
        : files;
      const file = currentList.find((f) => f.id === fileId);
      if (!file) return;

      const currentVotes = file.deleteVotes || [];
      const updatedVotes = currentVotes.includes(currentUser.id)
        ? currentVotes
        : [...currentVotes, currentUser.id];

      const totalNeeded = Math.max(1, members.length);

      if (updatedVotes.length >= totalNeeded) {
        // Consensus of all room members reached: delete permanently!
        if (yFilesMapRef.current) {
          yFilesMapRef.current.delete(fileId);
        } else {
          setFiles((prev) => prev.filter((f) => f.id !== fileId));
        }
      } else {
        if (yFilesMapRef.current) {
          yFilesMapRef.current.set(fileId, { ...file, deleteVotes: updatedVotes });
        } else {
          setFiles((prev) =>
            prev.map((f) => (f.id === fileId ? { ...f, deleteVotes: updatedVotes } : f))
          );
        }
      }

      const res = await votePermanentDeleteOnServer(roomCode, fileId, currentUser);
      if (res?.permanentlyDeleted) {
        if (yFilesMapRef.current) {
          yFilesMapRef.current.delete(fileId);
        } else {
          setFiles((prev) => prev.filter((f) => f.id !== fileId));
        }
      }
    },
    [roomCode, currentUser, members.length, files]
  );

  const handleUpdateFileContent = useCallback(
    (fileId: string, content: string) => {
      if (yFilesMapRef.current) {
        const existing = yFilesMapRef.current.get(fileId);
        if (existing && existing.content !== content) {
          yFilesMapRef.current.set(fileId, { ...existing, content });
        }
      }
    },
    []
  );

  // Scoped undo / redo methods
  const handleUndo = useCallback(() => {
    if (undoManagerRef.current && undoManagerRef.current.canUndo()) {
      undoManagerRef.current.undo();
    }
  }, []);

  const handleRedo = useCallback(() => {
    if (undoManagerRef.current && undoManagerRef.current.canRedo()) {
      undoManagerRef.current.redo();
    }
  }, []);

  return {
    connectionStatus,
    members,
    files,
    canUndo,
    canRedo,
    undo: handleUndo,
    redo: handleRedo,
    syncNotice,
    createFile: handleCreateFile,
    recycleFile: handleRecycleFile,
    restoreFile: handleRestoreFile,
    votePermanentDelete: handleVotePermanentDelete,
    updateFileContent: handleUpdateFileContent,
    fileDoc: fileDocRef.current,
    roomDoc: roomDocRef.current,
  };
}
