import React, { useState, useRef, useEffect } from 'react';
import { Send, MessageCircle, Smile, Sparkles, CheckCheck } from 'lucide-react';
import type { ChatMessage, AuthUser, RoomMember } from '@hostelcode/shared';

interface ChatPanelProps {
  roomCode: string;
  roomName?: string;
  messages: ChatMessage[];
  currentUser: AuthUser;
  members: RoomMember[];
  onSendMessage: (content: string) => void;
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatMessageDateSeparator(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

const QUICK_EMOJIS = ['❤️', '🔥', '👍', '🚀', '🎉', '💯'];

export const ChatPanel: React.FC<ChatPanelProps> = ({
  roomCode,
  roomName,
  messages,
  currentUser,
  members,
  onSendMessage,
}) => {
  const [inputText, setInputText] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onlineMembersCount = members.filter((m) => m.isOnline).length;

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setInputText('');
    setShowEmojis(false);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const addEmoji = (emoji: string) => {
    setInputText((prev) => prev + emoji);
    setShowEmojis(false);
    inputRef.current?.focus();
  };

  return (
    <div className="flex-1 flex flex-col select-none overflow-hidden bg-[#181818] border-r border-[#333333]">
      {/* Instagram Direct Header */}
      <div className="h-14 px-3.5 flex items-center justify-between border-b border-[#2d2d2d] bg-[#1a1a1a]/90 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-2.5 truncate">
          {/* Gradient Ring Avatar */}
          <div className="relative shrink-0">
            <div className="w-9 h-9 rounded-full p-[2px] bg-gradient-to-tr from-amber-500 via-pink-500 to-purple-600 shadow-md">
              <div className="w-full h-full rounded-full bg-[#1e1e1e] flex items-center justify-center text-white">
                <MessageCircle className="w-4 h-4 text-pink-400" />
              </div>
            </div>
            {onlineMembersCount > 0 && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-[#181818]" />
            )}
          </div>

          <div className="flex flex-col truncate">
            <div className="flex items-center gap-1.5 truncate">
              <span className="text-xs font-bold text-white tracking-wide truncate">
                {roomName || 'Team Chat'}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-pink-500/10 text-pink-400 border border-pink-500/20 shrink-0">
                #{roomCode}
              </span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-neutral-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{onlineMembersCount} active now</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] font-medium text-neutral-400 px-2 py-0.5 rounded-md bg-[#252525] border border-[#383838]">
            Direct
          </span>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 custom-scrollbar flex flex-col">
        {messages.length === 0 ? (
          <div className="my-auto py-8 px-4 text-center flex flex-col items-center select-none">
            {/* Instagram Style Empty State Icon */}
            <div className="w-16 h-16 rounded-full p-[2px] bg-gradient-to-tr from-purple-500 via-pink-500 to-rose-400 mb-3 shadow-lg flex items-center justify-center">
              <div className="w-full h-full rounded-full bg-[#1e1e1e] flex items-center justify-center">
                <Sparkles className="w-7 h-7 text-pink-400" />
              </div>
            </div>
            <h4 className="text-sm font-semibold text-white mb-1">Collab Direct</h4>
            <p className="text-xs text-neutral-400 max-w-[210px] leading-relaxed mb-3">
              Real-time team chat with instant sync. All messages are saved permanently across sessions.
            </p>
            <div className="flex gap-1.5">
              {QUICK_EMOJIS.slice(0, 4).map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => addEmoji(emoji)}
                  className="w-8 h-8 rounded-full bg-[#262626] hover:bg-[#333333] border border-[#3c3c3c] text-sm flex items-center justify-center transition-transform hover:scale-110 active:scale-95 cursor-pointer"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isMe = msg.userId === currentUser.id;
            const prevMsg = index > 0 ? messages[index - 1] : null;
            const isFirstOfGroup = !prevMsg || prevMsg.userId !== msg.userId;
            const showDateSeparator =
              !prevMsg ||
              new Date(prevMsg.timestamp).toDateString() !== new Date(msg.timestamp).toDateString();

            return (
              <React.Fragment key={msg.id}>
                {showDateSeparator && (
                  <div className="flex items-center justify-center my-2">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500 bg-[#222222] px-2.5 py-0.5 rounded-full border border-[#2d2d2d]">
                      {formatMessageDateSeparator(msg.timestamp)}
                    </span>
                  </div>
                )}

                <div
                  className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} ${
                    isFirstOfGroup ? 'mt-2' : 'mt-0.5'
                  }`}
                >
                  {/* Sender Name for received messages */}
                  {!isMe && isFirstOfGroup && (
                    <div className="flex items-center gap-1.5 mb-1 ml-9">
                      <span
                        className="text-[11px] font-bold tracking-tight"
                        style={{ color: msg.userColor || '#6366F1' }}
                      >
                        {msg.userName}
                      </span>
                    </div>
                  )}

                  <div className={`flex items-end gap-1.5 max-w-[85%] ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
                    {/* Peer Avatar */}
                    {!isMe && (
                      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold text-white shadow-sm"
                        style={{
                          backgroundColor: msg.userColor || '#6366F1',
                          visibility: isFirstOfGroup ? 'visible' : 'hidden',
                        }}
                        title={msg.userName}
                      >
                        {msg.userName.charAt(0).toUpperCase()}
                      </div>
                    )}

                    {/* Instagram Message Bubble */}
                    <div
                      className={`group relative px-3.5 py-2 text-sm leading-relaxed transition-all shadow-sm ${
                        isMe
                          ? 'bg-gradient-to-tr from-[#6366F1] via-[#7C3AED] to-[#DB2777] text-white rounded-2xl rounded-br-xs'
                          : 'bg-[#262626] text-neutral-100 border border-[#333333] hover:border-[#444444] rounded-2xl rounded-bl-xs'
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words select-text font-sans text-[13px]">
                        {msg.content}
                      </p>

                      {/* Small inline / hover timestamp */}
                      <div
                        className={`text-[9px] mt-0.5 flex items-center gap-1 ${
                          isMe ? 'text-pink-200 justify-end' : 'text-neutral-400 justify-start'
                        }`}
                      >
                        <span>{formatMessageTime(msg.timestamp)}</span>
                        {isMe && <CheckCheck className="w-3 h-3 text-pink-200 stroke-[2.5]" />}
                      </div>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick Emojis Bar (Collapsible) */}
      {showEmojis && (
        <div className="px-3 py-1.5 bg-[#1f1f1f] border-t border-[#2d2d2d] flex items-center justify-around animate-in fade-in duration-150">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => addEmoji(emoji)}
              className="text-base p-1 hover:scale-125 transition-transform cursor-pointer"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {/* Instagram Direct Bottom Input Bar */}
      <div className="p-2.5 border-t border-[#2d2d2d] bg-[#1a1a1a]/95 shrink-0">
        <div className="flex items-center gap-1.5 bg-[#262626] border border-[#383838] focus-within:border-pink-500/70 focus-within:ring-1 focus-within:ring-pink-500/20 rounded-full px-3 py-1 transition-all">
          {/* Quick Emoji Button */}
          <button
            type="button"
            onClick={() => setShowEmojis((prev) => !prev)}
            className={`p-1 rounded-full transition-colors ${
              showEmojis ? 'text-pink-400' : 'text-neutral-400 hover:text-neutral-200'
            }`}
            title="Add Emoji"
          >
            <Smile className="w-4 h-4" />
          </button>

          {/* Text Input */}
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            className="flex-1 bg-transparent border-none text-[13px] text-white placeholder-neutral-500 focus:outline-none py-1 select-text"
          />

          {/* Instagram Style Send Button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim()}
            className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
              inputText.trim()
                ? 'bg-gradient-to-tr from-purple-500 to-pink-500 text-white shadow-md shadow-pink-500/20 cursor-pointer hover:scale-105 active:scale-95'
                : 'text-neutral-600 cursor-not-allowed opacity-40'
            }`}
            title="Send"
          >
            <Send className="w-3.5 h-3.5 translate-x-[0.5px]" />
          </button>
        </div>
      </div>
    </div>
  );
};
