import { describe, expect, it } from 'vitest';
import { enModels, zhModels } from '../../src/locales/models';

/** Product names stay identical in both languages; everything else must be translated. */
const sameInBothLanguages = new Set(['protocolOllama']);

describe('models locale bundle', () => {
  it('defines the same non-empty, translated keys in both languages', () => {
    const enKeys = Object.keys(enModels).sort();
    expect(Object.keys(zhModels).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      const en = enModels[key as keyof typeof enModels];
      const zh = zhModels[key as keyof typeof zhModels];
      expect(en.trim(), key).not.toBe('');
      expect(zh.trim(), key).not.toBe('');
      if (!sameInBothLanguages.has(key)) {
        expect(zh, key).not.toBe(en);
      }
    }
  });
});
