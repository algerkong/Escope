import type { editor, IDisposable } from 'monaco-editor/editor/editor.api';

export interface QueryCompletionLabels {
  readonly title: string;
  readonly empty: string;
  readonly loading: string;
  readonly field: string;
  readonly parameter: string;
}

const originals = new WeakMap<Element, { source: string; displayed: string }>();

/** The pinned Monaco widget freezes empty/loading strings at module load; locale changes
 * update only this view's text/accessibility labels, never its model or suggestion data. */
export function localizeQueryCompletionWidget(instance: editor.IStandaloneCodeEditor, labels: QueryCompletionLabels): IDisposable {
  const root = instance.getDomNode();
  if (!root) return { dispose() {} };
  const translate = (element: Element, attribute: string | null, render: (source: string) => string) => {
    const current = (attribute ? element.getAttribute(attribute) : element.textContent) ?? '';
    const previous = originals.get(element);
    const source = current === previous?.displayed ? previous.source : current;
    const displayed = render(source);
    originals.set(element, { source, displayed });
    if (current === displayed) return;
    if (attribute) element.setAttribute(attribute, displayed);
    else element.textContent = displayed;
  };
  const update = () => {
    const widget = root.querySelector('.suggest-widget');
    if (!widget) return;
    const message = widget.querySelector('.message');
    if (message) translate(message, null, (text) => text === 'No suggestions.' ? labels.empty : text === 'Loading...' ? labels.loading : text);
    const list = widget.querySelector('[role="listbox"]');
    if (list) translate(list, 'aria-label', () => labels.title);
    for (const row of widget.querySelectorAll('.monaco-list-row[aria-label]')) {
      translate(row, 'aria-label', (text) => text.replace(/, (Field|Variable)$/, (_match, kind: string) =>
        `, ${kind === 'Field' ? labels.field : labels.parameter}`));
    }
  };
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
  update();
  return { dispose: () => observer.disconnect() };
}
