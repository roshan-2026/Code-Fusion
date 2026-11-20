import React from 'react';
import { GitBranch, Terminal, Check, Globe } from 'lucide-react';
import type { SupportedLanguage } from '@hostelcode/shared';

interface StatusBarProps {
  cursorPos: { line: number; col: number };
  activeLanguage: SupportedLanguage;
  onChangeLanguage: (newLang: SupportedLanguage) => void;
  characterCount: number;
}

const ALL_LANGUAGES: { value: SupportedLanguage; label: string }[] = [
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'cpp', label: 'C++' },
  { value: 'java', label: 'Java' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
];

export const StatusBar: React.FC<StatusBarProps> = ({
  cursorPos,
  activeLanguage,
  onChangeLanguage,
  characterCount,
}) => {
  return (
    <footer className="h-6 bg-[#007acc] text-white flex items-center justify-between px-3 text-[11px] select-none shrink-0 font-sans">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 hover:bg-white/10 px-1.5 py-0.5 rounded cursor-pointer">
          <GitBranch className="w-3 h-3" />
          <span>main</span>
        </div>
        <div className="flex items-center gap-1">
          <Check className="w-3 h-3 text-emerald-300" />
          <span>No syntax issues</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="font-mono">
          Ln {cursorPos.line}, Col {cursorPos.col}
        </span>
        <span className="hidden sm:inline">Spaces: 2</span>
        <span className="hidden sm:inline">UTF-8</span>
        <span className="hidden md:inline font-mono text-[10px] text-white/80">
          {characterCount} chars
        </span>

        {/* Language selector */}
        <div className="relative flex items-center gap-1 hover:bg-white/10 px-1.5 py-0.5 rounded cursor-pointer">
          <Globe className="w-3 h-3" />
          <select
            value={activeLanguage}
            onChange={(e) => onChangeLanguage(e.target.value as SupportedLanguage)}
            className="bg-transparent text-white border-none outline-none cursor-pointer font-sans text-[11px] pr-1"
          >
            {ALL_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value} className="bg-[#1e1e1e] text-white">
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="hidden lg:flex items-center gap-1 text-[10px] bg-black/20 px-1.5 py-0.5 rounded">
          <Terminal className="w-3 h-3" />
          <span>HostelCode MVP</span>
        </div>
      </div>
    </footer>
  );
};
