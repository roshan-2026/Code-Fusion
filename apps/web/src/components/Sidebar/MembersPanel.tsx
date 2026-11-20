import React, { useState } from 'react';
import { Users, Crown, Copy, Check, Wifi, WifiOff } from 'lucide-react';
import type { RoomMember } from '@hostelcode/shared';

interface MembersPanelProps {
  roomCode: string;
  creatorName: string;
  creatorEmail: string;
  members: RoomMember[];
}

export const MembersPanel: React.FC<MembersPanelProps> = ({
  roomCode,
  creatorName,
  creatorEmail,
  members,
}) => {
  const [copiedCode, setCopiedCode] = useState(false);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const onlineMembers = members.filter((m) => m.isOnline);
  const offlineMembers = members.filter((m) => !m.isOnline);

  return (
    <div className="flex-1 flex flex-col select-none overflow-hidden bg-[#1e1e1e]">
      {/* Panel Header */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-[#3c3c3c] text-[11px] font-bold tracking-wider uppercase text-neutral-400">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-indigo-400" />
          <span>Team Members</span>
        </div>
        <span className="font-mono text-[10px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/20">
          {onlineMembers.length} Online
        </span>
      </div>

      {/* Room Code Card */}
      <div className="p-3 border-b border-[#3c3c3c] bg-[#181818]/60 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
            Share Room Code
          </span>
          <span className="text-[10px] text-neutral-500 truncate max-w-[120px]" title={creatorEmail}>
            Host: {creatorName}
          </span>
        </div>
        <div className="flex items-center justify-between p-2 bg-[#252526] border border-[#3c3c3c] rounded-lg">
          <span className="font-mono text-base font-bold text-indigo-300 tracking-widest pl-1">
            {roomCode}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopyCode}
              title="Copy 6-Digit Code"
              className="p-1 hover:text-white hover:bg-[#333333] text-neutral-400 rounded transition-colors"
            >
              {copiedCode ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
        <div className="text-[10px] text-neutral-500">
          Peers can enter this code on the homepage to join and edit live.
        </div>
      </div>

      {/* Members List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Online Section */}
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-emerald-400 font-semibold mb-2 flex items-center gap-1.5">
            <Wifi className="w-3 h-3" />
            <span>Online Collaborators ({onlineMembers.length})</span>
          </div>
          <div className="space-y-1.5">
            {onlineMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between p-2 rounded-lg bg-[#252526] border border-[#333333]"
              >
                <div className="flex items-center gap-2.5 truncate">
                  <div className="relative">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-white text-xs shadow"
                      style={{ backgroundColor: member.color }}
                    >
                      {member.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#1e1e1e]"></span>
                  </div>
                  <div className="truncate text-left">
                    <div className="text-xs font-semibold text-white flex items-center gap-1.5 truncate">
                      <span>{member.name}</span>
                      {member.isCreator && (
                        <span title="Room Creator">
                          <Crown className="w-3 h-3 text-amber-400 shrink-0" />
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-neutral-400 truncate font-mono">
                      {member.email}
                    </div>
                  </div>
                </div>

                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 shrink-0 ml-1">
                  Active
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Offline Section */}
        {offlineMembers.length > 0 && (
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 font-semibold mb-2 flex items-center gap-1.5">
              <WifiOff className="w-3 h-3" />
              <span>Offline / Cached Members ({offlineMembers.length})</span>
            </div>
            <div className="space-y-1.5">
              {offlineMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-2 rounded-lg bg-[#1f1f20] border border-[#2d2d2d] opacity-70"
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <div className="relative">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-white text-xs filter grayscale-[40%]"
                        style={{ backgroundColor: member.color }}
                      >
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                      <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-neutral-500 border-2 border-[#1e1e1e]"></span>
                    </div>
                    <div className="truncate text-left">
                      <div className="text-xs font-semibold text-neutral-300 flex items-center gap-1.5 truncate">
                        <span>{member.name}</span>
                        {member.isCreator && (
                          <span title="Room Creator">
                            <Crown className="w-3 h-3 text-amber-400/70 shrink-0" />
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-neutral-500 truncate font-mono">
                        {member.email}
                      </div>
                    </div>
                  </div>

                  <span className="text-[10px] font-mono text-neutral-500 bg-neutral-500/10 px-1.5 py-0.5 rounded shrink-0 ml-1">
                    Offline
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Total summary */}
      <div className="p-2.5 border-t border-[#3c3c3c] text-[10px] text-neutral-400 text-center font-mono bg-[#181818]">
        {members.length} Total Room Members ({onlineMembers.length} Online)
      </div>
    </div>
  );
};
