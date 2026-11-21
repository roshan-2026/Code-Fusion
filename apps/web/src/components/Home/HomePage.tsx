import React, { useState, useEffect } from 'react';
import {
  Users,
  PlusCircle,
  LogIn,
  LogOut,
  FolderCode,
  Wifi,
  ArrowRight,
  RefreshCw,
  HardDrive,
  Copy,
  Check,
  Code2,
  Trash2,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { generateRoomCode, validateRoomCode } from '@hostelcode/shared';
import {
  saveRoomLocally,
  syncRoomToServer,
  checkRoomExists,
  fetchUserCreatedRooms,
  deleteRoomOnServer,
} from '../../lib/roomStorage';
import type { AuthUser, Room } from '@hostelcode/shared';

interface HomePageProps {
  currentUser: AuthUser | null;
  onUserChange: (user: AuthUser | null) => void;
  onEnterRoom: (roomCode: string) => void;
  onOpenAuth?: () => void;
  loadError?: string | null;
  onClearError?: () => void;
}

export const HomePage: React.FC<HomePageProps> = ({
  currentUser,
  onUserChange,
  onEnterRoom,
  onOpenAuth,
  loadError,
  onClearError,
}) => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);

  // Create Room state
  const [newRoomName, setNewRoomName] = useState('Hackathon Project');
  const [generatedCode, setGeneratedCode] = useState(generateRoomCode());
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);

  // Join Room state
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isCheckingRoom, setIsCheckingRoom] = useState(false);

  // Created rooms by current user
  const [createdRooms, setCreatedRooms] = useState<Room[]>([]);
  const [loadingCreatedRooms, setLoadingCreatedRooms] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Load rooms created by current user
  useEffect(() => {
    if (!currentUser) {
      setCreatedRooms([]);
      return;
    }
    setLoadingCreatedRooms(true);
    fetchUserCreatedRooms(currentUser)
      .then((rooms) => {
        setCreatedRooms(rooms);
      })
      .finally(() => {
        setLoadingCreatedRooms(false);
      });
  }, [currentUser]);

  const handleOpenCreate = () => {
    if (onClearError) onClearError();
    if (!currentUser) {
      if (onOpenAuth) onOpenAuth();
      return;
    }
    setGeneratedCode(generateRoomCode());
    setNewRoomName('');
    setIsCreateModalOpen(true);
  };

  const handleOpenJoin = () => {
    if (onClearError) onClearError();
    if (!currentUser) {
      if (onOpenAuth) onOpenAuth();
      return;
    }
    setJoinCode('');
    setJoinError(null);
    setIsJoinModalOpen(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      if (onOpenAuth) onOpenAuth();
      return;
    }

    const code = generatedCode.trim().toUpperCase();

    const newRoom: Room = {
      code,
      name: newRoomName.trim() || `Team Project (${code})`,
      creatorId: currentUser.id,
      creatorName: currentUser.name,
      creatorEmail: currentUser.email,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: [], // Starts with real user files uploaded or created in workspace
    };

    // Save locally to browser immediately
    saveRoomLocally(newRoom);
    setCreatedRooms((prev) => [newRoom, ...prev.filter((r) => r.code !== newRoom.code)]);

    setIsCreatingRoom(true);
    try {
      // Await server sync to guarantee database persistence
      await syncRoomToServer(newRoom, currentUser);
    } catch (err) {
      console.warn('Failed to sync new room to server:', err);
    } finally {
      setIsCreatingRoom(false);
    }

    setIsCreateModalOpen(false);
    onEnterRoom(code);
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      if (onOpenAuth) onOpenAuth();
      return;
    }
    const cleanCode = joinCode.trim().toUpperCase();
    if (!validateRoomCode(cleanCode)) {
      setJoinError('Room code must be exactly 6 uppercase letters/numbers.');
      return;
    }

    setIsCheckingRoom(true);
    setJoinError(null);

    try {
      const room = await checkRoomExists(cleanCode, currentUser);
      if (!room) {
        setJoinError('This room does not exist or has been closed by the host.');
        setIsCheckingRoom(false);
        return;
      }

      setIsCheckingRoom(false);
      setIsJoinModalOpen(false);
      onEnterRoom(cleanCode);
    } catch (err: any) {
      setJoinError(`Unable to verify room "${cleanCode}".`);
      setIsCheckingRoom(false);
    }
  };

  const handleCopyCode = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleDeleteCreatedRoom = async (code: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentUser) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete room "${name}" (${code}) permanently? All files and sessions will be deleted.`
    );
    if (!confirmed) return;

    try {
      await deleteRoomOnServer(code, currentUser);
      setCreatedRooms((prev) => prev.filter((r) => r.code !== code));
    } catch (err) {
      console.error('Failed to delete room:', err);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#121212] text-neutral-200 flex flex-col font-sans">
      {/* Top Navigation */}
      <header className="h-16 border-b border-[#2d2d2d] bg-[#181818]/80 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600/10 border border-indigo-500/20 rounded-lg text-indigo-400">
            <Code2 className="w-5 h-5" />
          </div>
          <div>
            <span className="font-bold text-lg text-white tracking-wide">
              Collab<span className="text-indigo-400">Code</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {currentUser ? (
            <div className="flex items-center gap-3 bg-[#252526] border border-[#3c3c3c] py-1.5 px-3 rounded-full text-xs">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-white text-[11px]"
                style={{ backgroundColor: currentUser.color }}
              >
                {currentUser.name.charAt(0).toUpperCase()}
              </div>
              <div className="hidden sm:block text-left">
                <div className="font-semibold text-white leading-none">{currentUser.name}</div>
                <div className="text-[10px] text-neutral-400 leading-none mt-0.5">
                  {currentUser.email}
                </div>
              </div>
              <button
                onClick={() => onUserChange(null)}
                title="Sign Out"
                className="ml-1 text-neutral-400 hover:text-rose-400 p-1"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => onOpenAuth?.()}
              className="flex items-center gap-2 px-4 py-2 bg-[#252526] hover:bg-[#333333] border border-[#3c3c3c] text-white rounded-lg text-xs font-medium transition-colors"
            >
              <LogIn className="w-4 h-4 text-indigo-400" />
              <span>Login / Register</span>
            </button>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-12 flex flex-col items-center text-center">
        {/* Load / Validation Error Banner */}
        {loadError && (
          <div className="w-full max-w-xl mx-auto mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/40 text-rose-300 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-left">
              <span className="font-bold text-rose-200 uppercase tracking-wide">Notice:</span>
              <span>{loadError}</span>
            </div>
            {onClearError && (
              <button
                onClick={onClearError}
                className="text-rose-400 hover:text-white p-1 rounded font-bold ml-2"
                title="Dismiss"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <h1 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight max-w-3xl">
          Code live with your team in{' '}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400">
            real-time sync
          </span>
        </h1>

        <p className="mt-4 text-base text-neutral-400 max-w-2xl leading-relaxed">
          Create a room with a 6-digit code or join your peers. Edits sync instantly when online,
          persist to local storage when disconnected, and merge automatically upon reconnection.
        </p>

        {/* TWO PRIMARY BUTTONS: CREATE TEAM / JOIN TEAM */}
        <div className="mt-10 flex flex-col sm:flex-row items-center gap-4 w-full max-w-md">
          <button
            onClick={handleOpenCreate}
            className="w-full flex-1 py-3.5 px-6 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-semibold rounded-xl text-base shadow-xl shadow-indigo-600/30 flex items-center justify-center gap-2 transition-all hover:scale-[1.02]"
          >
            <PlusCircle className="w-5 h-5" />
            <span>Create Team</span>
          </button>

          <button
            onClick={handleOpenJoin}
            className="w-full flex-1 py-3.5 px-6 bg-[#252526] hover:bg-[#2e2e30] border border-[#444444] text-white font-semibold rounded-xl text-base flex items-center justify-center gap-2 transition-all hover:scale-[1.02]"
          >
            <Users className="w-5 h-5 text-indigo-400" />
            <span>Join Team</span>
          </button>
        </div>

        {/* Active Rooms Created by Current User (Prominently displayed right under actions) */}
        {currentUser && (createdRooms.length > 0 || loadingCreatedRooms) && (
          <div className="mt-10 w-full text-left space-y-4">
            <div className="flex items-center justify-between border-b border-[#2d2d2d] pb-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-neutral-200 flex items-center gap-2 font-mono">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Your Active Team Rooms (Admin)</span>
              </h2>
              <span className="text-[11px] text-neutral-400 font-mono">
                {createdRooms.length} Active {createdRooms.length === 1 ? 'Room' : 'Rooms'}
              </span>
            </div>

            {loadingCreatedRooms && createdRooms.length === 0 ? (
              <div className="flex items-center gap-2 text-neutral-400 text-xs py-4">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                <span>Loading your rooms...</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {createdRooms.map((room) => (
                  <div
                    key={room.code}
                    onClick={() => onEnterRoom(room.code)}
                    className="group p-4 rounded-xl bg-[#1e1e1e] border border-indigo-500/30 hover:border-indigo-500/80 cursor-pointer transition-all hover:bg-[#242426] flex flex-col justify-between shadow-md"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-bold text-indigo-300 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/30">
                            {room.code}
                          </span>
                          <button
                            onClick={(e) => handleCopyCode(room.code, e)}
                            title="Copy 6-Digit Code"
                            className="text-neutral-400 hover:text-white p-1 rounded hover:bg-[#333333]"
                          >
                            {copiedCode === room.code ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        {/* Admin Delete Room Button */}
                        <button
                          onClick={(e) => handleDeleteCreatedRoom(room.code, room.name, e)}
                          title="Permanently Delete This Room"
                          className="text-neutral-500 hover:text-rose-400 p-1.5 rounded hover:bg-rose-500/10 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <h4 className="font-semibold text-white text-sm truncate">{room.name}</h4>
                      <p className="text-[11px] text-neutral-400 mt-1 flex items-center gap-1.5">
                        <FolderCode className="w-3.5 h-3.5 text-neutral-400" />
                        <span>{room.files?.length || 0} files</span>
                      </p>
                    </div>

                    <div className="mt-4 pt-2 border-t border-[#2d2d2d] flex items-center justify-between text-[11px] text-indigo-400 font-medium">
                      <span className="group-hover:text-indigo-300 flex items-center gap-1">
                        Open Workspace
                        <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
                      </span>
                      <span className="text-[10px] text-emerald-400/90 font-mono">Creator</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Features highlight */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-16 w-full text-left">
          <div className="p-5 rounded-xl bg-[#181818] border border-[#2d2d2d] space-y-2">
            <div className="p-2 w-fit rounded-lg bg-indigo-500/10 text-indigo-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">LocalStorage Cached UI</h3>
            <p className="text-xs text-neutral-400 leading-normal">
              Resources and project files persist directly in your browser. No re-fetching required
              when returning to the site.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-[#181818] border border-[#2d2d2d] space-y-2">
            <div className="p-2 w-fit rounded-lg bg-emerald-500/10 text-emerald-400">
              <Wifi className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">Offline-First CRDT</h3>
            <p className="text-xs text-neutral-400 leading-normal">
              Keep typing when Wi-Fi drops. Yjs merges changes automatically without overwriting or
              losing code.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-[#181818] border border-[#2d2d2d] space-y-2">
            <div className="p-2 w-fit rounded-lg bg-purple-500/10 text-purple-400">
              <Users className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-white text-sm">Real-time Presence</h3>
            <p className="text-xs text-neutral-400 leading-normal">
              Track who is online vs offline in your room, with live collaborator cursors and colored
              labels.
            </p>
          </div>
        </div>
      </main>

      {/* CREATE TEAM MODAL */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl p-6 shadow-2xl space-y-5">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <PlusCircle className="w-5 h-5 text-indigo-400" />
              <span>Create a New Team Room</span>
            </h3>

            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-300">Project / Team Name</label>
                <input
                  type="text"
                  required
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  placeholder="e.g. Hackathon Project"
                  className="w-full mt-1 px-3 py-2 bg-[#252526] border border-[#3c3c3c] rounded-lg text-sm text-white outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-neutral-300">
                    Unique 6-Digit Room Code
                  </label>
                  <button
                    type="button"
                    onClick={() => setGeneratedCode(generateRoomCode())}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-mono"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Regenerate</span>
                  </button>
                </div>
                <div className="mt-1 flex items-center justify-center gap-2 p-3 bg-[#151515] border border-indigo-500/40 rounded-lg">
                  <span className="font-mono text-2xl font-black text-indigo-300 tracking-widest">
                    {generatedCode}
                  </span>
                </div>
                <p className="text-[11px] text-neutral-400 mt-1">
                  Share this 6-digit code with your teammates so they can join and view your uploaded
                  files.
                </p>
              </div>

              <div className="pt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="flex-1 py-2.5 bg-[#252526] hover:bg-[#333333] text-neutral-300 rounded-lg text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreatingRoom}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2"
                >
                  {isCreatingRoom ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Creating Room...</span>
                    </>
                  ) : (
                    <span>Launch Workspace</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* JOIN TEAM MODAL */}
      {isJoinModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[#1e1e1e] border border-[#3c3c3c] rounded-xl p-6 shadow-2xl space-y-5">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Users className="w-5 h-5 text-indigo-400" />
              <span>Join an Existing Team</span>
            </h3>

            <p className="text-xs text-neutral-400">
              Enter the 6-digit capital alphanumeric code provided by your room creator to access
              the workspace and view uploaded files.
            </p>

            <form onSubmit={handleJoinSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-300">6-Digit Room Code</label>
                <input
                  type="text"
                  maxLength={6}
                  autoFocus
                  required
                  placeholder="e.g. K9X2B7"
                  value={joinCode}
                  onChange={(e) => {
                    setJoinCode(e.target.value.toUpperCase());
                    if (joinError) setJoinError(null);
                  }}
                  className="w-full mt-1 px-4 py-3 bg-[#151515] border border-[#3c3c3c] focus:border-indigo-500 rounded-lg font-mono text-center text-xl font-bold tracking-widest text-white outline-none"
                />
              </div>

              {joinError && (
                <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 p-2 rounded">
                  {joinError}
                </div>
              )}

              <div className="pt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsJoinModalOpen(false)}
                  className="flex-1 py-2.5 bg-[#252526] hover:bg-[#333333] text-neutral-300 rounded-lg text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCheckingRoom}
                  className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2"
                >
                  {isCheckingRoom ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Checking...</span>
                    </>
                  ) : (
                    <span>Join Room</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
