import { describe, expect, it } from 'vitest';
import canonicalFixture from '../fixtures/preferences-canonical.json';
import legacyFixture from '../fixtures/preferences-legacy.json';
import invalidFixture from '../fixtures/preferences-invalid.json';
import unknownKeyFixture from '../fixtures/preferences-unknown-key.json';
import { defaultPreferences, parsePreferences, requirePreferences } from '../../src/domain/preferences';

/**
 * The fixtures in `tests/fixtures` are the shared wire contract: `storage.rs` includes the same
 * files. A renamed field therefore fails on both sides instead of losing a preference at runtime.
 */
describe('preference wire contract', () => {
  it('round-trips the fixture without dropping or coercing a field', () => {
    expect(parsePreferences(canonicalFixture)).toEqual(canonicalFixture);
    expect(requirePreferences(canonicalFixture)).toEqual(canonicalFixture);
    expect(Object.keys(canonicalFixture).sort()).toEqual(Object.keys(defaultPreferences).sort());
  });

  it('writes the startAI spelling and never the legacy startAi one', () => {
    expect(canonicalFixture.startAI).toBe(true);
    const written = JSON.stringify(requirePreferences(canonicalFixture));
    expect(written).toBe(JSON.stringify(canonicalFixture));
    expect(written).toContain('"startAI":true');
    expect(written).not.toContain('"startAi"');
  });

  it('reads a legacy startAi payload and rewrites it in canonical form', () => {
    expect('startAi' in legacyFixture && !('startAI' in legacyFixture)).toBe(true);
    expect(requirePreferences(legacyFixture)).toEqual(requirePreferences(canonicalFixture));
    expect(JSON.stringify(requirePreferences(legacyFixture))).toBe(JSON.stringify(canonicalFixture));
  });

  it('rejects invalid, unknown and ambiguous payloads instead of defaulting', () => {
    expect(() => requirePreferences(invalidFixture)).toThrow();
    expect(() => requirePreferences(unknownKeyFixture)).toThrow();
    expect(() => requirePreferences({ ...canonicalFixture, uiSize: 99 })).toThrow();
    expect(() => requirePreferences({ ...canonicalFixture, startAI: 'yes' })).toThrow();
    expect(() => requirePreferences({ ...canonicalFixture, tableSize: undefined })).toThrow();
    expect(() => requirePreferences({ ...canonicalFixture, startAi: false })).toThrow();
    expect(() => requirePreferences(null)).toThrow();
  });

  it('keeps parsePreferences as the draft normalizer, not the stored-data boundary', () => {
    expect(parsePreferences({ uiSize: 99 }).uiSize).toBe(14);
    expect(parsePreferences(canonicalFixture)).toEqual(requirePreferences(canonicalFixture));
  });
});
