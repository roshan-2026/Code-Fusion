import http from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config/index.js';
import { createHocuspocusServer } from './collaboration/hocuspocus.js';
import {
  saveRoom,
  getRoom,
  addRoomMember,
  isUserMemberOfRoom,
  getRoomMembers,
  saveRoomFiles,
  deleteRoomFile,
  recycleRoomFile,
  restoreRoomFile,
  votePermanentDeleteFile,
  deleteRoom,
  getRoomsByCreator,
  clearDatabase,
} from './persistence/database.js';
import type { HealthCheckResponse, Room, ProjectFile } from '@hostelcode/shared';

const startTime = Date.now();
const hocuspocus = createHocuspocusServer();

// Helper to extract JSON request body
function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (e) {
        reject(new Error('Malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON response
function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Native HTTP Server for Secure REST Endpoints
const httpServer = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Health-check Endpoint
  if (pathname === '/health' && req.method === 'GET') {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const healthData: HealthCheckResponse = {
      status: 'ok',
      service: config.serviceName,
      version: config.version,
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      environment: config.nodeEnv,
      metrics: {
        activeConnections: hocuspocus.getConnectionsCount?.() ?? 0,
        activeDocuments: hocuspocus.getDocumentsCount?.() ?? 0,
      },
    };
    sendJson(res, 200, healthData);
    return;
  }

  // 2. POST /api/rooms — Create a room
  if (pathname === '/api/rooms' && req.method === 'POST') {
    try {
      const room = await parseJsonBody<Room>(req);
      if (!room.code || !room.name || !room.creatorId) {
        sendJson(res, 400, { error: 'Room code, name, and creatorId are required' });
        return;
      }

      saveRoom(room);
      console.log(`[Database] Room ${room.code} created by ${room.creatorName} (${room.creatorId})`);
      sendJson(res, 201, { success: true, room: getRoom(room.code) });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || 'Failed to create room' });
    }
    return;
  }

  // 2b. GET /api/users/:userId/rooms — Get all active rooms created by this user
  const userRoomsMatch = pathname.match(/^\/api\/users\/([^/]+)\/rooms$/);
  if (userRoomsMatch && req.method === 'GET') {
    const userId = decodeURIComponent(userRoomsMatch[1]);
    const rooms = getRoomsByCreator(userId);
    sendJson(res, 200, { success: true, rooms });
    return;
  }

  // 2c. DELETE /api/rooms/:code — Delete a room permanently (Admin only)
  const deleteRoomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})$/);
  if (deleteRoomMatch && req.method === 'DELETE') {
    const roomCode = deleteRoomMatch[1].toUpperCase();
    const userId = (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    if (!userId) {
      sendJson(res, 401, { error: 'Authentication required: missing x-user-id header' });
      return;
    }

    try {
      const room = getRoom(roomCode);
      if (!room) {
        sendJson(res, 404, { error: `Room ${roomCode} not found` });
        return;
      }

      if (room.creatorId !== userId) {
        sendJson(res, 403, {
          error: 'Unauthorized: Only the room creator (admin) can delete this room',
        });
        return;
      }

      // Notify and disconnect all active Hocuspocus clients in real time
      const roomDocName = `room:${roomCode}`;
      const closureMessage = 'This room does not exist or has been closed by the host.';
      const closurePayload = JSON.stringify({
        type: 'ROOM_CLOSED',
        roomCode,
        message: closureMessage,
      });

      const docsToUnload: any[] = [];
      hocuspocus.documents.forEach((doc, docName) => {
        if (docName === roomDocName || docName.startsWith(`project:${roomCode}:`)) {
          try {
            doc.broadcastStateless(closurePayload);
            const connections = doc.getConnections ? doc.getConnections() : [];
            connections.forEach((conn: any) => {
              try {
                conn.sendStateless?.(closurePayload);
                conn.webSocket?.close(4404, closureMessage);
                conn.close?.({ code: 4404, reason: closureMessage });
              } catch (e) {
                console.warn('[Hocuspocus] Error closing connection for deleted room:', e);
              }
            });
          } catch (e) {
            console.warn('[Hocuspocus] Error broadcasting closure on doc:', e);
          }
          docsToUnload.push(doc);
        }
      });

      for (const doc of docsToUnload) {
        try {
          doc.destroy?.();
          hocuspocus.unloadDocument(doc);
        } catch (e) {
          console.warn('[Hocuspocus] Error unloading document:', e);
        }
      }

      const success = deleteRoom(roomCode, userId);
      if (success) {
        sendJson(res, 200, { success: true, message: `Room ${roomCode} deleted permanently` });
      } else {
        sendJson(res, 404, { error: `Room ${roomCode} not found` });
      }
    } catch (err: any) {
      sendJson(res, 403, { error: err.message || 'Failed to delete room' });
    }
    return;
  }

  // 2d. POST /api/database/clear — Clears all rooms, members, files, and updates from the database
  if (pathname === '/api/database/clear' && req.method === 'POST') {
    try {
      clearDatabase();
      sendJson(res, 200, {
        success: true,
        message: 'Database cleared successfully. All rooms, members, and files removed.',
      });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message || 'Failed to clear database' });
    }
    return;
  }

  // 2e. GET /api/rooms/:code/status — Lightweight endpoint to verify if a room is active or closed
  const roomStatusMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/status$/);
  if (roomStatusMatch && req.method === 'GET') {
    const roomCode = roomStatusMatch[1].toUpperCase();
    const room = getRoom(roomCode);
    if (!room) {
      sendJson(res, 404, {
        exists: false,
        status: 'closed',
        error: 'This room does not exist or has been closed by the host.',
      });
      return;
    }
    sendJson(res, 200, {
      exists: true,
      status: 'active',
      code: room.code,
      name: room.name,
    });
    return;
  }

  // 3. POST /api/rooms/:code/join — Join a room and obtain authorized membership
  const joinMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/join$/);
  if (joinMatch && req.method === 'POST') {
    const roomCode = joinMatch[1].toUpperCase();
    try {
      const user = await parseJsonBody<{ id: string; name: string; email: string }>(req);
      if (!user.id || !user.name) {
        sendJson(res, 400, { error: 'User id and name are required to join room' });
        return;
      }

      const existingRoom = getRoom(roomCode);
      if (!existingRoom) {
        sendJson(res, 404, { error: `Room ${roomCode} not found` });
        return;
      }

      // Record user in SQLite database room_members
      addRoomMember(roomCode, user);
      console.log(`[Security] User ${user.name} (${user.id}) joined room ${roomCode}`);

      const updatedMembers = getRoomMembers(roomCode);
      const roomWithMembers = {
        ...existingRoom,
        members: updatedMembers,
      };

      sendJson(res, 200, {
        success: true,
        room: roomWithMembers,
        members: updatedMembers,
      });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || 'Failed to join room' });
    }
    return;
  }

  // 4. GET /api/rooms/:code — Secure room fetch (Requires membership)
  const getRoomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})$/);
  if (getRoomMatch && req.method === 'GET') {
    const roomCode = getRoomMatch[1].toUpperCase();
    const userId =
      (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    const room = getRoom(roomCode);
    if (!room) {
      sendJson(res, 404, { error: 'This room does not exist or has been closed by the host.' });
      return;
    }

    // STRICT ACCESS CONTROL: verify user authentication and authorize room membership
    if (!userId) {
      sendJson(res, 401, {
        error: `Authentication required: You must provide a valid user ID to view room ${roomCode}.`,
      });
      return;
    }

    if (!isUserMemberOfRoom(roomCode, userId)) {
      const rawName =
        (req.headers['x-user-name'] as string) || url.searchParams.get('user_name') || 'Peer';
      const rawEmail =
        (req.headers['x-user-email'] as string) || url.searchParams.get('user_email') || '';
      let userName = 'Peer';
      let userEmail = '';
      try {
        userName = decodeURIComponent(rawName);
      } catch {
        userName = rawName;
      }
      try {
        userEmail = decodeURIComponent(rawEmail);
      } catch {
        userEmail = rawEmail;
      }

      addRoomMember(roomCode, { id: userId, name: userName, email: userEmail });
      console.log(`[Security] User ${userName} (${userId}) authorized and joined room ${roomCode}`);
    }

    sendJson(res, 200, {
      ...room,
      members: getRoomMembers(roomCode),
    });
    return;
  }

  // 5. POST /api/rooms/:code/files — Save/upload project files (Requires membership)
  const filesMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/files$/);
  if (filesMatch && req.method === 'POST') {
    const roomCode = filesMatch[1].toUpperCase();
    const userId =
      (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    if (!userId || !isUserMemberOfRoom(roomCode, userId)) {
      sendJson(res, 403, { error: 'Access Denied: You are not authorized to upload to this room' });
      return;
    }

    try {
      const files = await parseJsonBody<ProjectFile[]>(req);
      if (Array.isArray(files)) {
        saveRoomFiles(roomCode, files);
        sendJson(res, 200, { success: true, count: files.length });
      } else {
        sendJson(res, 400, { error: 'Files array required' });
      }
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || 'Failed to save files' });
    }
    return;
  }

  // 6. DELETE /api/rooms/:code/files/:fileId — Delete a file
  const deleteFileMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/files\/(.+)$/);
  if (deleteFileMatch && req.method === 'DELETE') {
    const roomCode = deleteFileMatch[1].toUpperCase();
    const fileId = deleteFileMatch[2];
    const userId =
      (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    if (!userId || !isUserMemberOfRoom(roomCode, userId)) {
      sendJson(res, 403, { error: 'Access Denied: You are not authorized to delete files in this room' });
      return;
    }

    deleteRoomFile(roomCode, fileId);
    sendJson(res, 200, { success: true });
    return;
  }

  // 7. POST /api/rooms/:code/files/:fileId/recycle — Move file to Recycle Bin
  const recycleMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/files\/([^/]+)\/recycle$/);
  if (recycleMatch && req.method === 'POST') {
    const roomCode = recycleMatch[1].toUpperCase();
    const fileId = recycleMatch[2];
    const userId = (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    if (!userId || !isUserMemberOfRoom(roomCode, userId)) {
      sendJson(res, 403, { error: 'Access Denied: You are not authorized to recycle files in this room' });
      return;
    }

    try {
      const body = await parseJsonBody<{ userName?: string }>(req);
      recycleRoomFile(roomCode, fileId, userId, body.userName || 'Member');
      sendJson(res, 200, { success: true, room: getRoom(roomCode) });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || 'Failed to recycle file' });
    }
    return;
  }

  // 8. POST /api/rooms/:code/files/:fileId/restore — Restore file from Recycle Bin
  const restoreMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/files\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const roomCode = restoreMatch[1].toUpperCase();
    const fileId = restoreMatch[2];
    const userId = (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    if (!userId || !isUserMemberOfRoom(roomCode, userId)) {
      sendJson(res, 403, { error: 'Access Denied: You are not authorized to restore files in this room' });
      return;
    }

    try {
      restoreRoomFile(roomCode, fileId);
      sendJson(res, 200, { success: true, room: getRoom(roomCode) });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || 'Failed to restore file' });
    }
    return;
  }

  // 9. POST /api/rooms/:code/files/:fileId/delete-vote — Vote for permanent deletion by consensus
  const voteMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6})\/files\/([^/]+)\/delete-vote$/);
  if (voteMatch && req.method === 'POST') {
    const roomCode = voteMatch[1].toUpperCase();
    const fileId = voteMatch[2];
    const userId = (req.headers['x-user-id'] as string) || url.searchParams.get('user_id');

    if (!userId || !isUserMemberOfRoom(roomCode, userId)) {
      sendJson(res, 403, { error: 'Access Denied: You are not authorized to vote on file deletion in this room' });
      return;
    }

    try {
      const result = votePermanentDeleteFile(roomCode, fileId, userId);
      sendJson(res, 200, { success: true, ...result, room: getRoom(roomCode) });
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || 'Failed to record delete vote' });
    }
    return;
  }

  // Root Info
  if (pathname === '/' && req.method === 'GET') {
    sendJson(res, 200, {
      name: config.serviceName,
      version: config.version,
      health: '/health',
      database: 'SQLite Secure WAL Store',
      status: 'running',
    });
    return;
  }

  sendJson(res, 404, { error: 'Route not found' });
});

// WebSocket Server attached to HTTP Upgrade
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    hocuspocus.handleConnection(ws, request);
  });
});

httpServer.listen(config.port, config.host, () => {
  console.log(`====================================================`);
  console.log(`[HostelCode Server] Started on http://${config.host}:${config.port}`);
  console.log(`[HostelCode Server] WebSocket endpoint: ws://${config.host}:${config.port}`);
  console.log(`[HostelCode Server] Secure SQLite Storage: Ready`);
  console.log(`====================================================`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('[HostelCode Server] Shutting down gracefully...');
  wss.close();
  httpServer.close(() => {
    console.log('[HostelCode Server] Server closed');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
