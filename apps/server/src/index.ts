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

      sendJson(res, 200, {
        success: true,
        room: existingRoom,
        members: getRoomMembers(roomCode),
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
      sendJson(res, 404, { error: `Room ${roomCode} does not exist` });
      return;
    }

    // STRICT ACCESS CONTROL: verify user has joined room
    if (!userId || !isUserMemberOfRoom(roomCode, userId)) {
      sendJson(res, 403, {
        error: `Access Denied: You must join room ${roomCode} to view its files and contents.`,
      });
      return;
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
