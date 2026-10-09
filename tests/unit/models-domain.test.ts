import { describe, expect, it } from 'vitest';
import canonicalInput from '../fixtures/models-input-canonical.json';
import canonicalState from '../fixtures/models-state-canonical.json';
import invalidInput from '../fixtures/models-input-invalid.json';
import unknownKeyInput from '../fixtures/models-input-unknown-key.json';
import {
  MAX_MODEL_PROFILES, modelProtocols, normalizeModelEndpoint, requireModelProfile, requireModelsState, resolveDefaultModel,
  sortModels, validateModelInput, type ModelInput, type ModelProfile,
} from '../../src/domain/models';

/**
 * The fixtures in `tests/fixtures` are the shared wire contract: `storage.rs` includes the same
 * files. A renamed field, a new key or another protocol spelling therefore fails on both sides
 * instead of losing a model profile at runtime.
 */
const asInput = (value: unknown) => value as ModelInput;
const [first, second] = canonicalState.profiles as unknown as [ModelProfile, ModelProfile];

describe('model profile wire contract', () => {
  it('normalizes the canonical payload to exactly the four wire fields', () => {
    const clean = validateModelInput(asInput(canonicalInput));
    expect(clean).toEqual(canonicalInput);
    expect(Object.keys(clean).sort()).toEqual(['displayName', 'endpoint', 'modelId', 'protocol']);
    // Both protocol spellings this build knows appear in the shared fixtures, and Rust deserializes
    // those same bytes, so the two enums cannot drift apart.
    expect([...modelProtocols].sort()).toEqual([canonicalInput.protocol, second.protocol].sort());
    expect(Object.keys(unknownKeyInput).sort()).toEqual([...Object.keys(canonicalInput), 'apiKey'].sort());
  });

  it('refuses an unimplemented protocol, a secret in the endpoint and empty values', () => {
    expect(() => validateModelInput(asInput(invalidInput))).toThrow('invalidInput');
    for (const endpoint of [
      'https://user:secret@example.test',
      'https://example.test/?key=secret',
      'https://example.test/#fragment',
      'ftp://example.test',
      'not a url',
    ]) {
      expect(() => validateModelInput({ ...asInput(canonicalInput), endpoint })).toThrow('invalidEndpoint');
    }
    expect(() => validateModelInput({ ...asInput(canonicalInput), displayName: '   ' })).toThrow('invalidName');
    expect(() => validateModelInput({ ...asInput(canonicalInput), displayName: 'n'.repeat(81) })).toThrow('invalidName');
    expect(() => validateModelInput({ ...asInput(canonicalInput), modelId: '' })).toThrow('invalidInput');
    expect(() => validateModelInput({ ...asInput(canonicalInput), modelId: 'm'.repeat(201) })).toThrow('invalidInput');
  });

  it('refuses payloads carrying extra fields and counts limits in code points', () => {
    // A payload with a secret-like extra key is refused instead of being silently stripped,
    // mirroring deny_unknown_fields on the backend.
    expect(Object.keys(unknownKeyInput)).toContain('apiKey');
    expect(() => validateModelInput(asInput(unknownKeyInput))).toThrow('invalidInput');
    // Limits count code points, matching chars().count() on the backend: 80 astral characters
    // (160 UTF-16 units) are accepted, 81 are refused, and the same holds for the model id.
    const astral = '𝄞';
    expect(validateModelInput({ ...asInput(canonicalInput), displayName: astral.repeat(80) }).displayName)
      .toBe(astral.repeat(80));
    expect(() => validateModelInput({ ...asInput(canonicalInput), displayName: astral.repeat(81) })).toThrow('invalidName');
    expect(validateModelInput({ ...asInput(canonicalInput), modelId: astral.repeat(200) }).modelId)
      .toBe(astral.repeat(200));
    expect(() => validateModelInput({ ...asInput(canonicalInput), modelId: astral.repeat(201) })).toThrow('invalidInput');
  });

  it('normalizes the endpoint the same way the backend stores it', () => {
    expect(validateModelInput({ ...asInput(canonicalInput), endpoint: 'http://127.0.0.1:11434/' }).endpoint)
      .toBe('http://127.0.0.1:11434');
    expect(validateModelInput({ ...asInput(canonicalInput), endpoint: ' https://gw.example.test/v1// ' }).endpoint)
      .toBe('https://gw.example.test/v1');
  });

  it('reads the stored state fixture strictly instead of filling gaps with defaults', () => {
    const state = requireModelsState(canonicalState);
    expect(state.profiles).toHaveLength(2);
    expect(state.defaultModelId).toBe(canonicalState.defaultModelId);
    expect(requireModelProfile(state.profiles[1])).toEqual(state.profiles[1]);
    expect(requireModelsState({ profiles: [], defaultModelId: null, credentialCleanupPending: false }))
      .toEqual({ profiles: [], defaultModelId: null, credentialCleanupPending: false });

    const cases: unknown[] = [
      { ...canonicalState, extra: true },
      { ...canonicalState, defaultModelId: 'missing' },
      { ...canonicalState, defaultModelId: null },
      { ...canonicalState, profiles: [{ ...first, apiKey: 'placeholder-not-a-key' }], defaultModelId: first.id },
      { ...canonicalState, profiles: [{ ...first, endpoint: 'https://user:secret@example.test' }], defaultModelId: first.id },
      { ...canonicalState, profiles: [{ ...first, protocol: 'anthropic' }], defaultModelId: first.id },
      { ...canonicalState, profiles: [{ ...first, id: 'not-a-uuid' }], defaultModelId: 'not-a-uuid' },
      { ...canonicalState, profiles: [{ ...first, sortOrder: -1 }], defaultModelId: first.id },
      { ...canonicalState, profiles: [{ ...first, displayName: '' }], defaultModelId: first.id },
      { ...canonicalState, profiles: [first, first], defaultModelId: first.id },
      { ...canonicalState, profiles: Array.from({ length: MAX_MODEL_PROFILES + 1 }, () => first), defaultModelId: first.id },
      { ...canonicalState, profiles: 'none', defaultModelId: null },
      null,
    ];
    for (const value of cases) {
      expect(() => requireModelsState(value), JSON.stringify(value).slice(0, 80)).toThrow();
    }
  });

  it('exposes credential state but never accepts a secret or a credential reference in profiles', () => {
    expect(requireModelProfile(second).hasApiKey).toBe(true);
    expect(requireModelsState({ ...canonicalState, credentialCleanupPending: true }).credentialCleanupPending).toBe(true);
    expect(() => requireModelProfile({ ...second, hasApiKey: 'configured' })).toThrow('invalidModelProfile');
    expect(() => requireModelProfile({ ...second, credentialRef: first.id })).toThrow('invalidModelProfile');
    expect(() => requireModelsState({ ...canonicalState, credentialCleanupPending: 0 })).toThrow('invalidModelsState');
    expect(() => validateModelInput({ ...canonicalInput, hasApiKey: true } as ModelInput)).toThrow('invalidInput');
  });

  it('normalizes custom HTTP/HTTPS discovery endpoints without needing a model ID', () => {
    expect(normalizeModelEndpoint(' http://model.internal:8788/team/v1/ '))
      .toBe('http://model.internal:8788/team/v1');
    expect(normalizeModelEndpoint('https://models.example.test:9443/base/'))
      .toBe('https://models.example.test:9443/base');
    expect(() => normalizeModelEndpoint('http://user:secret@model.internal/v1')).toThrow('invalidEndpoint');
  });

  it('resolves the default selection exactly like the backend', () => {
    expect(resolveDefaultModel([first, second], second.id)).toBe(second.id);
    // A stored id that no longer names a profile falls back to the first profile.
    expect(resolveDefaultModel([first, second], 'deleted-id')).toBe(first.id);
    expect(resolveDefaultModel([first, second], null)).toBe(first.id);
    expect(resolveDefaultModel([], null)).toBeNull();
    expect(resolveDefaultModel([], first.id)).toBeNull();
    // Storage order is the explicit sort order, then the stable id.
    expect(sortModels([second, first]).map((profile) => profile.id)).toEqual([first.id, second.id]);
    expect(sortModels([{ ...second, sortOrder: 0 }, { ...first, sortOrder: 0 }]).map((profile) => profile.id))
      .toEqual([first.id, second.id]);
  });
});
