import type { Room, ProjectFile, AuthUser } from '@hostelcode/shared';
import { config } from './config';

const CACHE_PREFIX = 'hostelcode_cached_room_';
const RECENT_ROOMS_KEY = 'hostelcode_recent_rooms';

/**
 * Saves a room object to the browser's localStorage for instant offline access
 */
export function saveRoomLocally(room: Room): void {
  try {
    const key = `${CACHE_PREFIX}${room.code.toUpperCase()}`;
    localStorage.setItem(key, JSON.stringify(room));

    // Update recent rooms index
    const recent = getRecentRooms();
    const updatedRecent = [
      room,
      ...recent.filter((r) => r.code.toUpperCase() !== room.code.toUpperCase()),
    ].slice(0, 8); // Keep last 8 rooms

    localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(updatedRecent));
  } catch (err) {
    console.warn('[RoomStorage] Failed to save room to localStorage:', err);
  }
}

/**
 * Retrieves a room from the browser's localStorage
 */
export function getLocalRoom(code: string): Room | null {
  try {
    const key = `${CACHE_PREFIX}${code.trim().toUpperCase()}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[RoomStorage] Failed to read room from localStorage:', err);
    return null;
  }
}

/**
 * Retrieves all recently opened rooms from localStorage
 */
export function getRecentRooms(): Room[] {
  try {
    const raw = localStorage.getItem(RECENT_ROOMS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Registers user as a joined member of a room on the server database
 */
export async function joinRoomOnServer(roomCode: string, user: AuthUser): Promise<Room | null> {
  const cleanCode = roomCode.trim().toUpperCase();
  try {
    const res = await fetch(`${config.serverHttpUrl}/api/rooms/${cleanCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: user.id,
        name: user.name,
        email: user.email,
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.room) {
        saveRoomLocally(data.room);
        return data.room;
      }
    }
  } catch (err) {
    console.warn('[RoomStorage] Server unreachable; continuing in local offline mode:', err);
  }
  return null;
}

/**
 * Synchronizes room metadata to the server database
 */
export async function syncRoomToServer(room: Room, user?: AuthUser): Promise<boolean> {
  saveRoomLocally(room);

  try {
    const res = await fetch(`${config.serverHttpUrl}/api/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { 'x-user-id': user.id } : {}),
      },
      body: JSON.stringify(room),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[RoomStorage] Server sync unavailable (operating offline):', err);
    return false;
  }
}

/**
 * Fetches room contents. Enforces user authentication and authorization.
 */
export async function fetchRoomWithCache(code: string, user: AuthUser): Promise<Room | null> {
  const cleanCode = code.trim().toUpperCase();

  try {
    // Attempt to join / authenticate membership on server first
    await joinRoomOnServer(cleanCode, user);

    const res = await fetch(`${config.serverHttpUrl}/api/rooms/${cleanCode}`, {
      headers: { 'x-user-id': user.id },
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      const serverRoom: Room = await res.json();
      saveRoomLocally(serverRoom);
      return serverRoom;
    }

    if (res.status === 404) {
      // Room does NOT exist on server! Clean up any stale local cache
      try {
        localStorage.removeItem(`${CACHE_PREFIX}${cleanCode}`);
      } catch {}
      return null;
    }
  } catch (err) {
    console.warn('[RoomStorage] Server unreachable; checking local offline storage:', err);
    // Only fall back to local room if server is actually completely unreachable (offline)
    const cached = getLocalRoom(cleanCode);
    if (cached) return cached;
  }

  return null;
}

/**
 * Checks if a room exists on the server without creating a fallback
 */
export async function checkRoomExists(code: string, user: AuthUser): Promise<Room | null> {
  const cleanCode = code.trim().toUpperCase();
  try {
    const res = await fetch(`${config.serverHttpUrl}/api/rooms/${cleanCode}`, {
      headers: { 'x-user-id': user.id },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const room: Room = await res.json();
      saveRoomLocally(room);
      return room;
    }
  } catch (err) {
    console.warn('[RoomStorage] Server unreachable, checking local cache:', err);
    const cached = getLocalRoom(cleanCode);
    if (cached) return cached;
  }
  return null;
}

/**
 * Retrieves all active rooms created by the user from server and cache
 */
export async function fetchUserCreatedRooms(user: AuthUser): Promise<Room[]> {
  try {
    const res = await fetch(`${config.serverHttpUrl}/api/users/${encodeURIComponent(user.id)}/rooms`, {
      headers: { 'x-user-id': user.id },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.rooms)) {
        data.rooms.forEach((r: Room) => saveRoomLocally(r));
        return data.rooms;
      }
    }
  } catch (err) {
    console.warn('[RoomStorage] Failed to fetch user rooms from server, using local fallback:', err);
  }

  return getRecentRooms().filter((r) => r.creatorId === user.id);
}

/**
 * Permanently deletes a room on the server (Admin only)
 */
export async function deleteRoomOnServer(roomCode: string, user: AuthUser): Promise<boolean> {
  const cleanCode = roomCode.trim().toUpperCase();
  try {
    localStorage.removeItem(`${CACHE_PREFIX}${cleanCode}`);
    const recent = getRecentRooms().filter((r) => r.code.toUpperCase() !== cleanCode);
    localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(recent));
  } catch {}

  try {
    const res = await fetch(`${config.serverHttpUrl}/api/rooms/${cleanCode}`, {
      method: 'DELETE',
      headers: { 'x-user-id': user.id },
    });
    return res.ok;
  } catch (err) {
    console.warn('[RoomStorage] Failed to delete room on server:', err);
    return false;
  }
}

/**
 * Updates files of a room locally and syncs to server database
 */
export function updateRoomFilesLocally(roomCode: string, files: ProjectFile[], user?: AuthUser): void {
  const cleanCode = roomCode.toUpperCase();
  const room = getLocalRoom(cleanCode);
  if (room) {
    const existingMap = new Map((room.files || []).map((f) => [f.id, f]));
    for (const f of files) {
      existingMap.set(f.id, f);
    }
    room.files = Array.from(existingMap.values());
    room.updatedAt = new Date().toISOString();
    saveRoomLocally(room);
  }

  // Asynchronously sync files to server database
  if (user) {
    fetch(`${config.serverHttpUrl}/api/rooms/${cleanCode}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': user.id,
      },
      body: JSON.stringify(files),
    }).catch(() => {
      // Offline fallback: files are already safe in IndexedDB and LocalStorage
    });
  }
}

/**
 * Moves a file to the Recycle Bin on the server
 */
export async function recycleFileOnServer(
  roomCode: string,
  fileId: string,
  user: AuthUser
): Promise<boolean> {
  const cleanCode = roomCode.toUpperCase();
  try {
    const res = await fetch(
      `${config.serverHttpUrl}/api/rooms/${cleanCode}/files/${encodeURIComponent(fileId)}/recycle`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user.id,
        },
        body: JSON.stringify({ userName: user.name }),
      }
    );
    return res.ok;
  } catch (err) {
    console.warn('[RoomStorage] Failed to recycle file on server (offline):', err);
    return false;
  }
}

/**
 * Restores a file from the Recycle Bin on the server
 */
export async function restoreFileOnServer(
  roomCode: string,
  fileId: string,
  user: AuthUser
): Promise<boolean> {
  const cleanCode = roomCode.toUpperCase();
  try {
    const res = await fetch(
      `${config.serverHttpUrl}/api/rooms/${cleanCode}/files/${encodeURIComponent(fileId)}/restore`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user.id,
        },
      }
    );
    return res.ok;
  } catch (err) {
    console.warn('[RoomStorage] Failed to restore file on server (offline):', err);
    return false;
  }
}

/**
 * Records a user's vote for permanent deletion of a recycled file
 */
export async function votePermanentDeleteOnServer(
  roomCode: string,
  fileId: string,
  user: AuthUser
): Promise<{ permanentlyDeleted: boolean; votes: string[]; totalMembers: number } | null> {
  const cleanCode = roomCode.toUpperCase();
  try {
    const res = await fetch(
      `${config.serverHttpUrl}/api/rooms/${cleanCode}/files/${encodeURIComponent(fileId)}/delete-vote`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user.id,
        },
      }
    );
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('[RoomStorage] Failed to cast delete vote on server (offline):', err);
  }
  return null;
}
