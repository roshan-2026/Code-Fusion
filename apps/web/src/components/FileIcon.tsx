import React from 'react';
import { FileCode, FileJson, FileText } from 'lucide-react';
import type { SupportedLanguage } from '@hostelcode/shared';

interface FileIconProps {
  language: SupportedLanguage;
  className?: string;
}

export const FileIcon: React.FC<FileIconProps> = ({ language, className = 'w-4 h-4' }) => {
  switch (language) {
    case 'typescript':
      return <FileCode className={`${className} text-blue-400`} />;
    case 'javascript':
      return <FileCode className={`${className} text-yellow-400`} />;
    case 'python':
      return <FileCode className={`${className} text-emerald-400`} />;
    case 'cpp':
      return <FileCode className={`${className} text-purple-400`} />;
    case 'java':
      return <FileCode className={`${className} text-rose-400`} />;
    case 'html':
      return <FileCode className={`${className} text-orange-400`} />;
    case 'css':
      return <FileCode className={`${className} text-sky-400`} />;
    case 'json':
      return <FileJson className={`${className} text-amber-300`} />;
    case 'markdown':
      return <FileText className={`${className} text-cyan-300`} />;
    default:
      return <FileText className={`${className} text-neutral-400`} />;
  }
};
