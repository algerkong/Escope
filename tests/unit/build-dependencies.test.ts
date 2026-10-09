import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { MappingItem, RawSourceMap } from 'source-map-js';
import { describe, expect, it } from 'vitest';

interface PackageEntry {
  version: string;
  dev?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const root = process.cwd();
const projectRequire = createRequire(resolve(root, 'package.json'));
const cliRequire = createRequire(projectRequire.resolve('@tailwindcss/cli/package.json'));
const watcher = cliRequire('@parcel/watcher') as typeof import('@parcel/watcher');
const watcherPackage = cliRequire('@parcel/watcher/package.json') as PackageEntry;
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, PackageEntry>;
};

describe('build dependency security', () => {
  it('does not retain the vulnerable micromatch and braces chain in the lockfile', () => {
    const vulnerablePaths = Object.keys(lock.packages).filter((path) =>
      /(?:^|\/)node_modules\/(?:micromatch|braces)$/.test(path));
    expect(vulnerablePaths).toEqual([]);
    expect(watcherPackage.dependencies?.micromatch).toBeUndefined();
    expect(watcherPackage.dependencies?.picomatch).toBeDefined();
  });

  it('keeps every optional watcher binary aligned with the overridden package', () => {
    const binaries = Object.entries(watcherPackage.optionalDependencies ?? {});
    expect(binaries.length).toBeGreaterThan(0);
    for (const [name, version] of binaries) {
      expect(version, name).toBe(watcherPackage.version);
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
    expect(lock.packages['node_modules/@parcel/watcher']?.dev).toBe(true);
    expect(lock.packages['node_modules/source-map-js']?.dev).toBe(true);
  });

  it('keeps native snapshot reads and path/brace-glob ignores working', async () => {
    const temporaryRoot = realpathSync(tmpdir());
    const directory = mkdtempSync(join(temporaryRoot, 'escope-build-deps-'));
    try {
      const watched = join(directory, 'watched');
      mkdirSync(join(watched, 'nested'), { recursive: true });
      mkdirSync(join(watched, 'vendor'));
      const snapshot = join(directory, 'snapshot');
      const options = { backend: 'brute-force' as const, ignore: ['**/*.{tmp,log}', 'vendor'] };
      await watcher.writeSnapshot(watched, snapshot, options);

      for (const file of ['keep.css', 'nested/keep.ts', 'nested/.hidden.tmp', 'nested/debug.log', 'vendor/ignored.ts']) {
        writeFileSync(join(watched, file), 'fixture\n');
      }
      const events = await watcher.getEventsSince(watched, snapshot, options);
      const created = events.filter((event) => event.type === 'create')
        .map((event) => relative(watched, event.path).replaceAll('\\', '/')).sort();
      expect(created).toEqual(['keep.css', 'nested/keep.ts']);
    } finally {
      const target = realpathSync(directory);
      expect(dirname(target)).toBe(temporaryRoot);
      expect(basename(target)).toMatch(/^escope-build-deps-/);
      rmSync(target, { recursive: true, force: true });
    }
  });
});

const sourceMapConsumers = ['postcss', '@tailwindcss/node'] as const;
const flatMap = {
  version: 3,
  file: 'part.css',
  sources: ['input.css'],
  names: [],
  mappings: 'AAAA',
  sourcesContent: ['.test { display: grid; }\n'],
};
const indexedMap = (line: unknown, column: unknown, map: unknown = flatMap) => ({
  version: 3,
  sections: [{ offset: { line, column }, map }],
});

describe.each(sourceMapConsumers)('%s source-map dependency', (consumer) => {
  const consumerRequire = createRequire(projectRequire.resolve(consumer));
  const { SourceMapConsumer, SourceMapGenerator } = consumerRequire('source-map-js') as typeof import('source-map-js');
  // The library accepts indexed maps, but its declarations only describe flat maps.
  const parse = (map: unknown) => new SourceMapConsumer(map as RawSourceMap);

  it('preserves flat mappings, line gaps and source content through serialization', () => {
    const parsed = parse(flatMap);
    const generated = SourceMapGenerator.fromSourceMap(parsed);
    generated.addMapping({ generated: { line: 5, column: 0 }, original: { line: 1, column: 0 }, source: 'input.css' });
    const restored = new SourceMapConsumer(generated.toJSON());
    for (const line of [1, 5]) {
      expect(restored.originalPositionFor({ line, column: 0 })).toEqual({
        source: 'input.css', line: 1, column: 0, name: null,
      });
    }
    expect(restored.sourceContentFor('input.css')).toBe(flatMap.sourcesContent[0]);
  });

  it('reads normal indexed offsets and source content', () => {
    const parsed = parse(indexedMap(2, 0));
    const mappings: MappingItem[] = [];
    parsed.eachMapping((mapping) => mappings.push(mapping));
    expect(mappings).toEqual([{
      source: 'input.css', generatedLine: 3, generatedColumn: 0, originalLine: 1, originalColumn: 0, name: null,
    }]);
    expect(parsed.sources).toEqual(['input.css']);
    expect(parsed.sourceContentFor('input.css')).toBe(flatMap.sourcesContent[0]);
  });

  it.each([
    { name: 'oversized line', line: 10_000_001, column: 0 },
    { name: 'infinite line', line: Infinity, column: 0 },
    { name: 'NaN line', line: NaN, column: 0 },
    { name: 'negative line', line: -1, column: 0 },
    { name: 'fractional line', line: 0.5, column: 0 },
    { name: 'string line', line: '0', column: 0 },
    { name: 'negative column', line: 0, column: -1 },
    { name: 'fractional column', line: 0, column: 0.5 },
    { name: 'unsafe column', line: 0, column: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects $name before generating an amplified source map', ({ line, column }) => {
    expect(() => parse(indexedMap(line, column))).toThrow(/Section offset/);
  });

  it('rejects nested offsets whose sum exceeds the line limit', () => {
    expect(() => parse(indexedMap(6_000_000, 0, indexedMap(6_000_000, 0))))
      .toThrow(/including offsets of nested sections/);
  });
});
