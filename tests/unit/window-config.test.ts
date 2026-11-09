import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs with the project root as the working directory, and the jsdom environment
// rewrites import.meta.url, so paths are resolved from the process directory.
const readJson = (relative: string) => JSON.parse(readFileSync(resolve(process.cwd(), relative), 'utf8'));

const baseConfig = readJson('src-tauri/tauri.conf.json');
const macosConfig = readJson('src-tauri/tauri.macos.conf.json');
const linuxConfig = readJson('src-tauri/tauri.linux.conf.json');
const windowsConfig = readJson('src-tauri/tauri.windows.conf.json');
const capability = readJson('src-tauri/capabilities/main.json');
const configSchema = readJson('node_modules/@tauri-apps/cli/config.schema.json');

const baseWindow = baseConfig.app.windows[0];
const macosWindow = macosConfig.app.windows[0];
const windowProperties: Record<string, { type?: unknown }> = configSchema.definitions.WindowConfig.properties;

// Options such as titleBarStyle are declared through a reference, so the admitted JSON
// types have to be resolved through the schema definitions instead of a single field.
function admittedTypes(property: Record<string, unknown>): string[] {
  const direct = property.type;
  if (typeof direct === 'string') return [direct];
  if (Array.isArray(direct)) return direct.filter((entry): entry is string => typeof entry === 'string');
  const branches = ['allOf', 'anyOf', 'oneOf']
    .flatMap((key) => (property[key] as { $ref?: string }[] | undefined) ?? []);
  return branches.flatMap((branch) => {
    const name = branch.$ref?.split('/').pop();
    if (!name) return admittedTypes(branch as Record<string, unknown>);
    const definition = configSchema.definitions[name];
    return definition ? admittedTypes(definition) : [];
  });
}

// Platform configuration files replace the `windows` array instead of merging it, so every
// contract field has to be repeated. These are the fields the runtime contract depends on.
const CONTRACT_FIELDS = ['label', 'title', 'width', 'height', 'minWidth', 'minHeight', 'visible'] as const;

describe('window configuration', () => {
  it('keeps the main window contract in the base configuration and removes the native frame', () => {
    expect(baseConfig.app.windows).toHaveLength(1);
    expect(baseWindow).toMatchObject({
      label: 'main', title: 'EScope', width: 1440, height: 900,
      minWidth: 1024, minHeight: 700, visible: true, decorations: false,
    });
    expect(baseConfig.app.security.capabilities).toEqual(['main']);
  });

  it('keeps the native traffic lights on macOS through an overlay title bar', () => {
    expect(macosConfig.app.windows).toHaveLength(1);
    expect(macosWindow).toMatchObject({ decorations: true, titleBarStyle: 'Overlay', hiddenTitle: true });
    // The inset centers the traffic lights on the 58px header; window.css reserves the safe
    // area from the same numbers.
    expect(macosWindow.trafficLightPosition).toEqual({ x: 20, y: 29 });
    for (const field of CONTRACT_FIELDS) {
      expect(macosWindow[field]).toEqual(baseWindow[field]);
    }
    expect(macosConfig.app.security).toBeUndefined();
  });

  it('uses only options the bundled Tauri config schema defines', () => {
    const titleBarStyles = configSchema.definitions.TitleBarStyle.oneOf.map((entry: { enum: string[] }) => entry.enum[0]);
    expect(titleBarStyles).toContain(macosWindow.titleBarStyle);
    for (const window of [baseWindow, macosWindow]) {
      for (const [key, value] of Object.entries(window)) {
        const property = windowProperties[key];
        expect(property, `unknown window option: ${key}`).toBeDefined();
        expect(admittedTypes(property!)).toContain(typeof value);
      }
    }
    expect(baseConfig.$schema).toBe('https://schema.tauri.app/config/2');
    expect(macosConfig.$schema).toBe('https://schema.tauri.app/config/2');
  });
});

describe('release bundles', () => {
  // The base configuration never bundles; each platform file opts in to exactly the installer
  // formats the release workflow publishes, and none of them redefines the window or security.
  it('bundles one installer family per platform', () => {
    expect(baseConfig.bundle.active).toBe(false);
    expect(windowsConfig.bundle).toMatchObject({ active: true, targets: ['nsis'] });
    expect(macosConfig.bundle).toEqual({ active: true, targets: ['dmg'] });
    expect(linuxConfig.bundle).toEqual({ active: true, targets: ['deb', 'appimage'] });
    expect(linuxConfig.app).toBeUndefined();
    expect(linuxConfig.$schema).toBe('https://schema.tauri.app/config/2');
  });
});

describe('window capabilities', () => {
  // Exactly the commands the window chrome uses: the injected drag region, the in-app
  // caption buttons and the two state reads. No default permission set is granted.
  const REQUIRED = [
    'core:window:allow-minimize',
    'core:window:allow-toggle-maximize',
    'core:window:allow-close',
    'core:window:allow-is-maximized',
    'core:window:allow-is-fullscreen',
    'core:window:allow-start-dragging',
    'core:window:allow-internal-toggle-maximize',
    'core:event:allow-listen',
    'core:event:allow-unlisten',
  ];

  it('grants the main window exactly the permissions the chrome needs', () => {
    expect(capability.identifier).toBe('main');
    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions).toEqual(REQUIRED);
  });

  it('never widens the grant to a default set, a wildcard or a decoration switch', () => {
    for (const permission of capability.permissions as string[]) {
      expect(permission).not.toMatch(/\*|:default$|^default$|allow-set-decorations/);
    }
  });

  it('does not grant window controls to remote content', () => {
    expect(capability.remote).toBeUndefined();
    expect(capability.local ?? true).toBe(true);
  });
});
