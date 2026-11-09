import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/domain/app-version';
import { i18n } from '../../src/locales';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('app version', () => {
  // The release workflow refuses a tag whose version differs from these manifests, so the
  // displayed version, the bundle version and the crate version have to move together.
  it('matches the Tauri and Cargo manifests', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(read('src-tauri/tauri.conf.json')).version).toBe(APP_VERSION);
    expect(read('src-tauri/Cargo.toml').split(/\r?\n/)).toContain(`version = "${APP_VERSION}"`);
  });

  it('shows the manifest version in both locales', () => {
    for (const lng of ['en-US', 'zh-CN']) {
      expect(i18n.getFixedT(lng)('settings:about', { version: APP_VERSION })).toBe(`EScope ${APP_VERSION}`);
    }
  });
});
