import * as Y from 'yjs';
import {
  Server,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
  type onConnectPayload,
  type onDisconnectPayload,
  type Hocuspocus,
} from '@hocuspocus/server';
import { parseDocumentName } from '@hostelcode/shared';
import { authenticateConnection, authorizeDocumentAccess } from '../auth/index.js';
import { getYDocUpdate, saveYDocUpdate, getRoomFile, getRoom } from '../persistence/database.js';

export function createHocuspocusServer(): Hocuspocus {
  const server = Server.configure({
    async onAuthenticate(data: onAuthenticatePayload) {
      const { token, documentName } = data;
      const auth = await authenticateConnection(token, documentName);
      if (!auth.isAuthenticated || !auth.user) {
        throw new Error(auth.error || 'Unauthorized: invalid or missing authentication token');
      }

      const authCheck = await authorizeDocumentAccess(auth.user, documentName);
      if (!authCheck.authorized) {
        throw new Error(
          authCheck.error ||
            `Forbidden: You must be a joined member of this room to access "${documentName}"`
        );
      }

      // Context is attached to connection
      return {
        user: auth.user,
      };
    },

    async onLoadDocument(data: onLoadDocumentPayload) {
      const { documentName } = data;
      const snapshot = getYDocUpdate(documentName);
      if (snapshot && snapshot.byteLength > 0) {
        // Restore CRDT state from database
        Y.applyUpdate(data.document, snapshot);
      } else {
        // If no CRDT state exists yet in document_updates, seed authoritatively from SQLite database
        let hasSeeded = false;

        if (documentName.startsWith('project:')) {
          const docInfo = parseDocumentName(documentName);
          if (docInfo) {
            const roomCode = docInfo.projectId.trim().toUpperCase();
            const fileId = docInfo.fileId;
            const file = getRoomFile(roomCode, fileId);
            if (file && file.content) {
              const yText = data.document.getText('monaco');
              if (yText.length === 0) {
                data.document.transact(() => {
                  yText.insert(0, file.content);
                }, 'initial-seed');
                hasSeeded = true;
              }
            }
          }
        } else if (documentName.startsWith('room:')) {
          const roomCode = documentName.slice('room:'.length).trim().toUpperCase();
          const room = getRoom(roomCode);
          if (room && room.files && room.files.length > 0) {
            const yFilesMap = data.document.getMap('files');
            if (yFilesMap.size === 0) {
              room.files.forEach((file) => {
                yFilesMap.set(file.id, file);
              });
              hasSeeded = true;
            }
          }
        }

        // Immediately persist seeded initial state so all connecting peers see the exact same base
        if (hasSeeded) {
          const update = Y.encodeStateAsUpdate(data.document);
          saveYDocUpdate(documentName, update);
          console.log(`[Hocuspocus Server] Seeded initial content for document: ${documentName}`);
        }
      }
      return data.document;
    },

    async onStoreDocument(data: onStoreDocumentPayload) {
      const { documentName, document } = data;
      // Persist binary Yjs CRDT update to SQLite database
      const update = Y.encodeStateAsUpdate(document);
      saveYDocUpdate(documentName, update);
    },

    async onConnect(data: onConnectPayload) {
      console.log(`[Hocuspocus CRDT] User connected: ${data.documentName}`);
    },

    async onDisconnect(data: onDisconnectPayload) {
      console.log(`[Hocuspocus CRDT] User disconnected: ${data.documentName}`);
    },
  });

  return server;
}
