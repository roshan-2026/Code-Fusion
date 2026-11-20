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

  // Track known members across sessions
  const knownMembersRef = useRef<Map<string, RoomMember>>(new Map());

  // Refs for cleanup and stable callbacks
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const indexeddbRef = useRef<IndexeddbPersistence | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);

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
      },
      onDisconnect() {
        setConnectionStatus('offline');
      },
      onClose() {
        setConnectionStatus('offline');
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
      provider.destroy();
      indexeddb.destroy();
      ydoc.destroy();
    };
  }, [roomCode, activeFileId, currentUser.id, editor]);

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
    ydoc: ydocRef.current,
    provider: providerRef.current,
  };
}
