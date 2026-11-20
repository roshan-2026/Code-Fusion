import { parseDocumentName } from '@hostelcode/shared';
import { isUserMemberOfRoom, getRoom, addRoomMember } from '../persistence/database.js';

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  role?: string;
}

export interface AuthResult {
  isAuthenticated: boolean;
  user?: AuthUser;
  error?: string;
}

/**
 * Authenticates a connection request based on provided client token
 */
export async function authenticateConnection(
  token: string | undefined,
  _documentName: string
): Promise<AuthResult> {
  if (!token) {
    return {
      isAuthenticated: false,
      error: 'Authentication required: missing token',
    };
  }

  try {
    const parsed = JSON.parse(token);
    if (parsed.id && parsed.name) {
      return {
        isAuthenticated: true,
        user: {
          id: parsed.id,
          name: parsed.name,
          email: parsed.email,
          role: 'editor',
        },
      };
    }
  } catch {
    // If token is a plain user string ID
    return {
      isAuthenticated: true,
      user: {
        id: token,
        name: token,
        role: 'editor',
      },
    };
  }

  return {
    isAuthenticated: false,
    error: 'Invalid authentication token',
  };
}

/**
 * Verifies if user has permission to access the project/document.
 * Supports both room-level documents (room:ROOMCODE) and file-level documents (project:ROOMCODE:file:FILEID).
 * Enforces room validation against SQLite database.
 */
export async function authorizeDocumentAccess(
  user: AuthUser,
  documentName: string
): Promise<boolean> {
  let roomCode: string | null = null;

  if (documentName.startsWith('room:')) {
    roomCode = documentName.slice('room:'.length).trim().toUpperCase();
  } else if (documentName.startsWith('project:')) {
    const docInfo = parseDocumentName(documentName);
    roomCode = docInfo ? docInfo.projectId.trim().toUpperCase() : null;
  }

  if (!roomCode) {
    console.warn(`[Auth Security] Invalid document identifier format: "${documentName}"`);
    return false;
  }

  // 1. Check existing room membership
  let isMember = isUserMemberOfRoom(roomCode, user.id);
  if (isMember) {
    return true;
  }

  // 2. If not registered yet, verify the room actually exists
  const room = getRoom(roomCode);
  if (room) {
    // Valid room: authorize and register user as room member
    addRoomMember(roomCode, {
      id: user.id,
      name: user.name,
      email: user.email || '',
    });
    console.log(
      `[Auth Security] Auto-authorized member ${user.name} (${user.id}) for room ${roomCode}`
    );
    return true;
  }

  console.warn(
    `[Auth Security] Rejected user ${user.name} (${user.id}) from document "${documentName}" — Room ${roomCode} does not exist.`
  );
  return false;
}
