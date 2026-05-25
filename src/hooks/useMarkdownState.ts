import { useState, useRef, useCallback, useMemo } from "react";

export interface MarkdownState {
  filePath: string | null;
  isDirty: boolean;
  setFilePath: (path: string | null) => void;
  setIsDirty: (dirty: boolean) => void;
  getCachedMarkdown: () => string;
  primeMarkdown: (value: string) => void;
}

export function useMarkdownState(): MarkdownState {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const markdownRef = useRef<string>("");

  const primeMarkdown = useCallback((value: string) => {
    markdownRef.current = value;
  }, []);

  const getCachedMarkdown = useCallback(() => markdownRef.current, []);

  return useMemo(() => ({
    filePath,
    isDirty,
    setFilePath,
    setIsDirty,
    getCachedMarkdown,
    primeMarkdown,
  }), [filePath, getCachedMarkdown, isDirty, primeMarkdown]);
}
