import type { SupportedLanguage } from '@hostelcode/shared';

export interface WorkspaceFile {
  id: string;
  name: string;
  path: string;
  language: SupportedLanguage;
  content: string;
  isModified?: boolean;
}

export type SidebarView = 'explorer' | 'search' | 'members' | 'settings';

export interface EditorSettings {
  fontSize: number;
  minimap: boolean;
  wordWrap: 'on' | 'off';
  tabSize: number;
  lineNumbers: 'on' | 'off';
}
