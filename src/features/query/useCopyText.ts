import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'failed';

/** Copy to the system clipboard; a missing or rejected clipboard stays visible. */
export function useCopyText(scope = ''): { status: CopyStatus; copy: (text: string) => void } {
  const [result, setResult] = useState<{ scope: string; status: CopyStatus }>({ scope, status: 'idle' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = useRef(0);
  useEffect(() => () => {
    version.current++;
    if (timer.current) clearTimeout(timer.current);
  }, [scope]);
  const copy = useCallback((text: string) => {
    const request = ++version.current;
    const settle = (next: CopyStatus) => {
      if (request !== version.current) return;
      setResult({ scope, status: next });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setResult({ scope, status: 'idle' }), 2400);
    };
    if (!navigator.clipboard?.writeText) { settle('failed'); return; }
    navigator.clipboard.writeText(text).then(() => settle('copied'), () => settle('failed'));
  }, [scope]);
  return { status: result.scope === scope ? result.status : 'idle', copy };
}
