import { Copy } from 'lucide-react';
import { isValidElement, memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconButton } from '../../components/controls';
import { useCopyText } from '../query/useCopyText';

/**
 * Safe Markdown for model output.
 *
 * GFM (tables, strikethrough, task lists) is enabled; raw HTML is skipped entirely, so neither
 * `<script>`, `<iframe>` nor event-handler attributes can appear. Images never render as `<img>`:
 * markdown images become a text placeholder with their alt text, so no asset is fetched. Links
 * are limited to `http(s)` and open without an opener; any other scheme (e.g. `javascript:`) is
 * rendered as plain text. Code blocks carry a copy tool and are never executed.
 */
const allowedElements = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'a', 'img', 'input',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'sup',
];

/** The flattened text of a React node tree; used to copy a code block byte-exactly. */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** The `language-*` class remark puts on a fenced code block, if any. */
function languageOf(node: ReactNode): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = languageOf(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (isValidElement<{ className?: string }>(node)) {
    const match = /(?:^|\s)language-([\w-]+)/.exec(node.props.className ?? '');
    return match?.[1] ?? null;
  }
  return null;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const { status, copy } = useCopyText();
  // remark-rehype terminates a code block's text with a newline; strip one so the shown and
  // copied code has no phantom trailing blank line.
  const text = textOf(children).replace(/\n$/, '');
  const language = languageOf(children);
  return <div className="ai-code">
    <div className="ai-code-head">
      {language !== null ? <span className="ai-code-lang">{language}</span> : null}
      <IconButton icon={Copy} label={t('aiChat:copyCode')} onClick={() => copy(text)} />
      {status !== 'idle' ? <span className={`ai-copy-note ${status}`} role="status">
        {t(status === 'copied' ? 'queryLive:copied' : 'queryLive:copyFailed')}</span> : null}
    </div>
    <pre>{text}</pre>
  </div>;
}

/** Only http(s) links become real links; everything else stays text. */
function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) {
    return <span className="ai-md-link">{children}</span>;
  }
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

/** A markdown image is announced as text; the browser never loads it. */
function SafeImage({ alt }: { alt?: string | null }) {
  const { t } = useTranslation();
  const label = alt?.trim();
  return <span className="ai-md-image">
    {label ? t('aiChat:imageNotShownAlt', { alt: label }) : t('aiChat:imageNotShown')}</span>;
}

/** Memoized on the raw text: unchanged turns never reparse, streaming only reruns the tail. */
export const AiMarkdown = memo(function AiMarkdown({ content }: { content: string }) {
  return <Markdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    allowedElements={allowedElements}
    components={{ pre: CodeBlock, a: SafeLink, img: SafeImage }}
  >{content}</Markdown>;
});
