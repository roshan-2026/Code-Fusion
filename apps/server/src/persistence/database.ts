import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { Room, ProjectFile } from '@hostelcode/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'hostelcode.db');
const db = new DatabaseSync(dbPath);

// Initialize database schema
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Rooms table
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    creator_name TEXT NOT NULL,
    creator_email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Room joined members (Strict Access Control)
  CREATE TABLE IF NOT EXISTS room_members (
    room_code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    user_email TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_code, user_id),
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  );

  -- Secure project files inside room
  CREATE TABLE IF NOT EXISTS room_files (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
  );

  -- Yjs CRDT binary updates & snapshots
  CREATE TABLE IF NOT EXISTS document_updates (
    doc_name TEXT PRIMARY KEY,
    update_blob BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

console.log(`[HostelCode Database] SQLite initialized securely at: ${dbPath}`);

/**
 * Creates or updates a room
 */
export function saveRoom(room: Room): void {
  const stmt = db.prepare(`
    INSERT INTO rooms (code, name, creator_id, creator_name, creator_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    room.code.toUpperCase(),
    room.name,
    room.creatorId,
    room.creatorName,
    room.creatorEmail,
    room.createdAt,
    room.updatedAt
  );

  // Automatically register creator as first room member
  addRoomMember(room.code, {
    id: room.creatorId,
    name: room.creatorName,
    email: room.creatorEmail,
  });

  // Save initial files if any
  if (room.files && room.files.length > 0) {
    saveRoomFiles(room.code, room.files);
  }
}

/**
 * Adds a user to a room's authorized members list
 */
export function addRoomMember(
  roomCode: string,
  user: { id: string; name: string; email: string }
): void {
  const stmt = db.prepare(`
    INSERT INTO room_members (room_code, user_id, user_name, user_email, joined_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(room_code, user_id) DO UPDATE SET
      user_name = excluded.user_name,
      user_email = excluded.user_email
  `);

  stmt.run(
    roomCode.toUpperCase(),
    user.id,
    user.name,
    user.email,
    new Date().toISOString()
  );
}

/**
 * Checks if a user is an authorized joined member of a room
 */
export function isUserMemberOfRoom(roomCode: string, userId: string): boolean {
  if (!roomCode || !userId) return false;
  const stmt = db.prepare(`
    SELECT 1 FROM room_members
    WHERE room_code = ? AND user_id = ?
    LIMIT 1
  `);

  const row = stmt.get(roomCode.toUpperCase(), userId);
  return Boolean(row);
}

/**
 * Retrieves all authorized members for a room
 */
export function getRoomMembers(
  roomCode: string
): { id: string; name: string; email: string; joinedAt: string }[] {
  const stmt = db.prepare(`
    SELECT user_id as id, user_name as name, user_email as email, joined_at as joinedAt
    FROM room_members
    WHERE room_code = ?
    ORDER BY joined_at ASC
  `);

  const rows = stmt.all(roomCode.toUpperCase()) as any[];
  return rows || [];
}

/**
 * Retrieves a room and its files
 */
export function getRoom(roomCode: string): Room | null {
  const cleanCode = roomCode.toUpperCase();
  const roomStmt = db.prepare(`
    SELECT code, name, creator_id, creator_name, creator_email, created_at, updated_at
    FROM rooms
    WHERE code = ?
  `);

  const roomRow = roomStmt.get(cleanCode) as any;
  if (!roomRow) return null;

  const filesStmt = db.prepare(`
    SELECT id, room_code as projectId, name, path, language, content, created_at as createdAt, updated_at as updatedAt
    FROM room_files
    WHERE room_code = ?
    ORDER BY created_at ASC
  `);

  const fileRows = filesStmt.all(cleanCode) as unknown as ProjectFile[];

  return {
    code: roomRow.code,
    name: roomRow.name,
    creatorId: roomRow.creator_id,
    creatorName: roomRow.creator_name,
    creatorEmail: roomRow.creator_email,
    createdAt: roomRow.created_at,
    updatedAt: roomRow.updated_at,
    files: fileRows || [],
  };
}

/**
 * Saves or updates files for a room
 */
export function saveRoomFiles(roomCode: string, files: ProjectFile[]): void {
  const cleanCode = roomCode.toUpperCase();
  const insertStmt = db.prepare(`
    INSERT INTO room_files (id, room_code, name, path, language, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      language = excluded.language,
      content = excluded.content,
      updated_at = excluded.updated_at
  `);

  for (const f of files) {
    insertStmt.run(
      f.id,
      cleanCode,
      f.name,
      f.path,
      f.language,
      f.content || '',
      f.createdAt || new Date().toISOString(),
      f.updatedAt || new Date().toISOString()
    );
  }
}

/**
 * Deletes a file from a room
 */
export function deleteRoomFile(roomCode: string, fileId: string): void {
  const stmt = db.prepare(`
    DELETE FROM room_files
    WHERE room_code = ? AND id = ?
  `);
  stmt.run(roomCode.toUpperCase(), fileId);
}

/**
 * Saves binary Yjs document snapshot
 */
export function saveYDocUpdate(docName: string, update: Uint8Array): void {
  const stmt = db.prepare(`
    INSERT INTO document_updates (doc_name, update_blob, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(doc_name) DO UPDATE SET
      update_blob = excluded.update_blob,
      updated_at = excluded.updated_at
  `);
  stmt.run(docName, Buffer.from(update), new Date().toISOString());
}

/**
 * Loads binary Yjs document snapshot
 */
export function getYDocUpdate(docName: string): Uint8Array | null {
  const stmt = db.prepare(`
    SELECT update_blob FROM document_updates
    WHERE doc_name = ?
  `);
  const row = stmt.get(docName) as any;
  if (!row || !row.update_blob) return null;
  return new Uint8Array(row.update_blob);
}
