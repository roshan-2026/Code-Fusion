/**
 * Connection states for HostelCode
 */
export type ConnectionStatus = 'online' | 'offline' | 'reconnecting' | 'syncing';

/**
 * Health check response format
 */
export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  version: string;
  timestamp: string;
  uptimeSeconds: number;
  environment: string;
  metrics?: {
    activeConnections: number;
    activeDocuments: number;
  };
}

/**
 * Authenticated user profile
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  color: string;
}

/**
 * Room member with online/offline status
 */
export interface RoomMember {
  id: string;
  name: string;
  email: string;
  color: string;
  isOnline: boolean;
  isCreator?: boolean;
  lastSeen?: number;
}

/**
 * Collaborator presence state broadcast via Yjs Awareness
 */
export interface UserPresence {
  id: string;
  name: string;
  color: string;
  email?: string;
  cursor?: {
    lineNumber: number;
    column: number;
  } | null;
  selection?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  lastActive?: number;
}

/**
 * Supported programming languages for Monaco Editor
 */
export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'cpp'
  | 'html'
  | 'css'
  | 'json'
  | 'markdown';

/**
 * Project file metadata with Recycle Bin and Permanent Deletion Consensus
 */
export interface ProjectFile {
  id: string;
  projectId: string;
  name: string;
  path: string;
  language: SupportedLanguage;
  content: string;
  isRecycled?: boolean;
  recycledBy?: string;
  recycledAt?: string;
  deleteVotes?: string[]; // Array of user IDs who marked for permanent deletion
  createdAt: string;
  updatedAt: string;
}

/**
 * Room / Project metadata
 */
export interface Room {
  code: string; // 6-digit capital alphanumeric e.g. "K7M4P9"
  name: string;
  creatorId: string;
  creatorName: string;
  creatorEmail: string;
  createdAt: string;
  updatedAt: string;
  files: ProjectFile[];
  members?: RoomMember[];
}

/**
 * Persistent edit attribution entry for shared collaborative documents
 */
export interface FileEditLogEntry {
  id: string;
  fileId: string;
  userId: string;
  userName: string;
  userColor: string;
  startRelPos: any;
  endRelPos: any;
  text?: string;
  timestamp: number;
  linePreview?: number;
}

/**
 * Parsed document identity
 */
export interface DocumentIdentity {
  projectId: string;
  fileId: string;
}
