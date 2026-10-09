import { describe, expect, it } from 'vitest';
import { aiSpecificCodes } from '../../src/features/ai/error-text';
import { enAiChat, zhAiChat } from '../../src/locales/ai-chat';

describe('aiChat locale bundle', () => {
  it('defines the same non-empty, distinct keys in both languages', () => {
    const enKeys = Object.keys(enAiChat).sort();
    const zhKeys = Object.keys(zhAiChat).sort();
    expect(zhKeys).toEqual(enKeys);
    for (const key of enKeys) {
      const en = enAiChat[key as keyof typeof enAiChat];
      const zh = zhAiChat[key as keyof typeof zhAiChat];
      expect(en.trim(), key).not.toBe('');
      expect(zh.trim(), key).not.toBe('');
      // A copied English string would leave Chinese users with an untranslated panel.
      expect(zh, key).not.toBe(en);
    }
  });

  it('has bilingual text for every AI-specific failure code', () => {
    for (const code of aiSpecificCodes) {
      expect(enAiChat[code], code).toBeTruthy();
      expect(zhAiChat[code], code).toBeTruthy();
    }
  });
});
