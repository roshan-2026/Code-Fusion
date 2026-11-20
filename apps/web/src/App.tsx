import React, { useState, useEffect } from 'react';
import { HomePage } from './components/Home/HomePage';
import { Workspace } from './components/Workspace';
import { getCurrentUser, setCurrentUser } from './lib/auth';
import { fetchRoomWithCache, saveRoomLocally } from './lib/roomStorage';
import type { AuthUser, Room } from '@hostelcode/shared';
import { Loader2 } from 'lucide-react';
import { AuthModal } from './components/Auth/AuthModal';

export const App: React.FC = () => {
  const [currentUser, setCurrentUserState] = useState<AuthUser | null>(() => getCurrentUser());
  const [currentRoom, setCurrentRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingRoomCode, setPendingRoomCode] = useState<string | null>(null);
  const [isAuthOpen, setIsAuthOpen] = useState<boolean>(false);

  // Read URL query parameter "?room=CODE" on initial mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room') || window.location.hash.replace('#', '');

    if (roomParam) {
      const code = roomParam.trim().toUpperCase();
      if (!currentUser) {
        setPendingRoomCode(code);
        setIsAuthOpen(true);
        setLoading(false);
      } else {
        loadRoomByCode(code, currentUser);
      }
    } else {
      setLoading(false);
    }
  }, []);

  const loadRoomByCode = async (code: string, user: AuthUser) => {
    setLoading(true);
    setLoadError(null);

    try {
      const room = await fetchRoomWithCache(code, user);
      if (room) {
        setCurrentRoom(room);
        window.history.replaceState({}, '', `/?room=${code}`);
      } else {
        // Room not found on server or locally: create fresh room for that code
        const fallbackRoom: Room = {
          code,
          name: `Team Room (${code})`,
          creatorId: user.id,
          creatorName: user.name,
          creatorEmail: user.email,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          files: [], // Empty files: user creates or uploads real files
        };
        saveRoomLocally(fallbackRoom);
        setCurrentRoom(fallbackRoom);
        window.history.replaceState({}, '', `/?room=${code}`);
      }
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load room');
    } finally {
      setLoading(false);
    }
  };

  const handleEnterRoom = (roomCode: string) => {
    if (!currentUser) {
      setPendingRoomCode(roomCode);
      setIsAuthOpen(true);
      return;
    }
    loadRoomByCode(roomCode, currentUser);
  };

  const handleLeaveRoom = () => {
    setCurrentRoom(null);
    window.history.replaceState({}, '', '/');
  };

  const handleUserChange = (user: AuthUser | null) => {
    setCurrentUser(user);
    setCurrentUserState(user);
  };

  const handleAuthSuccess = (user: AuthUser) => {
    handleUserChange(user);
    setIsAuthOpen(false);
    if (pendingRoomCode) {
      const code = pendingRoomCode;
      setPendingRoomCode(null);
      loadRoomByCode(code, user);
    }
  };

  if (loading) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#121212] text-neutral-300 gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="font-mono text-sm">Loading HostelCode Workspace...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#121212] text-neutral-300 gap-4 p-6">
        <div className="text-rose-400 font-semibold">{loadError}</div>
        <button
          onClick={() => {
            setLoadError(null);
            handleLeaveRoom();
          }}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium"
        >
          Return to Homepage
        </button>
      </div>
    );
  }

  if (currentRoom && currentUser) {
    return (
      <Workspace
        room={currentRoom}
        currentUser={currentUser}
        onLeaveRoom={handleLeaveRoom}
      />
    );
  }

  return (
    <>
      <HomePage
        currentUser={currentUser}
        onUserChange={handleUserChange}
        onEnterRoom={handleEnterRoom}
      />
      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => {
          setIsAuthOpen(false);
          setPendingRoomCode(null);
        }}
        onSuccess={handleAuthSuccess}
      />
    </>
  );
};

export default App;
