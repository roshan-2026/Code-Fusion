import React, { useState, useEffect } from 'react';
import { Files, Search, Users, Settings } from 'lucide-react';
import type * as monacoEditor from 'monaco-editor';
import { Header } from './Header';
import { FileExplorer } from './Sidebar/FileExplorer';
import { SearchPanel } from './Sidebar/SearchPanel';
import { MembersPanel } from './Sidebar/MembersPanel';
import { SettingsPanel } from './Sidebar/SettingsPanel';
import { TabBar } from './Editor/TabBar';
import { CodeEditor } from './Editor/CodeEditor';
import { StatusBar } from './StatusBar';
import { useRoomCollab } from '../collaboration/useRoomCollab';
import { updateRoomFilesLocally } from '../lib/roomStorage';
import type { WorkspaceFile, SidebarView, EditorSettings } from '../types/workspace';
import type { Room, AuthUser, SupportedLanguage } from '@hostelcode/shared';

interface WorkspaceProps {
  room: Room;
  currentUser: AuthUser;
  onLeaveRoom: () => void;
}

export const Workspace: React.FC<WorkspaceProps> = ({ room, currentUser, onLeaveRoom }) => {
  const [files, setFiles] = useState<WorkspaceFile[]>(() => {
    if (room.files && room.files.length > 0) {
      return room.files.map((f: any) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        language: f.language,
        content: f.content,
      }));
    }
    return [];
  });

  const [openFileIds, setOpenFileIds] = useState<string[]>(() =>
    files.length > 0 ? [files[0].id] : []
  );
  const [activeFileId, setActiveFileId] = useState<string>(() =>
    files.length > 0 ? files[0].id : ''
  );
  const [activeSidebar, setActiveSidebar] = useState<SidebarView | null>('explorer');
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [editorInstance, setEditorInstance] =
    useState<monacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const [editorSettings, setEditorSettings] = useState<EditorSettings>({
    fontSize: 14,
    minimap: true,
    wordWrap: 'on',
    tabSize: 2,
    lineNumbers: 'on',
  });

  const activeFile = files.find((f) => f.id === activeFileId) || files[0];
  const openFiles = files.filter((f) => openFileIds.includes(f.id));

  // Connect CRDT, Presence and Per-User Undo Hook
  const { connectionStatus, members, canUndo, canRedo, undo, redo } = useRoomCollab({
    roomCode: room.code,
    activeFileId: activeFile ? activeFile.id : '',
    initialContent: activeFile ? activeFile.content : '',
    currentUser,
    creatorUser: {
      id: room.creatorId,
      name: room.creatorName,
      email: room.creatorEmail,
    },
    editor: editorInstance,
  });

  // Save files to local storage and sync to secure database
  useEffect(() => {
    if (files.length > 0) {
      updateRoomFilesLocally(
        room.code,
        files.map((f) => ({
          ...f,
          projectId: room.code,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        currentUser
      );
    }
  }, [files, room.code, currentUser]);

  // Switch or open a file
  const handleSelectFile = (fileId: string) => {
    setActiveFileId(fileId);
    if (!openFileIds.includes(fileId)) {
      setOpenFileIds((prev) => [...prev, fileId]);
    }
  };

  // Close an editor tab
  const handleCloseTab = (fileId: string) => {
    const nextOpen = openFileIds.filter((id) => id !== fileId);
    if (nextOpen.length === 0) return;
    setOpenFileIds(nextOpen);
    if (activeFileId === fileId) {
      setActiveFileId(nextOpen[nextOpen.length - 1]);
    }
  };

  // Create or upload a file
  const handleCreateFile = (name: string, language: SupportedLanguage, content?: string) => {
    const newFile: WorkspaceFile = {
      id: `file-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name,
      path: `/${name}`,
      language,
      content: content !== undefined ? content : `// ${name}\n`,
    };
    setFiles((prev) => [...prev, newFile]);
    setOpenFileIds((prev) => (prev.includes(newFile.id) ? prev : [...prev, newFile.id]));
    setActiveFileId(newFile.id);
  };

  // Delete a file
  const handleDeleteFile = (fileId: string) => {
    const nextFiles = files.filter((f) => f.id !== fileId);
    setFiles(nextFiles);
    const nextOpen = openFileIds.filter((id) => id !== fileId);
    setOpenFileIds(nextOpen);
    if (activeFileId === fileId) {
      setActiveFileId(
        nextOpen.length > 0 ? nextOpen[0] : nextFiles.length > 0 ? nextFiles[0].id : ''
      );
    }
  };

  // Edit file content
  const handleChangeContent = (fileId: string, newContent: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, content: newContent, isModified: true } : f))
    );
  };

  // Change active file's language
  const handleChangeLanguage = (newLang: SupportedLanguage) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === activeFileId ? { ...f, language: newLang } : f))
    );
  };

  // Toggle or switch sidebar view
  const handleToggleSidebar = (view: SidebarView) => {
    if (activeSidebar === view) {
      setActiveSidebar(null);
    } else {
      setActiveSidebar(view);
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#181818] text-[#cccccc]">
      <Header
        roomCode={room.code}
        roomName={room.name}
        connectionStatus={connectionStatus}
        members={members}
        currentUser={currentUser}
        onLeaveRoom={onLeaveRoom}
        onOpenMembers={() => setActiveSidebar('members')}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Activity Bar */}
        <aside className="w-12 bg-[#252526] border-r border-[#3c3c3c] flex flex-col items-center py-2 justify-between shrink-0 select-none">
          <div className="flex flex-col items-center gap-2 text-neutral-400">
            <button
              onClick={() => handleToggleSidebar('explorer')}
              className={`p-2.5 rounded transition-colors ${
                activeSidebar === 'explorer'
                  ? 'text-white bg-[#333333] border-l-2 border-l-indigo-500'
                  : 'hover:text-white hover:bg-[#2d2d2d]'
              }`}
              title="Explorer"
            >
              <Files className="w-5 h-5" />
            </button>
            <button
              onClick={() => handleToggleSidebar('search')}
              className={`p-2.5 rounded transition-colors ${
                activeSidebar === 'search'
                  ? 'text-white bg-[#333333] border-l-2 border-l-indigo-500'
                  : 'hover:text-white hover:bg-[#2d2d2d]'
              }`}
              title="Search"
            >
              <Search className="w-5 h-5" />
            </button>
            <button
              onClick={() => handleToggleSidebar('members')}
              className={`p-2.5 rounded transition-colors relative ${
                activeSidebar === 'members'
                  ? 'text-white bg-[#333333] border-l-2 border-l-indigo-500'
                  : 'hover:text-white hover:bg-[#2d2d2d]'
              }`}
              title="Team Members & Online Status"
            >
              <Users className="w-5 h-5 text-indigo-400" />
              {members.some((m) => m.isOnline) && (
                <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400"></span>
              )}
            </button>
          </div>
          <div className="flex flex-col items-center gap-2 text-neutral-400">
            <button
              onClick={() => handleToggleSidebar('settings')}
              className={`p-2.5 rounded transition-colors ${
                activeSidebar === 'settings'
                  ? 'text-white bg-[#333333] border-l-2 border-l-indigo-500'
                  : 'hover:text-white hover:bg-[#2d2d2d]'
              }`}
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </aside>

        {/* Sidebar Panel Content */}
        {activeSidebar && (
          <div className="w-64 border-r border-[#3c3c3c] flex flex-col shrink-0">
            {activeSidebar === 'explorer' && (
              <FileExplorer
                files={files}
                activeFileId={activeFileId}
                onSelectFile={handleSelectFile}
                onCreateFile={handleCreateFile}
                onDeleteFile={handleDeleteFile}
              />
            )}
            {activeSidebar === 'search' && (
              <SearchPanel files={files} onSelectFile={handleSelectFile} />
            )}
            {activeSidebar === 'members' && (
              <MembersPanel
                roomCode={room.code}
                creatorName={room.creatorName}
                creatorEmail={room.creatorEmail}
                members={members}
              />
            )}
            {activeSidebar === 'settings' && (
              <SettingsPanel
                settings={editorSettings}
                onUpdateSettings={(newSettings) =>
                  setEditorSettings((prev) => ({ ...prev, ...newSettings }))
                }
              />
            )}
          </div>
        )}

        {/* Monaco Editor Container */}
        <div className="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
          <TabBar
            openFiles={openFiles}
            activeFileId={activeFileId}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            onSelectTab={handleSelectFile}
            onCloseTab={handleCloseTab}
          />
          <div className="flex-1 relative overflow-hidden">
            {activeFile ? (
              <CodeEditor
                file={activeFile}
                settings={editorSettings}
                onChangeContent={handleChangeContent}
                onCursorChange={(line, col) => setCursorPos({ line, col })}
                onMountEditor={(editor) => setEditorInstance(editor)}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-neutral-500 text-sm">
                No active file selected
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Status Bar */}
      <StatusBar
        cursorPos={cursorPos}
        activeLanguage={activeFile ? activeFile.language : 'typescript'}
        onChangeLanguage={handleChangeLanguage}
        characterCount={activeFile ? activeFile.content.length : 0}
      />
    </div>
  );
};
