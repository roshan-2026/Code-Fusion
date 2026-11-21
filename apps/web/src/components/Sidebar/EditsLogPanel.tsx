import React from 'react';
import { History, Code, ArrowRight, CheckCircle2 } from 'lucide-react';
import type { FileEditLogEntry } from '@hostelcode/shared';

interface EditsLogPanelProps {
  activeFileName?: string;
  edits: FileEditLogEntry[];
  currentUserId: string;
  onSelectEdit: (entry: FileEditLogEntry) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export const EditsLogPanel: React.FC<EditsLogPanelProps> = ({
  activeFileName,
  edits,
  currentUserId,
  onSelectEdit,
}) => {
  // Group and display line-wise: 1 card per user per line so multi-user edits on the same line are each shown
  const lineWiseEdits = React.useMemo(() => {
    const map = new Map<string, FileEditLogEntry>();
    const sorted = [...edits].sort((a, b) => a.timestamp - b.timestamp);
    sorted.forEach((e) => {
      const key = `${e.userId || e.userName}_${e.linePreview || 1}`;
      map.set(key, e);
    });
    return Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [edits]);

  return (
    <div className="flex-1 flex flex-col select-none overflow-hidden bg-[#1e1e1e]">
      {/* Panel Header */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-[#3c3c3c] text-[11px] font-bold tracking-wider uppercase text-neutral-400">
        <div className="flex items-center gap-1.5">
          <History className="w-3.5 h-3.5 text-indigo-400" />
          <span>Edit History</span>
        </div>
        <span className="font-mono text-[10px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/20">
          {lineWiseEdits.length} {lineWiseEdits.length === 1 ? 'Edit' : 'Edits'}
        </span>
      </div>

      {/* Info Banner */}
      <div className="p-2.5 border-b border-[#3c3c3c] bg-[#181818]/70 text-[11px] text-neutral-400 flex flex-col gap-1">
        <div className="flex items-center justify-between text-neutral-300 font-medium">
          <span className="truncate max-w-[170px]" title={activeFileName}>
            📄 {activeFileName || 'Active File'}
          </span>
          <span className="text-[10px] text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            Permanent
          </span>
        </div>
        <p className="text-[10px] text-neutral-500 leading-tight">
          Edits stay permanently logged & highlighted line-wise in each user&apos;s unique color across refreshes and team joins.
        </p>
      </div>

      {/* Edits List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
        {lineWiseEdits.length === 0 ? (
          <div className="py-12 px-4 text-center text-neutral-500 flex flex-col items-center">
            <Code className="w-8 h-8 text-neutral-600 mb-2 stroke-[1.5]" />
            <p className="text-xs font-medium text-neutral-400">No edits recorded yet</p>
            <p className="text-[11px] text-neutral-500 mt-1 max-w-[190px]">
              Initial file code is clean. Any edits typed by team members will be logged here and highlighted permanently.
            </p>
          </div>
        ) : (
          lineWiseEdits.map((entry) => {
            const isMe = entry.userId === currentUserId;
            const authorName = isMe ? `${entry.userName} (You)` : entry.userName;
            const userColor = entry.userColor || '#6366F1';

            return (
              <div
                key={entry.id}
                onClick={() => onSelectEdit(entry)}
                className="group p-2 rounded-lg bg-[#252526] hover:bg-[#2d2d2d] border border-[#333333] hover:border-indigo-500/50 cursor-pointer transition-all duration-150 flex flex-col gap-1.5 shadow-sm"
              >
                {/* Author & Timestamp */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 truncate max-w-[140px]">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0 shadow-sm"
                      style={{ backgroundColor: userColor }}
                    />
                    <span
                      className="text-xs font-semibold truncate"
                      style={{ color: userColor }}
                      title={authorName}
                    >
                      {authorName}
                    </span>
                  </div>
                  <span className="text-[10px] text-neutral-500 shrink-0">
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </div>

                {/* Line Code Preview */}
                <div className="p-1 px-1.5 rounded bg-[#181818] border border-[#333333] font-mono text-[11px] text-neutral-300 truncate group-hover:text-white transition-colors">
                  {entry.text && entry.text.trim() ? entry.text : '(empty line)'}
                </div>

                {/* Footer with line & jump indicator */}
                <div className="flex items-center justify-between text-[10px] text-neutral-500 pt-0.5">
                  <span className="font-semibold text-neutral-400">Line {entry.linePreview || 1}</span>
                  <span className="opacity-0 group-hover:opacity-100 text-indigo-400 flex items-center gap-0.5 transition-opacity font-medium">
                    Jump to Line <ArrowRight className="w-2.5 h-2.5" />
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
