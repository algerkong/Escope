import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readFile = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const APP_CSS = 'src/styles/app.css';
const appCss = readFile(APP_CSS);

// The policy lives in its own stylesheet and is read through the import graph, so a removed
// or misspelled @import cannot leave these checks auditing a file the application never loads.
const selectionHref = [...stripComments(appCss).matchAll(/@import\s+"([^"]+)"/g)]
  .map((match) => match[1] ?? '')
  .find((href) => href.endsWith('selection.css'));
const selectionCss = selectionHref ? readFile(`src/styles/${selectionHref.replace(/^\.\//, '')}`) : '';

interface UserSelectRule {
  selector: string;
  value: string;
  /** The declaration sits inside a :where() block, which keeps its specificity at zero. */
  wrapped: boolean;
}

function selectorsOf(raw: string): { selectors: string[]; wrapped: boolean } {
  const text = raw.trim();
  const wrapped = text.startsWith(':where(') && text.endsWith(')');
  const list = wrapped ? text.slice(7, -1) : text;
  return { selectors: list.split(',').map((part) => part.trim()).filter(Boolean), wrapped };
}

function userSelectRules(css: string): UserSelectRule[] {
  const rules: UserSelectRule[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaration = /(?:^|;)\s*user-select\s*:\s*([a-z-]+)/i.exec(match[2] ?? '');
    if (!declaration) continue;
    const { selectors, wrapped } = selectorsOf(match[1] ?? '');
    for (const selector of selectors) rules.push({ selector, value: (declaration[1] ?? '').toLowerCase(), wrapped });
  }
  return rules;
}

// Chrome kinds allowed to opt out of selection: navigation, titles, toolbars, buttons and
// control labels. Anything else in the opt-out block is a policy violation.
const CHROME_SELECTORS: RegExp[] = [
  /^\.app-header$/,
  /^\.session-banner$/,
  /^\.results-toolbar$/,
  /^\.resource-sidebar \.sidebar-heading$/,
  /^\.resource-bottom$/,
  /^\.ai-sidebar \.sidebar-heading$/,
  /^\.settings-sidebar nav$/,
  /^\.settings-version$/,
  /^\.dialog-heading$/,
  /^\.palette-input$/,
  /^\.palette-option$/,
  /^\.line-numbers$/,
  /^h[1-6]$/,
  /^button$/,
  /^label$/,
  /^kbd$/,
  /^summary$/,
];

// Selectors that must never appear in the opt-out block: global scopes and every surface the
// product promises to keep copyable, plus the containers that hold them.
const DATA_SURFACES = [
  'input', 'textarea', 'select', '[contenteditable]', 'pre', 'code',
  'table', 'tbody', 'thead', 'tr', 'td', 'th', 'dl', 'dd',
  '.endpoint', '.notice', '.connection-test-error', '.connection-test-status',
  '.connection-identity', '.query-breadcrumb', '.dsl-editor',
  '.connection-list', '.connection-row', '.connection-info',
  '.app-shell', '.view-container', '.query-main', '.settings-main',
  '.resource-sidebar', '.settings-sidebar', '.results-section', '.dialog-content',
  '.empty-state', '.palette-options',
];

const GLOBAL_SCOPE = /^(\*|body|html|:root)$/;

function auditOptOut(selectors: string[]): { selector: string; reason: string }[] {
  const violations: { selector: string; reason: string }[] = [];
  for (const selector of selectors) {
    if (GLOBAL_SCOPE.test(selector)) violations.push({ selector, reason: 'global opt-out' });
    else if (DATA_SURFACES.includes(selector)) violations.push({ selector, reason: 'data surface' });
    else if (!CHROME_SELECTORS.some((pattern) => pattern.test(selector))) {
      violations.push({ selector, reason: 'unrecognized chrome' });
    }
  }
  return violations;
}

const policyRules = userSelectRules(selectionCss);
const optOutSelectors = policyRules.filter((rule) => rule.value === 'none').map((rule) => rule.selector);
const selectableSelectors = policyRules.filter((rule) => rule.value === 'text').map((rule) => rule.selector);

// Each entry maps a requirement of the selection policy to the selector that keeps it true.
const REQUIRED_SELECTABLE: [string, RegExp][] = [
  ['text inputs', /^input$/],
  ['textareas', /^textarea$/],
  ['rich text editors', /\[contenteditable/],
  ['DSL, JSON and document payloads', /^pre$/],
  ['inline code', /^code$/],
  ['connection endpoints', /\.endpoint$/],
  ['error notices', /\.notice$/],
  ['connection test errors', /\.connection-test-error$/],
  ['dialog descriptions', /\.dialog-description$/],
  ['table data', /^table$/],
];

describe('selection policy stylesheet', () => {
  it('ships with the application stylesheet before the first rule block', () => {
    expect(selectionHref).toBeDefined();
    expect(selectionHref?.startsWith('./')).toBe(true);
    // Vite hoists late imports but warns about them, so the import stays at the top.
    expect(appCss.indexOf(selectionHref ?? '')).toBeLessThan(appCss.indexOf('{'));
  });

  it('never opts out of selection for the whole document', () => {
    expect(optOutSelectors.filter((selector) => GLOBAL_SCOPE.test(selector))).toEqual([]);
    expect(userSelectRules(appCss).filter((rule) => rule.value === 'none')).toEqual([]);
  });

  it('opts out only for chrome: navigation, titles, toolbars, buttons and labels', () => {
    expect(auditOptOut(optOutSelectors)).toEqual([]);
    expect(optOutSelectors.length).toBeGreaterThan(0);
  });

  it('keeps every copyable data surface explicitly selectable', () => {
    for (const [name, pattern] of REQUIRED_SELECTABLE) {
      expect(selectableSelectors.some((selector) => pattern.test(selector)), name).toBe(true);
    }
    expect(selectableSelectors).not.toContain('body');
  });

  it('lets data win inside chrome without !important', () => {
    expect(policyRules.every((rule) => rule.wrapped)).toBe(true);
    expect(selectionCss).not.toMatch(/user-select[^;}]*!important/);
    const css = stripComments(selectionCss);
    expect(css.indexOf('user-select: text')).toBeGreaterThan(css.indexOf('user-select: none'));
  });
});

describe('opt-out audit', () => {
  // Counter examples: the audit has to fail on the mistakes this policy exists to prevent.
  it('rejects document-wide opt-outs', () => {
    expect(auditOptOut(['*', 'body', 'html', ':root'])).toEqual([
      { selector: '*', reason: 'global opt-out' },
      { selector: 'body', reason: 'global opt-out' },
      { selector: 'html', reason: 'global opt-out' },
      { selector: ':root', reason: 'global opt-out' },
    ]);
  });

  it('rejects copyable data and the containers that hold it', () => {
    expect(auditOptOut(['pre', '.endpoint', '.query-main'])).toEqual([
      { selector: 'pre', reason: 'data surface' },
      { selector: '.endpoint', reason: 'data surface' },
      { selector: '.query-main', reason: 'data surface' },
    ]);
  });

  it('rejects chrome selectors it does not recognize and accepts the known kinds', () => {
    expect(auditOptOut(['.whatever-chrome'])).toEqual([{ selector: '.whatever-chrome', reason: 'unrecognized chrome' }]);
    expect(auditOptOut(['.app-header', '.settings-sidebar nav', 'button', 'label', 'kbd', 'h2'])).toEqual([]);
  });
});
