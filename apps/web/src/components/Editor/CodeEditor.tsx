import React, { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as monacoEditor from 'monaco-editor';
import type { WorkspaceFile, EditorSettings } from '../../types/workspace';
import { Loader2 } from 'lucide-react';

interface CodeEditorProps {
  file: WorkspaceFile;
  settings: EditorSettings;
  onChangeContent?: (fileId: string, newContent: string) => void;
  onCursorChange: (line: number, col: number) => void;
  onMountEditor?: (editor: monacoEditor.editor.IStandaloneCodeEditor) => void;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({
  file,
  settings,
  onCursorChange,
  onMountEditor,
}) => {
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Force LF line endings across all platforms (Windows/Linux/Mac)
    const model = editor.getModel();
    if (model) {
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
    }

    if (onMountEditor) {
      onMountEditor(editor);
    }

    // Set VS Code dark theme styling
    monaco.editor.defineTheme('hostelcode-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6A9955' },
        { token: 'keyword', foreground: 'C586C0' },
        { token: 'identifier', foreground: '9CDCFE' },
        { token: 'string', foreground: 'CE9178' },
        { token: 'number', foreground: 'B5CEA8' },
      ],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editorLineNumber.foreground': '#5a5a5a',
        'editorLineNumber.activeForeground': '#c6c6c6',
        'editor.lineHighlightBackground': '#282828',
        'editorCursor.foreground': '#aeafad',
      },
    });
    monaco.editor.setTheme('hostelcode-dark');

    // Track cursor updates
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange(e.position.lineNumber, e.position.column);
    });

    // Initial position
    const pos = editor.getPosition();
    if (pos) {
      onCursorChange(pos.lineNumber, pos.column);
    }
  };

  return (
    <div className="flex-1 w-full h-full relative overflow-hidden bg-[#1e1e1e]">
      <Editor
        key={file.id}
        height="100%"
        width="100%"
        theme="vs-dark"
        language={file.language}
        defaultValue=""
        onMount={handleEditorDidMount}
        loading={
          <div className="h-full w-full flex items-center justify-center bg-[#1e1e1e] text-neutral-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
            <span className="text-xs font-mono">Loading Monaco Editor...</span>
          </div>
        }
        options={{
          fontSize: settings.fontSize,
          minimap: { enabled: settings.minimap },
          wordWrap: settings.wordWrap,
          lineNumbers: settings.lineNumbers,
          tabSize: settings.tabSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          fontFamily: "'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'all',
          padding: { top: 10, bottom: 10 },
        }}
      />
    </div>
  );
};
