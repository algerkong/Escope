import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'failed';

/** Copy to the system clipboard; a missing or rejected clipboard stays visible. */
export function useCopyText(): { status: CopyStatus; copy: (text: string) => void } {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((text: string) => {
    const settle = (next: CopyStatus) => {
      setStatus(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus('idle'), 2400);
    };
    if (!navigator.clipboard?.writeText) { settle('failed'); return; }
    navigator.clipboard.writeText(text).then(() => settle('copied'), () => settle('failed'));
  }, []);
  return { status, copy };
}
