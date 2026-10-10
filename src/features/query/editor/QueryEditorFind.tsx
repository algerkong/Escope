import { ArrowDown, ArrowUp, CaseSensitive, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { editor } from 'monaco-editor/editor/editor.api';
import { IconButton } from '../../../components/controls';

export function QueryEditorFind({ instance, onClose }: {
  instance: editor.IStandaloneCodeEditor; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const model = instance.getModel();
  useSyncExternalStore(useCallback((changed) => {
    const subscription = model?.onDidChangeContent(changed);
    return () => subscription?.dispose();
  }, [model]), () => model && !model.isDisposed() ? model.getVersionId() : 0);
  // Counting is bounded; next/previous still search the entire current model.
  const count = text && model ? model.findMatches(text, false, false, matchCase, null, false, 1001).length : 0;
  const move = (previous: boolean) => {
    if (!model || !text) return;
    const selection = instance.getSelection();
    const position = previous ? selection?.getStartPosition() : selection?.getEndPosition();
    const offset = position ? model.getOffsetAt(position) - (previous ? 1 : 0) : 0;
    const start = model.getPositionAt(offset < 0 ? model.getValueLength() : offset);
    const found = previous ? model.findPreviousMatch(text, start, false, matchCase, null, false)
      : model.findNextMatch(text, start, false, matchCase, null, false);
    if (found) {
      instance.setSelection(found.range);
      instance.revealRangeInCenterIfOutsideViewport(found.range);
    }
  };
  return <div className="query-editor-find" role="search" aria-label={t('query:findDsl')}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); event.stopPropagation(); input.current?.select();
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); move(event.shiftKey);
      }
    }}>
    <input ref={input} type="search" aria-label={t('query:findText')} value={text} maxLength={4096}
      onChange={(event) => setText(event.target.value)} />
    <IconButton icon={CaseSensitive} label={t('query:findMatchCase')} aria-pressed={matchCase}
      onClick={() => setMatchCase((current) => !current)} />
    <span role="status">{t(count > 1000 ? 'query:findMany' : 'query:findCount', { count: Math.min(count, 1000) })}</span>
    <IconButton icon={ArrowUp} label={t('query:findPrevious')} disabled={!count} onClick={() => move(true)} />
    <IconButton icon={ArrowDown} label={t('query:findNext')} disabled={!count} onClick={() => move(false)} />
    <IconButton icon={X} label={t('query:closeFind')} onClick={onClose} />
  </div>;
}
