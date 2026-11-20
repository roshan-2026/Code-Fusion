import React, { useState } from 'react';
import { Code2, ArrowLeft, Copy, Check, Users, Wifi, WifiOff, Trash2 } from 'lucide-react';
import { HealthStatus } from './HealthStatus';
import type { AuthUser, ConnectionStatus, RoomMember } from '@hostelcode/shared';

interface HeaderProps {
  roomCode?: string;
  roomName?: string;
  connectionStatus?: ConnectionStatus;
  members?: RoomMember[];
  currentUser: AuthUser | null;
  isAdmin?: boolean;
  onLeaveRoom?: () => void;
  onOpenMembers?: () => void;
  onOpenAuth?: () => void;
  onDeleteRoom?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  roomCode,
  roomName,
  connectionStatus = 'offline',
  members = [],
  currentUser,
  isAdmin,
  onLeaveRoom,
  onOpenMembers,
  onOpenAuth,
  onDeleteRoom,
}) => {
  const [copiedCode, setCopiedCode] = useState(false);

  const handleCopyCode = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const onlineCount = members.filter((m) => m.isOnline).length;

  return (
    <header className="h-12 bg-[#1e1e1e] border-b border-[#3c3c3c] flex items-center justify-between px-3 select-none shrink-0 text-xs">
      <div className="flex items-center gap-3">
        {onLeaveRoom && (
          <button
            onClick={onLeaveRoom}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#252526] hover:bg-[#333333] border border-[#3c3c3c] text-neutral-300 hover:text-white transition-colors"
            title="Leave room and return to Home"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline font-medium">Home</span>
          </button>
        )}

        <div className="flex items-center gap-2 font-bold text-sm tracking-wide">
          <div className="p-1 bg-indigo-500/10 border border-indigo-500/20 rounded">
            <Code2 className="w-4 h-4 text-indigo-400" />
          </div>
          <span className="text-white hidden md:inline">
            Hostel<span className="text-indigo-400">Code</span>
          </span>
        </div>

        {/* 6-DIGIT ROOM CODE BADGE */}
        {roomCode && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#252526] border border-indigo-500/30">
            <span className="text-[10px] text-neutral-400 uppercase font-mono hidden sm:inline">
              Room:
            </span>
            <span className="font-mono font-bold text-indigo-300 tracking-wider">
              {roomCode}
            </span>
            <button
              onClick={handleCopyCode}
              title="Copy 6-Digit Room Code"
              className="p-1 hover:text-white text-neutral-400 hover:bg-[#333333] rounded"
            >
              {copiedCode ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        )}

        {/* Room Name */}
        {roomName && (
          <span className="hidden lg:inline text-neutral-400 font-medium truncate max-w-[160px]">
            {roomName}
          </span>
        )}

        {/* Delete Room Button (Admin Only) */}
        {isAdmin && onDeleteRoom && (
          <button
            onClick={onDeleteRoom}
            title="Permanently Delete Room (Creator Admin Only)"
            className="flex items-center gap-1 px-2 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-300 hover:text-rose-100 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            <span className="font-medium hidden sm:inline">Delete Room</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {/* CONNECTION STATUS BADGE */}
        {roomCode && (
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono ${
              connectionStatus === 'online'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : connectionStatus === 'syncing'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-400 animate-pulse'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            }`}
          >
            {connectionStatus === 'online' ? (
              <Wifi className="w-3.5 h-3.5" />
            ) : (
              <WifiOff className="w-3.5 h-3.5" />
            )}
            <span className="capitalize">{connectionStatus}</span>
          </div>
        )}

        {/* TEAM MEMBERS BUTTON */}
        {roomCode && onOpenMembers && (
          <button
            onClick={onOpenMembers}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#252526] hover:bg-[#333333] border border-[#3c3c3c] text-neutral-200 transition-colors"
          >
            <Users className="w-3.5 h-3.5 text-indigo-400" />
            <span className="font-semibold">{onlineCount}</span>
            <span className="hidden sm:inline text-neutral-400">Online</span>
          </button>
        )}

        <HealthStatus />

        {/* CURRENT USER AVATAR */}
        {currentUser ? (
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-white text-xs border border-white/20 shadow"
            style={{ backgroundColor: currentUser.color }}
            title={`Signed in as ${currentUser.name} (${currentUser.email})`}
          >
            {currentUser.name.charAt(0).toUpperCase()}
          </div>
        ) : onOpenAuth ? (
          <button
            onClick={onOpenAuth}
            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[11px] font-medium transition-colors"
          >
            Login
          </button>
        ) : null}
      </div>
    </header>
  );
};
