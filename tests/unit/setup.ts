import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

vi.mock('../../src/features/query/editor/monaco-loader', async () => {
  const { editorRuntime } = await import('./monaco-view-mock');
  return { loadQueryEditor: vi.fn(() => editorRuntime) };
});

afterEach(cleanup);
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});
Element.prototype.scrollIntoView = vi.fn();
