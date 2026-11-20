import { useEffect, useState, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { MonacoCollabBinding } from './MonacoCollabBinding';
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
 * Safely reconciles concurrent identical line insertions after an offline reconnection.
 * Uses targeted character-range deletions rather than wiping the document, preserving
 * all other lines, cursor selections, and CRDT history.
 */
function reconcileOfflineSync(
  fileDoc: Y.Doc,
  baselineContent: string | null
): number[] {
  const yText = fileDoc.getText('monaco');
  const currentContent = yText.toString();
  if (!currentContent) return [];

  const lines = currentContent.split('\n');
  const baselineLines = baselineContent ? baselineContent.split('\n') : [];

  // Check baseline for consecutive duplicates so we never remove intentional duplicates in existing code
  const baselineConsecutiveDupes = new Set<string>();
  for (let i = 0; i < baselineLines.length - 1; i++) {
    const t = baselineLines[i].trim();
    if (t.length > 0 && t === baselineLines[i + 1].trim()) {
      baselineConsecutiveDupes.add(t);
    }
  }

  // Find newly introduced concurrent duplicate lines
  const duplicateRanges: { start: number; length: number }[] = [];
  let currentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
    const trimmed = line.trim();

    if (
      i > 0 &&
      trimmed.length >= 3 &&
      trimmed === lines[i - 1].trim() &&
      !baselineConsecutiveDupes.has(trimmed)
    ) {
      // Line i is an accidental duplicate of line i-1 caused by concurrent offline merge
      duplicateRanges.push({
        start: currentOffset,
        length: lineLen,
      });
    }

    currentOffset += lineLen;
  }

  // Delete redundant duplicate lines in reverse order to preserve earlier offsets
  if (duplicateRanges.length > 0) {
    fileDoc.transact(() => {
      for (let j = duplicateRanges.length - 1; j >= 0; j--) {
        const r = duplicateRanges[j];
        yText.delete(r.start, r.length);
      }
    }, 'offline-duplicate-reconcile');
  }

  // Calculate affected lines for yellow highlighting
  const finalContent = yText.toString();
  const finalLines = finalContent.split('\n');
  const affectedLines: number[] = [];

  for (let i = 0; i < finalLines.length; i++) {
    if (i >= baselineLines.length || finalLines[i] !== baselineLines[i]) {
      if (finalLines[i].trim().length > 0) {
        affectedLines.push(i + 1);
      }
    }
  }

  return affectedLines;
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
  const bindingRef = useRef<MonacoCollabBinding | null>(null);
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

    // Resolve initial seed content from shared files map, files state, or initialFiles/Content
    const targetFile =
      yFilesMapRef.current?.get(activeFileId) ||
      files.find((f) => f.id === activeFileId) ||
      initialFiles.find((f) => f.id === activeFileId);
    const seedContent = targetFile?.content || initialContent;

    let hasSeeded = false;
    const seedIfEmpty = () => {
      if (hasSeeded) return;
      const yText = fileDoc.getText('monaco');
      // Only seed if doc has 0 length after IndexedDB/provider sync has delivered data
      if (yText.length === 0 && seedContent) {
        fileDoc.transact(() => {
          if (yText.length === 0) {
            yText.insert(0, seedContent);
          }
        }, 'initialization');
        hasSeeded = true;
      } else if (yText.length > 0) {
        hasSeeded = true;
      }
    };

    // Offline IndexedDB persistence for active file
    const fileIndexeddb = new IndexeddbPersistence(fileDocName, fileDoc);
    fileIndexeddbRef.current = fileIndexeddb;

    fileIndexeddb.once('synced', () => {
      seedIfEmpty();
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
        seedIfEmpty();

        // Safely reconcile offline edits without destroying document history
        if (wasOfflineRef.current) {
          const affectedLines = reconcileOfflineSync(
            fileDoc,
            offlineBaselineTextRef.current
          );

          if (affectedLines.length > 0 && editor) {
            applyYellowHighlights(editor, affectedLines);
            setSyncNotice(
              `⚡ Synced changes (${affectedLines.length} line(s) merged & highlighted in yellow).`
            );
            setTimeout(() => setSyncNotice(null), 8000);
          }

          wasOfflineRef.current = false;
          offlineBaselineTextRef.current = null;
        }
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

    // Bind Monaco Editor to Yjs Text using our enhanced MonacoCollabBinding
    if (editor && editor.getModel() && fileAwareness) {
      const yText = fileDoc.getText('monaco');
      try {
        const binding = new MonacoCollabBinding(
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

      if (newFile.content) {
        try {
          const fileDocName = buildDocumentName(roomCode, newFile.id);
          const seedDoc = new Y.Doc();
          seedDoc.getText('monaco').insert(0, newFile.content);
          const idb = new IndexeddbPersistence(fileDocName, seedDoc);
          idb.once('synced', () => {
            idb.destroy();
            seedDoc.destroy();
          });
        } catch (err) {
          console.warn('[Collab] Failed to pre-seed file into IndexedDB:', err);
        }
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
