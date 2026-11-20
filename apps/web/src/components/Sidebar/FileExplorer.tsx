import React, { useState, useRef } from 'react';
import { Plus, Trash2, ChevronDown, FilePlus, Upload, AlertCircle, FolderPlus } from 'lucide-react';
import { FileIcon } from '../FileIcon';
import type { WorkspaceFile } from '../../types/workspace';
import { detectLanguageFromFilename } from '@hostelcode/shared';
import type { SupportedLanguage } from '@hostelcode/shared';

interface FileExplorerProps {
  files: WorkspaceFile[];
  activeFileId: string;
  onSelectFile: (fileId: string) => void;
  onCreateFile: (name: string, language: SupportedLanguage, content?: string) => void;
  onDeleteFile: (fileId: string) => void;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({
  files,
  activeFileId,
  onSelectFile,
  onCreateFile,
  onDeleteFile,
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFileName.trim();
    if (!trimmed) {
      setIsCreating(false);
      setError(null);
      return;
    }

    if (files.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) {
      setError('A file with this name already exists');
      return;
    }

    const language = detectLanguageFromFilename(trimmed);
    onCreateFile(trimmed, language, `// ${trimmed}\n`);
    setNewFileName('');
    setIsCreating(false);
    setError(null);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    Array.from(uploadedFiles).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = (event.target?.result as string) || '';
        const language = detectLanguageFromFilename(file.name);
        onCreateFile(file.name, language, content);
      };
      reader.readAsText(file);
    });

    // Reset input
    e.target.value = '';
  };

  return (
    <div className="flex-1 flex flex-col select-none overflow-hidden bg-[#1e1e1e]">
      {/* Explorer Header */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-[#3c3c3c] text-[11px] font-bold tracking-wider uppercase text-neutral-400">
        <div className="flex items-center gap-1">
          <ChevronDown className="w-3.5 h-3.5" />
          <span>Files</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Upload Files From Computer"
            className="p-1 hover:text-white hover:bg-[#333333] rounded transition-colors"
          >
            <Upload className="w-3.5 h-3.5 text-neutral-300 hover:text-white" />
          </button>
          <button
            onClick={() => {
              setIsCreating(true);
              setError(null);
            }}
            title="New File"
            className="p-1 hover:text-white hover:bg-[#333333] rounded transition-colors"
          >
            <FilePlus className="w-3.5 h-3.5 text-neutral-300 hover:text-white" />
          </button>
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
          />
        </div>
      </div>

      {/* Inline Create Input */}
      {isCreating && (
        <form onSubmit={handleCreateSubmit} className="p-2 border-b border-[#3c3c3c] bg-[#252526]">
          <div className="flex items-center gap-1.5 px-2 py-1 bg-[#1e1e1e] border border-indigo-500 rounded text-xs">
            <Plus className="w-3 h-3 text-indigo-400 shrink-0" />
            <input
              type="text"
              autoFocus
              placeholder="e.g. main.py, App.tsx"
              value={newFileName}
              onChange={(e) => {
                setNewFileName(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsCreating(false);
                  setError(null);
                }
              }}
              className="w-full bg-transparent text-white outline-none font-mono text-[11px]"
            />
          </div>
          {error && (
            <div className="flex items-center gap-1 text-[10px] text-rose-400 mt-1 px-1">
              <AlertCircle className="w-3 h-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="text-[10px] text-neutral-500 mt-1 px-1">
            Press Enter to save, Esc to cancel
          </div>
        </form>
      )}

      {/* Files List */}
      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <div className="p-4 text-center space-y-3">
            <FolderPlus className="w-8 h-8 text-neutral-500 mx-auto opacity-50" />
            <div className="text-xs text-neutral-400 font-medium">No files in this project yet</div>
            <div className="text-[11px] text-neutral-500">
              Upload files from your computer or create a new file to start collaborating.
            </div>
            <div className="pt-2 flex flex-col gap-2">
              <button
                onClick={() => setIsCreating(true)}
                className="w-full py-1.5 px-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium"
              >
                + Create File
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-1.5 px-2 bg-[#2a2d2e] hover:bg-[#333333] border border-[#3c3c3c] text-neutral-300 rounded text-xs font-medium"
              >
                Upload Files
              </button>
            </div>
          </div>
        ) : (
          files.map((file) => {
            const isActive = file.id === activeFileId;
            return (
              <div
                key={file.id}
                onClick={() => onSelectFile(file.id)}
                className={`group flex items-center justify-between px-3 py-1.5 text-xs font-mono cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-[#37373d] text-white font-medium'
                    : 'text-neutral-300 hover:bg-[#2a2d2e] hover:text-white'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <FileIcon language={file.language} className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{file.name}</span>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete file "${file.name}"?`)) {
                        onDeleteFile(file.id);
                      }
                    }}
                    title="Delete File"
                    className="p-1 hover:text-rose-400 hover:bg-[#333333] rounded"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Workspace Footer Hint */}
      <div className="p-2 border-t border-[#3c3c3c] text-[10px] text-neutral-500 text-center font-mono">
        {files.length} {files.length === 1 ? 'file' : 'files'}
      </div>
    </div>
  );
};
