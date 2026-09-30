import { mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir("docs/assets", { recursive: true });
await copyFile("node_modules/lucide/dist/umd/lucide.min.js", "docs/assets/lucide.min.js");
const result = spawnSync(process.execPath, ["node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "docs/prototype.css", "-o", "docs/assets/tailwind.css", "--minify"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
