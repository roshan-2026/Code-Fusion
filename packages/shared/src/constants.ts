import type { DocumentIdentity, SupportedLanguage } from './types.js';

/**
 * Standard prefix and delimiter for Yjs document IDs.
 * Format: project:{projectId}:file:{fileId}
 */
export const DOCUMENT_PREFIX = 'project';
export const DOCUMENT_FILE_SEPARATOR = ':file:';

/**
 * Valid characters for 6-digit room code: uppercase letters and numbers,
 * omitting ambiguous chars like 0, O, 1, I for crystal-clear readability over Wi-Fi.
 */
export const ROOM_CODE_CHARACTERS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Generates a unique 6-digit uppercase alphanumeric room code (e.g. "K7M4P9").
 */
export function generateRoomCode(): string {
  let result = '';
  const charsLength = ROOM_CODE_CHARACTERS.length;
  for (let i = 0; i < 6; i++) {
    result += ROOM_CODE_CHARACTERS.charAt(Math.floor(Math.random() * charsLength));
  }
  return result;
}

/**
 * Validates whether a room code is a 6-digit uppercase alphanumeric code.
 */
export function validateRoomCode(code: string): boolean {
  if (!code) return false;
  const clean = code.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(clean);
}

/**
 * Builds a stable Yjs document identifier from projectId and fileId.
 */
export function buildDocumentName(projectId: string, fileId: string): string {
  if (!projectId || !fileId) {
    throw new Error('Both projectId and fileId are required to build a document name');
  }
  return `project:${projectId.trim().toUpperCase()}:file:${fileId.trim()}`;
}

/**
 * Parses a stable Yjs document identifier back into projectId and fileId.
 */
export function parseDocumentName(docName: string): DocumentIdentity | null {
  if (!docName) return null;
  const match = docName.match(/^project:([^:]+):file:(.+)$/);
  if (!match) return null;
  return {
    projectId: match[1],
    fileId: match[2],
  };
}

/**
 * Curated high-contrast palette for collaborator cursors and avatars
 */
export const COLLABORATOR_COLORS = [
  '#F43F5E', // Rose
  '#3B82F6', // Blue
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#14B8A6', // Teal
  '#F97316', // Orange
  '#6366F1', // Indigo
];

/**
 * Deterministically picks a color from palette based on user ID or email string
 */
export function getCollaboratorColor(identifier: string): string {
  let hash = 0;
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash << 5) - hash + identifier.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % COLLABORATOR_COLORS.length;
  return COLLABORATOR_COLORS[index];
}

/**
 * Maps common file extensions to Monaco supported language identifiers
 */
export const EXTENSION_TO_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  java: 'java',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  json: 'json',
  md: 'markdown',
};

/**
 * Detect language by filename
 */
export function detectLanguageFromFilename(filename: string): SupportedLanguage {
  const parts = filename.split('.');
  if (parts.length > 1) {
    const ext = parts[parts.length - 1].toLowerCase();
    if (ext in EXTENSION_TO_LANGUAGE_MAP) {
      return EXTENSION_TO_LANGUAGE_MAP[ext];
    }
  }
  return 'typescript';
}
