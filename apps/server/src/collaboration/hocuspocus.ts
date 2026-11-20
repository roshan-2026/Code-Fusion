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
import { authenticateConnection, authorizeDocumentAccess } from '../auth/index.js';
import { getYDocUpdate, saveYDocUpdate } from '../persistence/database.js';

export function createHocuspocusServer(): Hocuspocus {
  const server = Server.configure({
    async onAuthenticate(data: onAuthenticatePayload) {
      const { token, documentName } = data;
      const auth = await authenticateConnection(token, documentName);
      if (!auth.isAuthenticated || !auth.user) {
        throw new Error(auth.error || 'Unauthorized: invalid or missing authentication token');
      }

      const isAuthorized = await authorizeDocumentAccess(auth.user, documentName);
      if (!isAuthorized) {
        throw new Error(
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
