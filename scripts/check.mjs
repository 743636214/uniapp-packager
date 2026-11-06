import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git', '.data', 'sdks'].includes(entry.name)) await walk(file);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
await walk(fileURLToPath(root));
console.log('所有 JavaScript 文件语法检查通过。');
