import React, { useState, useEffect, useCallback } from 'react';
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
import {
  updateRoomFilesLocally,
  recycleFileOnServer,
  restoreFileOnServer,
  votePermanentDeleteOnServer,
} from '../lib/roomStorage';
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
        isRecycled: Boolean(f.isRecycled),
        recycledBy: f.recycledBy,
        recycledAt: f.recycledAt,
        deleteVotes: Array.isArray(f.deleteVotes) ? f.deleteVotes : [],
      }));
    }
    return [];
  });

  const activeFiles = files.filter((f) => !f.isRecycled);

  const [openFileIds, setOpenFileIds] = useState<string[]>(() =>
    activeFiles.length > 0 ? [activeFiles[0].id] : []
  );
  const [activeFileId, setActiveFileId] = useState<string>(() =>
    activeFiles.length > 0 ? activeFiles[0].id : ''
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

  const activeFile = files.find((f) => f.id === activeFileId && !f.isRecycled) || activeFiles[0];
  const openFiles = files.filter((f) => openFileIds.includes(f.id) && !f.isRecycled);

  // Connect CRDT, Presence, Per-User Undo, and Offline Sync Hook
  const { connectionStatus, members, canUndo, canRedo, undo, redo, syncNotice } = useRoomCollab({
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
          isRecycled: f.isRecycled,
          recycledBy: f.recycledBy,
          recycledAt: f.recycledAt,
          deleteVotes: f.deleteVotes,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        currentUser
      );
    }
  }, [files, room.code, currentUser]);

  // Save / Download active file locally to computer
  const handleSaveFile = useCallback(() => {
    if (!activeFile) return;
    try {
      const blob = new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = activeFile.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Download] Failed to save file:', err);
    }
  }, [activeFile]);

  // Keyboard shortcut Ctrl+S / Cmd+S to download / save active file
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveFile();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSaveFile]);

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
      isRecycled: false,
      deleteVotes: [],
    };
    setFiles((prev) => [...prev, newFile]);
    setOpenFileIds((prev) => (prev.includes(newFile.id) ? prev : [...prev, newFile.id]));
    setActiveFileId(newFile.id);
  };

  // Move a file to Recycle Bin
  const handleRecycleFile = (fileId: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === fileId
          ? {
              ...f,
              isRecycled: true,
              recycledBy: currentUser.name,
              recycledAt: new Date().toISOString(),
              deleteVotes: [currentUser.id],
            }
          : f
      )
    );

    // Close tab if open
    const nextOpen = openFileIds.filter((id) => id !== fileId);
    setOpenFileIds(nextOpen);
    if (activeFileId === fileId) {
      const remainingActive = files.filter((f) => f.id !== fileId && !f.isRecycled);
      setActiveFileId(
        nextOpen.length > 0 ? nextOpen[0] : remainingActive.length > 0 ? remainingActive[0].id : ''
      );
    }

    recycleFileOnServer(room.code, fileId, currentUser);
  };

  // Restore file from Recycle Bin
  const handleRestoreFile = (fileId: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === fileId
          ? {
              ...f,
              isRecycled: false,
              recycledBy: undefined,
              recycledAt: undefined,
              deleteVotes: [],
            }
          : f
      )
    );

    restoreFileOnServer(room.code, fileId, currentUser);
  };

  // Vote for permanent deletion (consensus of all members required)
  const handleVotePermanentDelete = async (fileId: string) => {
    const file = files.find((f) => f.id === fileId);
    if (!file) return;

    const currentVotes = file.deleteVotes || [];
    const updatedVotes = currentVotes.includes(currentUser.id)
      ? currentVotes
      : [...currentVotes, currentUser.id];

    const totalCount = Math.max(1, members.length);

    if (updatedVotes.length >= totalCount) {
      // Consensus reached! Permanently remove from workspace
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
    } else {
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, deleteVotes: updatedVotes } : f))
      );
    }

    const res = await votePermanentDeleteOnServer(room.code, fileId, currentUser);
    if (res?.permanentlyDeleted) {
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
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
                onDeleteFile={handleRecycleFile}
                onRestoreFile={handleRestoreFile}
                onVotePermanentDelete={handleVotePermanentDelete}
                totalMembers={members.length}
                currentUserId={currentUser.id}
              />
            )}
            {activeSidebar === 'search' && (
              <SearchPanel files={activeFiles} onSelectFile={handleSelectFile} />
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
        <div className="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden relative">
          {syncNotice && (
            <div className="absolute top-11 right-4 z-50 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs flex items-center gap-2 shadow-xl backdrop-blur animate-fade-in font-medium">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
              <span>{syncNotice}</span>
            </div>
          )}

          <TabBar
            openFiles={openFiles}
            activeFileId={activeFileId}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            onSaveFile={handleSaveFile}
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
