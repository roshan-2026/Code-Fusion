import { parseDocumentName } from '@hostelcode/shared';
import { isUserMemberOfRoom } from '../persistence/database.js';

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
 * Enforces room membership strictly against the database.
 */
export async function authorizeDocumentAccess(
  user: AuthUser,
  documentName: string
): Promise<boolean> {
  const docInfo = parseDocumentName(documentName);
  if (!docInfo) {
    // Document format not matching project:file schema
    return false;
  }

  const isMember = isUserMemberOfRoom(docInfo.projectId, user.id);
  if (!isMember) {
    console.warn(
      `[Auth Security] Rejected user ${user.name} (${user.id}) from document ${documentName} — Not a joined member of room ${docInfo.projectId}`
    );
    return false;
  }

  return true;
}
