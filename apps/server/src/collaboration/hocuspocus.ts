import * as Y from 'yjs';
import {
  Server,
  type onAuthenticatePayload,
  type onLoadDocumentPayload,
  type onChangePayload,
  type onStoreDocumentPayload,
  type onConnectPayload,
  type onDisconnectPayload,
  type Hocuspocus,
} from '@hocuspocus/server';
import { parseDocumentName } from '@hostelcode/shared';
import type { FileEditLogEntry } from '@hostelcode/shared';
import { authenticateConnection, authorizeDocumentAccess } from '../auth/index.js';
import {
  getYDocUpdate,
  saveYDocUpdate,
  getRoomFile,
  getRoom,
  saveFileEditLogs,
  getFileEditLogs,
} from '../persistence/database.js';

/**
 * Deduplicates exact repeated halves or identical chunk repetitions
 * caused by concurrent initial seed merges.
 */
function deduplicateDocRepetitions(document: Y.Doc): boolean {
  try {
    const yText = document.getText('monaco');
    const str = yText.toString();
    if (str.length < 20) return false;

    // 1. Check exact string halves: str === half + half
    if (str.length % 2 === 0) {
      const half = str.length / 2;
      if (str.slice(0, half) === str.slice(half)) {
        document.transact(() => {
          yText.delete(half, half);
        }, 'deduplicate-exact-halves');
        return true;
      }
    }

    // 2. Check exact line repetitions (e.g. 2x, 3x, 4x duplicate chunks)
    const lines = str.trim().split('\n');
    for (const divisor of [4, 3, 2]) {
      if (lines.length >= divisor * 2 && lines.length % divisor === 0) {
        const chunkSize = lines.length / divisor;
        const firstChunk = lines.slice(0, chunkSize).join('\n').trim();
        let allMatch = true;
        for (let d = 1; d < divisor; d++) {
          const chunk = lines.slice(d * chunkSize, (d + 1) * chunkSize).join('\n').trim();
          if (chunk !== firstChunk) {
            allMatch = false;
            break;
          }
        }
        if (allMatch && firstChunk.length >= 10) {
          let keepLength = 0;
          for (let i = 0; i < chunkSize; i++) {
            keepLength += lines[i].length + (i < chunkSize - 1 ? 1 : 0);
          }
          if (str[keepLength] === '\n') {
            keepLength += 1;
          }
          document.transact(() => {
            yText.delete(keepLength, yText.length - keepLength);
          }, 'deduplicate-exact-chunks');
          return true;
        }
      }
    }
  } catch (err) {
    console.warn('[Hocuspocus Server] Error running deduplicateDocRepetitions:', err);
  }
  return false;
}

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

      // Check and heal any duplicate halves or repeated chunks in active file document
      if (documentName.startsWith('project:')) {
        const didDedup = deduplicateDocRepetitions(data.document);
        if (didDedup) {
          const update = Y.encodeStateAsUpdate(data.document);
          saveYDocUpdate(documentName, update);
          console.log(`[Hocuspocus Server] Deduplicated duplicate halves in: ${documentName}`);
        }

        // Sync file edit history logs from SQLite database into Y.Doc
        const docInfo = parseDocumentName(documentName);
        if (docInfo) {
          const roomCode = docInfo.projectId.trim().toUpperCase();
          const fileId = docInfo.fileId;
          const dbEdits = getFileEditLogs(roomCode, fileId);
          if (dbEdits.length > 0) {
            const editsMap = data.document.getMap<FileEditLogEntry>('file-edits-log');
            data.document.transact(() => {
              dbEdits.forEach((entry) => {
                if (!editsMap.has(entry.id)) {
                  editsMap.set(entry.id, entry);
                }
              });
            }, 'db-edits-sync');
          }
        }
      }

      return data.document;
    },

    async onChange(data: onChangePayload) {
      const { documentName, document } = data;
      if (documentName.startsWith('project:')) {
        deduplicateDocRepetitions(document);
      }
    },

    async onStoreDocument(data: onStoreDocumentPayload) {
      const { documentName, document } = data;
      if (documentName.startsWith('project:')) {
        deduplicateDocRepetitions(document);

        // Persist file edit logs to SQLite database
        const docInfo = parseDocumentName(documentName);
        if (docInfo) {
          const roomCode = docInfo.projectId.trim().toUpperCase();
          const fileId = docInfo.fileId;
          const editsMap = document.getMap<FileEditLogEntry>('file-edits-log');
          if (editsMap && editsMap.size > 0) {
            const edits = Array.from(editsMap.values()) as FileEditLogEntry[];
            saveFileEditLogs(roomCode, fileId, edits);
          }
        }
      }
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
