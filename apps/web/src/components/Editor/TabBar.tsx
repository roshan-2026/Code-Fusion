import React from 'react';
import { X, Undo2, Redo2, Download } from 'lucide-react';
import { FileIcon } from '../FileIcon';
import type { WorkspaceFile } from '../../types/workspace';

interface TabBarProps {
  openFiles: WorkspaceFile[];
  activeFileId: string;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSaveFile?: () => void;
  onSelectTab: (fileId: string) => void;
  onCloseTab: (fileId: string) => void;
}

export const TabBar: React.FC<TabBarProps> = ({
  openFiles,
  activeFileId,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSaveFile,
  onSelectTab,
  onCloseTab,
}) => {
  return (
    <div className="h-9 bg-[#252526] border-b border-[#3c3c3c] flex items-center justify-between select-none">
      {/* File Tabs */}
      <div className="flex-1 flex items-center overflow-x-auto no-scrollbar">
        {openFiles.length === 0 ? (
          <div className="px-3 text-xs text-neutral-500 font-mono italic">No file selected</div>
        ) : (
          openFiles.map((file) => {
            const isActive = file.id === activeFileId;
            return (
              <div
                key={file.id}
                onClick={() => onSelectTab(file.id)}
                className={`group h-9 flex items-center gap-2 px-3 border-r border-[#3c3c3c] cursor-pointer text-xs font-mono transition-colors shrink-0 ${
                  isActive
                    ? 'bg-[#1e1e1e] text-white border-t-2 border-t-indigo-500 font-medium'
                    : 'bg-[#2d2d2d] text-neutral-400 hover:bg-[#282828] hover:text-neutral-200'
                }`}
              >
                <FileIcon language={file.language} className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate max-w-[140px]">{file.name}</span>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(file.id);
                  }}
                  title="Close Tab"
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[#3c3c3c] text-neutral-400 hover:text-white transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Actions: Save File & Per-User Undo & Redo */}
      <div className="flex items-center gap-1.5 px-2 border-l border-[#3c3c3c] shrink-0 bg-[#252526]">
        {onSaveFile && (
          <button
            onClick={onSaveFile}
            disabled={!activeFileId}
            title="Download / Save file locally (Ctrl+S)"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 hover:text-white border border-indigo-500/30 transition-colors disabled:opacity-30 disabled:hover:bg-indigo-600/20"
          >
            <Download className="w-3.5 h-3.5 text-indigo-400" />
            <span className="hidden sm:inline text-[11px] font-mono font-medium">Save File</span>
          </button>
        )}

        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo my changes only (Ctrl+Z)"
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-neutral-300 hover:text-white hover:bg-[#333333] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-300 transition-colors"
        >
          <Undo2 className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden md:inline text-[11px] font-mono">Undo</span>
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo my changes only (Ctrl+Y)"
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-neutral-300 hover:text-white hover:bg-[#333333] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-300 transition-colors"
        >
          <Redo2 className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden md:inline text-[11px] font-mono">Redo</span>
        </button>
      </div>
    </div>
  );
};
