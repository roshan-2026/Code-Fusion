import React, { useState } from 'react';
import { Search } from 'lucide-react';
import type { WorkspaceFile } from '../../types/workspace';
import { FileIcon } from '../FileIcon';

interface SearchPanelProps {
  files: WorkspaceFile[];
  onSelectFile: (fileId: string) => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ files, onSelectFile }) => {
  const [query, setQuery] = useState('');

  const matches = query.trim()
    ? files
        .map((f) => {
          const contentMatches: { line: number; text: string }[] = [];
          const lines = f.content.split('\n');
          lines.forEach((l, idx) => {
            if (l.toLowerCase().includes(query.toLowerCase())) {
              contentMatches.push({ line: idx + 1, text: l.trim() });
            }
          });
          return {
            file: f,
            matches: contentMatches,
          };
        })
        .filter((res) => res.matches.length > 0 || res.file.name.toLowerCase().includes(query.toLowerCase()))
    : [];

  return (
    <div className="flex-1 flex flex-col select-none overflow-hidden bg-[#1e1e1e]">
      <div className="h-9 px-3 flex items-center border-b border-[#3c3c3c] text-[11px] font-bold tracking-wider uppercase text-neutral-400">
        Search
      </div>

      <div className="p-2 border-b border-[#3c3c3c]">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-[#252526] border border-[#3c3c3c] rounded text-xs focus-within:border-indigo-500">
          <Search className="w-3.5 h-3.5 text-neutral-400" />
          <input
            type="text"
            placeholder="Search code across all files..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-transparent text-white outline-none font-mono text-[11px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {query.trim() === '' ? (
          <div className="p-4 text-center text-xs text-neutral-500">
            Type to search across all project files
          </div>
        ) : matches.length === 0 ? (
          <div className="p-4 text-center text-xs text-neutral-500">
            No results found for "{query}"
          </div>
        ) : (
          matches.map(({ file, matches }) => (
            <div key={file.id} className="text-xs space-y-1">
              <div
                onClick={() => onSelectFile(file.id)}
                className="flex items-center gap-1.5 text-neutral-300 font-semibold cursor-pointer hover:text-white"
              >
                <FileIcon language={file.language} className="w-3.5 h-3.5" />
                <span>{file.name}</span>
                <span className="text-[10px] text-neutral-500">({matches.length})</span>
              </div>
              <div className="pl-4 space-y-0.5">
                {matches.slice(0, 5).map((m, idx) => (
                  <div
                    key={idx}
                    onClick={() => onSelectFile(file.id)}
                    className="flex items-center gap-2 font-mono text-[10px] text-neutral-400 hover:text-neutral-200 cursor-pointer truncate py-0.5"
                  >
                    <span className="text-neutral-600 w-5 text-right">{m.line}:</span>
                    <span className="truncate">{m.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
