import fs from 'fs';
import path from 'path';
const results = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.') || entry.name === 'testFixtures.ts') continue;
    if (full.split(path.sep).includes('i18n')) continue;
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const clean = line.replace(/\/\/.*$/, '');
      const matches = clean.match(/[\u4e00-\u9fa5]{2,}/g);
      if (matches) {
        const key = full.split(path.sep).join('/');
        (results[key] = results[key] || []).push(i + 1);
      }
    });
  }
}
walk('apps/desktop/src');
let total = 0;
for (const [file, hits] of Object.entries(results)) {
  console.log(file.replace('apps/desktop/src/', ''), hits.length);
  total += hits.length;
}
console.log('TOTAL files:', Object.keys(results).length, 'lines:', total);
