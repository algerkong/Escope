import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { icons } = require('lucide');
const attributes = (props) => Object.entries(props).map(([key, value]) => `${key}="${String(value)}"`).join(' ');
const content = icons.ScanLine[2].map(([tag, props]) => `<${tag} ${attributes(props)} />`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#292c31"/><g transform="translate(4,4) scale(.666667)" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${content}</g></svg>`;
await mkdir('work', { recursive: true });
await writeFile('work/app-icon.svg', svg);
