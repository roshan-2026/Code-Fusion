import { useEffect, useState, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import { MonacoCollabBinding } from './MonacoCollabBinding';
import type * as monacoEditor from 'monaco-editor';
import { buildDocumentName, getCollaboratorColor } from '@hostelcode/shared';
import type { ConnectionStatus, AuthUser, RoomMember, SupportedLanguage } from '@hostelcode/shared';
import type { WorkspaceFile } from '../types/workspace';
import { config } from '../lib/config';
import { updateCursorStyles } from './cursorStyles';
import {
  updateRoomFilesLocally,
  recycleFileOnServer,
  restoreFileOnServer,
  votePermanentDeleteOnServer,
  purgeRoomLocally,
  verifyRoomActiveOnServer,
} from '../lib/roomStorage';

export interface UseRoomCollabOptions {
  roomCode: string;
  initialFiles: WorkspaceFile[];
  initialMembers?: RoomMember[];
  activeFileId: string;
  initialContent: string;
  currentUser: AuthUser;
  creatorUser: { id: string; name: string; email: string; color?: string };
  editor: monacoEditor.editor.IStandaloneCodeEditor | null;
  onRoomClosed?: (message: string) => void;
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
  let currentContent = yText.toString();
  if (!currentContent) return [];

  // 1. Guard against multi-line duplicate blocks (e.g. entire code block copied 2x, 3x, or 4x)
  const rawLines = currentContent.trim().split('\n');
  for (const divisor of [4, 3, 2]) {
    if (rawLines.length >= divisor * 2 && rawLines.length % divisor === 0) {
      const chunkSize = rawLines.length / divisor;
      const firstChunk = rawLines.slice(0, chunkSize).join('\n').trim();
      let allMatch = true;
      for (let d = 1; d < divisor; d++) {
        const chunk = rawLines.slice(d * chunkSize, (d + 1) * chunkSize).join('\n').trim();
        if (chunk !== firstChunk) {
          allMatch = false;
          break;
        }
      }
      if (allMatch && firstChunk.length >= 10) {
        let keepLength = 0;
        for (let i = 0; i < chunkSize; i++) {
          keepLength += rawLines[i].length + (i < chunkSize - 1 ? 1 : 0);
        }
        if (currentContent[keepLength] === '\n') {
          keepLength += 1;
        }
        fileDoc.transact(() => {
          yText.delete(keepLength, yText.length - keepLength);
        }, 'offline-duplicate-block-reconcile');
        currentContent = yText.toString();
        break;
      }
    }
  }

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
  initialMembers = [],
  activeFileId,
  initialContent,
  currentUser,
  creatorUser,
  editor,
  onRoomClosed,
}: UseRoomCollabOptions) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>(() => initialFiles);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [isRoomClosed, setIsRoomClosed] = useState<boolean>(false);
  const [closureNotice, setClosureNotice] = useState<string | null>(null);

  const isClosedRef = useRef<boolean>(false);
  const onRoomClosedRef = useRef(onRoomClosed);
  onRoomClosedRef.current = onRoomClosed;

  // Active file ref for presence broadcast
  const activeFileIdRef = useRef<string>(activeFileId);
  activeFileIdRef.current = activeFileId;

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
  const offlineStateVectorRef = useRef<Uint8Array | null>(null);
  const pendingOfflineHighlightVectorRef = useRef<Uint8Array | null>(null);
  const offlineBaselineTextRef = useRef<string | null>(null);

  // Centralized handler for when room is closed or does not exist
  const triggerRoomClosed = useCallback(
    (message: string) => {
      if (isClosedRef.current) return;
      isClosedRef.current = true;
      setIsRoomClosed(true);
      setClosureNotice(message);

      console.warn(`[Collab] Room ${roomCode} has been closed: ${message}`);
      purgeRoomLocally(roomCode);

      try {
        roomProviderRef.current?.disconnect();
        roomProviderRef.current?.destroy();
      } catch {}
      try {
        fileProviderRef.current?.disconnect();
        fileProviderRef.current?.destroy();
      } catch {}

      if (onRoomClosedRef.current) {
        onRoomClosedRef.current(message);
      }
    },
    [roomCode]
  );

  // Stamping closure in room CRDT metadata before admin deletion propagates instantly to all online peers
  const markRoomClosed = useCallback(() => {
    if (roomDocRef.current) {
      try {
        const roomMeta = roomDocRef.current.getMap('roomMeta');
        roomDocRef.current.transact(() => {
          roomMeta.set('status', 'closed');
          roomMeta.set('closureMessage', 'This room does not exist or has been closed by the host.');
        }, 'host-close-room');
      } catch (err) {
        console.warn('[Collab] Failed to stamp roomMeta closure:', err);
      }
    }
  }, []);

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

    const roomMetaMap = roomDoc.getMap('roomMeta');
    const checkRoomMetaClosure = () => {
      if (roomMetaMap.get('status') === 'closed') {
        const msg =
          (roomMetaMap.get('closureMessage') as string) ||
          'This room does not exist or has been closed by the host.';
        triggerRoomClosed(msg);
      }
    };
    roomMetaMap.observe(checkRoomMetaClosure);

    // 1. Preload any previously joined room members from server database / cache
    if (initialMembers && initialMembers.length > 0) {
      initialMembers.forEach((mem) => {
        knownMembersRef.current.set(mem.id, {
          id: mem.id,
          name: mem.name,
          email: mem.email,
          color: mem.color || getCollaboratorColor(mem.email || mem.name),
          isOnline: mem.id === currentUser.id,
          isCreator: mem.id === creatorUser.id || Boolean(mem.isCreator),
        });
      });
    }

    // Register creator
    knownMembersRef.current.set(creatorUser.id, {
      id: creatorUser.id,
      name: creatorUser.name,
      email: creatorUser.email,
      color: creatorUser.color || getCollaboratorColor(creatorUser.email || creatorUser.name),
      isOnline: creatorUser.id === currentUser.id,
      isCreator: true,
    });

    // Register current user
    knownMembersRef.current.set(currentUser.id, {
      id: currentUser.id,
      name: currentUser.name,
      email: currentUser.email,
      color: currentUser.color || getCollaboratorColor(currentUser.email || currentUser.name),
      isOnline: true,
      isCreator: currentUser.id === creatorUser.id,
    });

    // Helper to broadcast room-level presence over Yjs awareness
    const broadcastRoomPresence = () => {
      if (!roomProviderRef.current) return;
      const aw = roomProviderRef.current.awareness;
      if (!aw) return;
      aw.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color || getCollaboratorColor(currentUser.email || currentUser.name),
        activeFileId: activeFileIdRef.current,
      });
    };

    const updateRoomMembers = () => {
      const roomAwareness = roomProviderRef.current?.awareness;
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
            color: state.user.color || getCollaboratorColor(state.user.email || state.user.name),
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

    // Server verification helper to check if room is still active
    const verifyRoomStatus = async () => {
      if (isClosedRef.current) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      try {
        const check = await verifyRoomActiveOnServer(roomCode);
        if (!check.exists) {
          triggerRoomClosed(
            check.message || 'This room does not exist or has been closed by the host.'
          );
        }
      } catch (err) {
        console.warn('[Collab] Error checking room status:', err);
      }
    };

    // Actively verify room existence on mount if online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      verifyRoomStatus();
    }

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
        broadcastRoomPresence();
      },
      onSynced() {
        setConnectionStatus('online');
        broadcastRoomPresence();
        updateRoomMembers();
        checkRoomMetaClosure();

        // Initialize shared files map if empty (Creator only!)
        if (
          yFilesMap.size === 0 &&
          initialFiles &&
          initialFiles.length > 0 &&
          currentUser.id === creatorUser.id
        ) {
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
      onClose({ event }: { event: any }) {
        setConnectionStatus('offline');
        if (
          event?.code === 4404 ||
          event?.reason?.includes('closed') ||
          event?.reason?.includes('does not exist')
        ) {
          triggerRoomClosed(
            event?.reason || 'This room does not exist or has been closed by the host.'
          );
        }
      },
      onAuthenticationFailed({ reason }: { reason: string }) {
        console.error('[Hocuspocus Room Auth Failed]', reason);
        setConnectionStatus('offline');
        if (
          reason?.includes('ROOM_NOT_FOUND') ||
          reason?.includes('does not exist') ||
          reason?.includes('closed')
        ) {
          triggerRoomClosed('This room does not exist or has been closed by the host.');
        } else {
          verifyRoomActiveOnServer(roomCode).then((check) => {
            if (!check.exists) {
              triggerRoomClosed(
                check.message || 'This room does not exist or has been closed by the host.'
              );
            }
          });
        }
      },
    });
    roomProviderRef.current = roomProvider;

    roomProvider.on('stateless', ({ payload }: { payload: string }) => {
      try {
        const data = JSON.parse(payload);
        if (data.type === 'ROOM_CLOSED') {
          triggerRoomClosed(data.message || 'This room does not exist or has been closed by the host.');
        }
      } catch {}
    });

    roomProvider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        broadcastRoomPresence();
        updateRoomMembers();
        verifyRoomStatus();
      }
    });

    // Observe changes to shared files map — syncs file creations, deletions, and recycling across all peers in realtime!
    const filesObserver = () => {
      const currentList = Array.from(yFilesMap.values());
      setFiles(currentList);
    };
    yFilesMap.observe(filesObserver);

    // Setup Room Awareness
    const roomAwareness = roomProvider.awareness;
    if (roomAwareness) {
      roomAwareness.on('change', updateRoomMembers);
      broadcastRoomPresence();
    }
    updateRoomMembers();

    // Reconnection & focus presence & room existence handlers
    const handleWindowFocus = () => {
      broadcastRoomPresence();
      updateRoomMembers();
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        verifyRoomStatus();
      }
    };
    const handleOnline = () => {
      broadcastRoomPresence();
      updateRoomMembers();
      verifyRoomStatus();
    };

    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('online', handleOnline);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        broadcastRoomPresence();
        updateRoomMembers();
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          verifyRoomStatus();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Periodic presence heartbeat and online room existence verification
    const presenceHeartbeat = setInterval(() => {
      if (roomProviderRef.current && roomProviderRef.current.isConnected) {
        broadcastRoomPresence();
      }
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        verifyRoomStatus();
      }
    }, 8000);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(presenceHeartbeat);

      if (roomAwareness) {
        roomAwareness.off('change', updateRoomMembers);
      }
      roomMetaMap.unobserve(checkRoomMetaClosure);
      yFilesMap.unobserve(filesObserver);
      roomProvider.destroy();
      roomDoc.destroy();
      roomDocRef.current = null;
      roomProviderRef.current = null;
      yFilesMapRef.current = null;
    };
  }, [roomCode, currentUser.id, triggerRoomClosed]);

  // Update current user's active file in room awareness whenever activeFileId changes
  useEffect(() => {
    if (roomProviderRef.current && roomProviderRef.current.awareness) {
      roomProviderRef.current.awareness.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color || getCollaboratorColor(currentUser.email || currentUser.name),
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
    const isCreator = currentUser.id === creatorUser.id;

    let hasSeeded = false;
    const seedIfEmpty = () => {
      // ONLY the creator of the room can seed initial template content if the document is still empty!
      // A joining user must NEVER insert initial template code into an existing room.
      if (!isCreator || hasSeeded) return;
      const yText = fileDoc.getText('monaco');
      // Only seed if doc has 0 length after provider sync has confirmed the room document is empty
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

    const registerClientMeta = () => {
      if (!fileDocRef.current) return;
      try {
        const metaMap = fileDocRef.current.getMap<any>('_clientMeta');
        metaMap.set(String(fileDocRef.current.clientID), {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
          color: currentUser.color,
        });
      } catch {}
    };
    registerClientMeta();

    // Offline IndexedDB persistence for active file
    const fileIndexeddb = new IndexeddbPersistence(fileDocName, fileDoc);
    fileIndexeddbRef.current = fileIndexeddb;

    fileIndexeddb.once('synced', () => {
      registerClientMeta();
      // DO NOT call seedIfEmpty() here!
      // Local IndexedDB is only a client cache. Never insert initial content before the server syncs.
      // Only if the browser is literally offline with cached content do we treat it as an offline baseline:
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!offlineStateVectorRef.current && fileDocRef.current) {
          offlineStateVectorRef.current = Y.encodeStateVector(fileDocRef.current);
          const cached = fileDocRef.current.getText('monaco').toString();
          if (cached && cached.length > 0) {
            offlineBaselineTextRef.current = cached;
            wasOfflineRef.current = true;
          }
        }
      }
    });

    const broadcastFilePresence = () => {
      if (!fileProviderRef.current) return;
      const aw = fileProviderRef.current.awareness;
      if (!aw) return;
      aw.setLocalStateField('user', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        color: currentUser.color || getCollaboratorColor(currentUser.email || currentUser.name),
      });
      updateCursorStyles(aw);
    };

    const fileProvider = new HocuspocusProvider({
      url: config.collabServerUrl,
      name: fileDocName,
      document: fileDoc,
      token: JSON.stringify({
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
      }),
      onConnect() {
        registerClientMeta();
        broadcastFilePresence();
      },
      onSynced() {
        // Only creator will seed if doc is still empty after server sync
        seedIfEmpty();
        registerClientMeta();
        broadcastFilePresence();

        // Safely reconcile offline edits and highlight snippets in author unique colors
        if (wasOfflineRef.current) {
          reconcileOfflineSync(
            fileDoc,
            offlineBaselineTextRef.current
          );

          if (offlineStateVectorRef.current) {
            if (bindingRef.current) {
              const result = bindingRef.current.highlightOfflineEdits(
                offlineStateVectorRef.current,
                knownMembersRef.current
              );
              if (result.count > 0) {
                const authorsStr =
                  result.authors.length > 0 ? result.authors.join(', ') : 'team';
                setSyncNotice(
                  `⚡ Reconnected: ${result.count} change(s) by ${authorsStr} highlighted in their unique colors (visible for 2 min).`
                );
                setTimeout(() => setSyncNotice(null), 25000);
              }
            } else {
              pendingOfflineHighlightVectorRef.current = offlineStateVectorRef.current;
            }
          }

          wasOfflineRef.current = false;
          offlineStateVectorRef.current = null;
          offlineBaselineTextRef.current = null;
        }
      },
      onDisconnect() {
        wasOfflineRef.current = true;
        if (fileDocRef.current) {
          offlineStateVectorRef.current = Y.encodeStateVector(fileDocRef.current);
          offlineBaselineTextRef.current = fileDocRef.current.getText('monaco').toString();
        }
      },
      onClose({ event }: { event: any }) {
        wasOfflineRef.current = true;
        if (fileDocRef.current) {
          offlineStateVectorRef.current = Y.encodeStateVector(fileDocRef.current);
          offlineBaselineTextRef.current = fileDocRef.current.getText('monaco').toString();
        }
        if (
          event?.code === 4404 ||
          event?.reason?.includes('closed') ||
          event?.reason?.includes('does not exist')
        ) {
          triggerRoomClosed(
            event?.reason || 'This room does not exist or has been closed by the host.'
          );
        }
      },
      onAuthenticationFailed({ reason }: { reason: string }) {
        if (
          reason?.includes('ROOM_NOT_FOUND') ||
          reason?.includes('does not exist') ||
          reason?.includes('closed')
        ) {
          triggerRoomClosed('This room does not exist or has been closed by the host.');
        }
      },
    });
    fileProviderRef.current = fileProvider;

    fileProvider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        broadcastFilePresence();
      }
    });

    const handleBrowserOffline = () => {
      wasOfflineRef.current = true;
      if (fileDocRef.current) {
        offlineStateVectorRef.current = Y.encodeStateVector(fileDocRef.current);
        offlineBaselineTextRef.current = fileDocRef.current.getText('monaco').toString();
      }
    };
    window.addEventListener('offline', handleBrowserOffline);

    const fileAwareness = fileProvider.awareness;
    const handleAwarenessChange = () => {
      if (!fileAwareness) return;
      updateCursorStyles(fileAwareness);
    };

    if (fileAwareness) {
      fileAwareness.on('change', handleAwarenessChange);
      broadcastFilePresence();
    }

    const handleFileFocus = () => {
      broadcastFilePresence();
    };
    window.addEventListener('focus', handleFileFocus);
    window.addEventListener('online', handleFileFocus);

    const filePresenceHeartbeat = setInterval(() => {
      if (fileProviderRef.current && fileProviderRef.current.isConnected) {
        broadcastFilePresence();
      }
    }, 8000);

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

        // If an offline highlight was pending waiting for the editor binding
        if (pendingOfflineHighlightVectorRef.current) {
          const result = binding.highlightOfflineEdits(
            pendingOfflineHighlightVectorRef.current,
            knownMembersRef.current
          );
          if (result.count > 0) {
            const authorsStr =
              result.authors.length > 0 ? result.authors.join(', ') : 'team';
            setSyncNotice(
              `⚡ Reconnected: ${result.count} change(s) by ${authorsStr} highlighted in their unique colors (visible for 2 min).`
            );
            setTimeout(() => setSyncNotice(null), 25000);
          }
          pendingOfflineHighlightVectorRef.current = null;
        }

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
      window.removeEventListener('focus', handleFileFocus);
      window.removeEventListener('online', handleFileFocus);
      clearInterval(filePresenceHeartbeat);
      window.removeEventListener('offline', handleBrowserOffline);
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
      fileProvider.destroy();
      fileIndexeddb.destroy();
      fileDoc.destroy();
      fileDocRef.current = null;
      fileProviderRef.current = null;
    };
  }, [roomCode, activeFileId, currentUser.id, editor]);

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
    isRoomClosed,
    closureNotice,
    markRoomClosed,
    createFile: handleCreateFile,
    recycleFile: handleRecycleFile,
    restoreFile: handleRestoreFile,
    votePermanentDelete: handleVotePermanentDelete,
    updateFileContent: handleUpdateFileContent,
    fileDoc: fileDocRef.current,
    roomDoc: roomDocRef.current,
  };
}
