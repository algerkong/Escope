import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiMarkdown } from '../../src/features/ai/AiMarkdown';
import { i18n } from '../../src/locales';
import { enAiChat, zhAiChat } from '../../src/locales/ai-chat';
import { enLive, zhLive } from '../../src/locales/query-live';

i18n.addResourceBundle('zh-CN', 'aiChat', zhAiChat);
i18n.addResourceBundle('en-US', 'aiChat', enAiChat);
i18n.addResourceBundle('zh-CN', 'queryLive', zhLive);
i18n.addResourceBundle('en-US', 'queryLive', enLive);

function view(content: string) {
  return render(<I18nextProvider i18n={i18n}><AiMarkdown content={content} /></I18nextProvider>);
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('ai markdown rendering', () => {
  it('renders GFM headings, emphasis, tables, task lists and inline code', () => {
    const v = render(<I18nextProvider i18n={i18n}><AiMarkdown content={[
      '# 标题',
      '',
      '**加粗** 和 `code`',
      '',
      '~~删除~~',
      '',
      '- [x] 完成',
      '- [ ] 未完成',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n')} /></I18nextProvider>);
    expect(screen.getByRole('heading', { name: '标题' })).toBeInTheDocument();
    expect(screen.getByText('加粗').tagName).toBe('STRONG');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByText('删除').tagName).toBe('DEL');
    expect(v.container.querySelector('table')).toBeTruthy();
    expect(v.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    // Task list boxes are disabled: they are display only, never controls.
    v.container.querySelectorAll('input[type="checkbox"]').forEach((box) => expect(box).toBeDisabled());
  });

  it('skips raw HTML entirely and never executes it', () => {
    const v = view('前 <script>window.__pwned = 1</script> <iframe src="https://x.test"></iframe> <img src=x onerror="window.__pwned = 2"> 后');
    expect(v.container.querySelector('script')).toBeNull();
    expect(v.container.querySelector('iframe')).toBeNull();
    expect(v.container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(v.container.textContent).toContain('前');
    expect(v.container.textContent).toContain('后');
  });

  it('replaces images with alt text and never fetches an asset', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const v = view('![架构图](https://img.test/diagram.png "title")');
    expect(v.container.querySelector('img')).toBeNull();
    expect(screen.getByText('图片未加载：架构图')).toBeInTheDocument();
    // No element may reference the remote asset at all.
    expect(v.container.innerHTML).not.toContain('img.test');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders https links as safe new-tab anchors and keeps other schemes as text', () => {
    const v = view('[文档](https://example.com/a) [危险](javascript:alert(1)) [相对](./local.md)');
    const anchor = screen.getByRole('link', { name: '文档' });
    expect(anchor).toHaveAttribute('href', 'https://example.com/a');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(v.container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByText('危险').tagName).toBe('SPAN');
    expect(screen.getByText('相对').tagName).toBe('SPAN');
  });

  it('copies a fenced code block byte-exactly with the code copy tool', async () => {
    // userEvent.setup() installs its own clipboard stub, so the mock must replace it afterwards.
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const code = '{\n  "query": { "match_all": {} }\n}';
    view(`示例：\n\n\`\`\`json\n${code}\n\`\`\``);
    expect(screen.getByText('json')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '复制代码' }));
    expect(writeText).toHaveBeenCalledWith(code);
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('reveals a clipboard failure instead of pretending the copy worked', async () => {
    const user = userEvent.setup();
    // Replace user-event's clipboard stub with an unavailable clipboard.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    view('```\ncode\n```');
    await user.click(screen.getByRole('button', { name: '复制代码' }));
    expect(await screen.findByText('复制失败，请手动选择文本复制。')).toBeInTheDocument();
  });

  it('renders code content as text without executing it', () => {
    const v = view('```js\nalert("x")\n```');
    expect(screen.getByText('alert("x")')).toBeInTheDocument();
    expect(v.container.querySelector('script')).toBeNull();
  });
});
