import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs with the project root as the working directory, so paths resolve from there.
const readJson = (relative: string) => JSON.parse(readFileSync(resolve(process.cwd(), relative), 'utf8'));

const packageJson = readJson('package.json');
const lockfile = readJson('package-lock.json');
const baseConfig = readJson('src-tauri/tauri.conf.json');
const windowsConfig = readJson('src-tauri/tauri.windows.conf.json');
const schema = readJson('node_modules/@tauri-apps/cli/config.schema.json');

const scripts = packageJson.scripts as Record<string, string>;
const windowsBundle = windowsConfig.bundle;
const windowsPlatform = windowsBundle.windows;
const nsis = windowsPlatform.nsis;

const definitionProperties = (definition: string): string[] => Object.keys(schema.definitions[definition].properties);

// Unknown keys make `tauri build` reject the configuration, so every key the Windows file
// adds is checked against the schema shipped with the pinned CLI instead of trusted by name.
function unknownKeys(allowed: string[], value: Record<string, unknown> | undefined, path: string): string[] {
  return Object.entries(value ?? {})
    .filter(([key]) => !allowed.includes(key))
    .map(([key]) => `${path}.${key}`);
}

const enumValues = (definition: string): string[] =>
  (schema.definitions[definition].oneOf as { enum?: string[] }[]).flatMap((branch) => branch.enum ?? []);

const webviewModes = (schema.definitions.WebviewInstallMode.oneOf as
  { properties: Record<string, unknown> & { type: { enum: string[] } } }[]);

describe('windows installer command', () => {
  it('keeps the development executable entry point unbundled', () => {
    // The existing exe workflow must survive the installer addition.
    expect(scripts['build:desktop']).toBe('tauri build --no-bundle');
  });

  it('adds an explicit NSIS installer command that names its platform configuration', () => {
    const command = scripts['build:installer:windows'];
    expect(command).toBeDefined();
    expect(command).toMatch(/^tauri build /);
    expect(command).toMatch(/--bundles(\s+|=)nsis(\s|$)/);
    // The platform file is merged automatically on Windows, but naming it keeps the NSIS
    // settings attached to the command even when the lookup changes or runs cross target.
    expect(command).toMatch(/--config src-tauri\/tauri\.windows\.conf\.json/);
    expect(windowsBundle.targets).toEqual(['nsis']);
  });

  it('does not install, download or require any global tooling', () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)/);
      expect(command, name).not.toMatch(/\b(winget|choco|scoop|msiexec)\b/);
      expect(command, name).not.toMatch(/cargo\s+install/);
    }
    // The bundler ships inside the pinned CLI, so the lockfile stays the only tool source.
    expect(packageJson.devDependencies['@tauri-apps/cli']).toBeDefined();
    expect(lockfile.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(lockfile.packages['node_modules/@tauri-apps/cli']).toBeDefined();
    expect(lockfile.packages[''].devDependencies['@tauri-apps/cli']).toBe(packageJson.devDependencies['@tauri-apps/cli']);
  });
});

describe('windows bundle configuration', () => {
  it('bundles only for windows and leaves the default build unbundled', () => {
    expect(baseConfig.bundle.active).toBe(false);
    expect(windowsBundle.active).toBe(true);
    expect(windowsBundle.targets).toEqual(['nsis']);
    // The installer reuses the icon list of the base configuration.
    expect(baseConfig.bundle.icon.length).toBeGreaterThan(0);
    expect(windowsBundle.icon).toBeUndefined();
  });

  it('keeps the fused title bar window contract of the base configuration', () => {
    // A platform file replaces the whole `windows` array, so redeclaring it here would drop
    // the frameless window that the merged title bar depends on.
    expect(windowsConfig.app).toBeUndefined();
    expect(baseConfig.app.windows[0].decorations).toBe(false);
  });

  it('installs per user and picks the webview2 strategy explicitly', () => {
    expect(nsis.installMode).toBe('currentUser');
    expect(windowsPlatform.webviewInstallMode).toEqual({ type: 'downloadBootstrapper', silent: true });
    expect(windowsPlatform.webviewInstallMode.type).not.toBe('skip');
    expect(nsis.displayLanguageSelector).toBe(false);
    expect(nsis.languages).toEqual(['English', 'SimpChinese']);
    expect(nsis.compression).toBe('lzma');
    expect(nsis.installerIcon).toBe('icons/icon.ico');
  });

  it('uses only options the bundled tauri config schema defines', () => {
    expect(unknownKeys(definitionProperties('BundleConfig'), windowsBundle, 'bundle')).toEqual([]);
    expect(unknownKeys(definitionProperties('WindowsConfig'), windowsPlatform, 'bundle.windows')).toEqual([]);
    expect(unknownKeys(definitionProperties('NsisConfig'), nsis, 'bundle.windows.nsis')).toEqual([]);

    const mode = webviewModes.find((branch) => branch.properties.type.enum[0] === windowsPlatform.webviewInstallMode.type);
    expect(mode).toBeDefined();
    expect(unknownKeys(Object.keys(mode?.properties ?? {}), windowsPlatform.webviewInstallMode,
      'bundle.windows.webviewInstallMode')).toEqual([]);

    for (const target of windowsBundle.targets as string[]) expect(enumValues('BundleType')).toContain(target);
    expect(enumValues('NSISInstallerMode')).toContain(nsis.installMode);
    expect(enumValues('NsisCompression')).toContain(nsis.compression);
  });

  it('stays unsigned instead of faking a signature', () => {
    for (const field of ['certificateThumbprint', 'signCommand', 'timestampUrl', 'digestAlgorithm', 'tsp']) {
      expect(windowsPlatform[field], field).toBeUndefined();
      expect(baseConfig.bundle.windows?.[field], field).toBeUndefined();
    }
    const raw = readFileSync(resolve(process.cwd(), 'src-tauri/tauri.windows.conf.json'), 'utf8');
    expect(raw).not.toMatch(/\.(pfx|p12)\b/i);
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/signtool|notarytool|azure.?sign/i);
    }
  });

  it('keeps the installer version and identifier aligned with the package', () => {
    expect(baseConfig.version).toBe(packageJson.version);
    expect(baseConfig.identifier).toBe('com.escope.desktop');
  });
});
