// Regenerates every desktop icon from the two committed sources:
//   src-tauri/icons/icon.svg        full-bleed tile (Windows/Linux, web favicon, title-bar logo)
//   src-tauri/icons/icon-macos.svg  same tile on the macOS 824/1024 grid with a drop shadow
// Usage: node scripts/generate-icon.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const icons = 'src-tauri/icons';
const tauri = (source, out) => execFileSync('npx', ['tauri', 'icon', source, '-o', out], { stdio: 'inherit', shell: true });
const temp = mkdtempSync(join(tmpdir(), 'escope-icons-'));
try {
  const full = join(temp, 'full');
  const mac = join(temp, 'mac');
  tauri(`${icons}/icon.svg`, full);
  tauri(`${icons}/icon-macos.svg`, mac);
  const files = ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'StoreLogo.png',
    ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((size) => `Square${size}x${size}Logo.png`)];
  for (const file of files) copyFileSync(join(full, file), join(icons, file));
  copyFileSync(join(mac, 'icon.icns'), join(icons, 'icon.icns'));
  copyFileSync(`${icons}/icon.svg`, 'public/icon.svg');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
