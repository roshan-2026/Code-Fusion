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
    is_recycled INTEGER DEFAULT 0,
    recycled_by TEXT,
    recycled_at TEXT,
    delete_votes TEXT DEFAULT '[]',
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

// Safe migrations for Recycle Bin columns
try {
  db.exec(`ALTER TABLE room_files ADD COLUMN is_recycled INTEGER DEFAULT 0;`);
} catch {}
try {
  db.exec(`ALTER TABLE room_files ADD COLUMN recycled_by TEXT;`);
} catch {}
try {
  db.exec(`ALTER TABLE room_files ADD COLUMN recycled_at TEXT;`);
} catch {}
try {
  db.exec(`ALTER TABLE room_files ADD COLUMN delete_votes TEXT DEFAULT '[]';`);
} catch {}

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
    SELECT id, room_code as projectId, name, path, language, content,
           is_recycled as isRecycled, recycled_by as recycledBy,
           recycled_at as recycledAt, delete_votes as deleteVotes,
           created_at as createdAt, updated_at as updatedAt
    FROM room_files
    WHERE room_code = ?
    ORDER BY created_at ASC
  `);

  const rawRows = filesStmt.all(cleanCode) as any[];
  const fileRows: ProjectFile[] = rawRows.map((r) => {
    let votes: string[] = [];
    try {
      votes = typeof r.deleteVotes === 'string' ? JSON.parse(r.deleteVotes) : r.deleteVotes || [];
    } catch {
      votes = [];
    }
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      path: r.path,
      language: r.language,
      content: r.content,
      isRecycled: Boolean(r.isRecycled),
      recycledBy: r.recycledBy || undefined,
      recycledAt: r.recycledAt || undefined,
      deleteVotes: votes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

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
 * Permanently deletes a room and all its members, files, and CRDT history (Admin only)
 */
export function deleteRoom(roomCode: string, userId: string): boolean {
  const cleanCode = roomCode.toUpperCase();
  const room = getRoom(cleanCode);
  if (!room) return false;

  if (room.creatorId !== userId) {
    throw new Error('Unauthorized: Only the room creator (admin) can delete this room');
  }

  // Delete from rooms table (cascades to room_members and room_files via foreign keys)
  const stmt = db.prepare(`DELETE FROM rooms WHERE code = ?`);
  stmt.run(cleanCode);

  // Delete Yjs CRDT document binary updates for this room
  const docStmt = db.prepare(`DELETE FROM document_updates WHERE doc_name LIKE ?`);
  docStmt.run(`%${cleanCode}%`);

  console.log(`[Database] Room ${cleanCode} permanently deleted by admin ${userId}`);
  return true;
}

/**
 * Retrieves all active rooms created by a specific user
 */
export function getRoomsByCreator(creatorId: string): Room[] {
  const stmt = db.prepare(`
    SELECT code, name, creator_id as creatorId, creator_name as creatorName,
           creator_email as creatorEmail, created_at as createdAt, updated_at as updatedAt
    FROM rooms
    WHERE creator_id = ?
    ORDER BY updated_at DESC
  `);

  const rows = stmt.all(creatorId) as any[];
  return rows.map((r) => {
    const fullRoom = getRoom(r.code);
    return (
      fullRoom || {
        code: r.code,
        name: r.name,
        creatorId: r.creatorId,
        creatorName: r.creatorName,
        creatorEmail: r.creatorEmail,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        files: [],
      }
    );
  });
}

/**
 * Saves or updates files for a room
 */
export function saveRoomFiles(roomCode: string, files: ProjectFile[]): void {
  const cleanCode = roomCode.toUpperCase();
  const insertStmt = db.prepare(`
    INSERT INTO room_files (id, room_code, name, path, language, content, is_recycled, recycled_by, recycled_at, delete_votes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      language = excluded.language,
      content = excluded.content,
      is_recycled = excluded.is_recycled,
      recycled_by = excluded.recycled_by,
      recycled_at = excluded.recycled_at,
      delete_votes = excluded.delete_votes,
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
      f.isRecycled ? 1 : 0,
      f.recycledBy || null,
      f.recycledAt || null,
      JSON.stringify(f.deleteVotes || []),
      f.createdAt || new Date().toISOString(),
      f.updatedAt || new Date().toISOString()
    );
  }
}

/**
 * Moves a file to the Recycle Bin
 */
export function recycleRoomFile(
  roomCode: string,
  fileId: string,
  userId: string,
  userName: string
): void {
  const stmt = db.prepare(`
    UPDATE room_files
    SET is_recycled = 1,
        recycled_by = ?,
        recycled_at = ?,
        delete_votes = ?,
        updated_at = ?
    WHERE room_code = ? AND id = ?
  `);
  stmt.run(
    userName,
    new Date().toISOString(),
    JSON.stringify([userId]),
    new Date().toISOString(),
    roomCode.toUpperCase(),
    fileId
  );
}

/**
 * Restores a file from the Recycle Bin back to active project files
 */
export function restoreRoomFile(roomCode: string, fileId: string): void {
  const stmt = db.prepare(`
    UPDATE room_files
    SET is_recycled = 0,
        recycled_by = NULL,
        recycled_at = NULL,
        delete_votes = '[]',
        updated_at = ?
    WHERE room_code = ? AND id = ?
  `);
  stmt.run(new Date().toISOString(), roomCode.toUpperCase(), fileId);
}

/**
 * Permanently deletes a file and its updates from database
 */
export function deleteRoomFile(roomCode: string, fileId: string): void {
  const cleanCode = roomCode.toUpperCase();
  const delStmt = db.prepare(`
    DELETE FROM room_files
    WHERE room_code = ? AND id = ?
  `);
  delStmt.run(cleanCode, fileId);

  const docName = `project:${cleanCode}:file:${fileId}`;
  const delDocStmt = db.prepare(`
    DELETE FROM document_updates
    WHERE doc_name = ?
  `);
  delDocStmt.run(docName);
}

/**
 * Records a user's vote to delete a recycled file permanently.
 * If ALL joined room members have voted, the file is permanently deleted from SQLite database!
 */
export function votePermanentDeleteFile(
  roomCode: string,
  fileId: string,
  userId: string
): { permanentlyDeleted: boolean; votes: string[]; totalMembers: number } {
  const cleanCode = roomCode.toUpperCase();
  const fileStmt = db.prepare(`
    SELECT delete_votes FROM room_files
    WHERE room_code = ? AND id = ?
  `);
  const fileRow = fileStmt.get(cleanCode, fileId) as any;
  if (!fileRow) {
    return { permanentlyDeleted: true, votes: [], totalMembers: 0 };
  }

  let votes: string[] = [];
  try {
    votes = JSON.parse(fileRow.delete_votes || '[]');
  } catch {
    votes = [];
  }

  if (!votes.includes(userId)) {
    votes.push(userId);
  }

  // Count total joined room members
  const memberCountStmt = db.prepare(`
    SELECT COUNT(*) as count FROM room_members
    WHERE room_code = ?
  `);
  const memberCountRow = memberCountStmt.get(cleanCode) as any;
  const totalMembers = memberCountRow ? memberCountRow.count : 1;

  // If EACH user in the room has marked/voted to permanently delete:
  if (votes.length >= totalMembers) {
    // Delete file from database permanently!
    const delStmt = db.prepare(`
      DELETE FROM room_files
      WHERE room_code = ? AND id = ?
    `);
    delStmt.run(cleanCode, fileId);

    // Also remove any Yjs document snapshot
    const docName = `project:${cleanCode}:file:${fileId}`;
    const delDocStmt = db.prepare(`
      DELETE FROM document_updates
      WHERE doc_name = ?
    `);
    delDocStmt.run(docName);

    console.log(
      `[Database Security] File ${fileId} in room ${cleanCode} permanently deleted by consensus of all ${totalMembers} members.`
    );
    return { permanentlyDeleted: true, votes, totalMembers };
  }

  // Otherwise, update votes array in database
  const updateStmt = db.prepare(`
    UPDATE room_files
    SET delete_votes = ?, updated_at = ?
    WHERE room_code = ? AND id = ?
  `);
  updateStmt.run(JSON.stringify(votes), new Date().toISOString(), cleanCode, fileId);

  return { permanentlyDeleted: false, votes, totalMembers };
}

/**
 * Clears all rooms, members, files, and CRDT document updates from SQLite database
 */
export function clearDatabase(): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM document_updates;
    DELETE FROM room_files;
    DELETE FROM room_members;
    DELETE FROM rooms;
    PRAGMA foreign_keys = ON;
    VACUUM;
  `);
  console.log('[HostelCode Database] All rooms, members, files, and CRDT document updates cleared successfully.');
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
