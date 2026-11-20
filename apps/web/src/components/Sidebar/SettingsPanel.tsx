import React from 'react';
import type { EditorSettings } from '../../types/workspace';

interface SettingsPanelProps {
  settings: EditorSettings;
  onUpdateSettings: (newSettings: Partial<EditorSettings>) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onUpdateSettings }) => {
  return (
    <div className="flex-1 flex flex-col select-none overflow-hidden bg-[#1e1e1e]">
      <div className="h-9 px-3 flex items-center border-b border-[#3c3c3c] text-[11px] font-bold tracking-wider uppercase text-neutral-400">
        Editor Settings
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs text-neutral-300">
        {/* Font Size */}
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <label className="font-medium">Font Size</label>
            <span className="text-neutral-400 font-mono">{settings.fontSize}px</span>
          </div>
          <input
            type="range"
            min="10"
            max="24"
            step="1"
            value={settings.fontSize}
            onChange={(e) => onUpdateSettings({ fontSize: parseInt(e.target.value, 10) })}
            className="w-full accent-indigo-500 cursor-pointer"
          />
        </div>

        {/* Minimap */}
        <div className="flex items-center justify-between pt-2 border-t border-[#3c3c3c]">
          <div>
            <div className="font-medium">Code Minimap</div>
            <div className="text-[11px] text-neutral-500">Show overview preview on the right</div>
          </div>
          <input
            type="checkbox"
            checked={settings.minimap}
            onChange={(e) => onUpdateSettings({ minimap: e.target.checked })}
            className="w-4 h-4 accent-indigo-500 rounded cursor-pointer"
          />
        </div>

        {/* Word Wrap */}
        <div className="flex items-center justify-between pt-2 border-t border-[#3c3c3c]">
          <div>
            <div className="font-medium">Word Wrap</div>
            <div className="text-[11px] text-neutral-500">Wrap long lines of text</div>
          </div>
          <button
            onClick={() =>
              onUpdateSettings({ wordWrap: settings.wordWrap === 'on' ? 'off' : 'on' })
            }
            className={`px-2.5 py-1 rounded text-[11px] font-mono border ${
              settings.wordWrap === 'on'
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-[#252526] border-[#3c3c3c] text-neutral-400'
            }`}
          >
            {settings.wordWrap.toUpperCase()}
          </button>
        </div>

        {/* Line Numbers */}
        <div className="flex items-center justify-between pt-2 border-t border-[#3c3c3c]">
          <div>
            <div className="font-medium">Line Numbers</div>
            <div className="text-[11px] text-neutral-500">Display gutter line numbers</div>
          </div>
          <button
            onClick={() =>
              onUpdateSettings({ lineNumbers: settings.lineNumbers === 'on' ? 'off' : 'on' })
            }
            className={`px-2.5 py-1 rounded text-[11px] font-mono border ${
              settings.lineNumbers === 'on'
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-[#252526] border-[#3c3c3c] text-neutral-400'
            }`}
          >
            {settings.lineNumbers.toUpperCase()}
          </button>
        </div>
      </div>
    </div>
  );
};
