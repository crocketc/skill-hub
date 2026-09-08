// i18n audit: flags Simplified-Chinese text in product source that could reach
// the UI. Block and line comments are stripped before matching (comments are
// never user-visible). Remaining hits must be either eliminated or added to
// EXEMPT below with a reason; unexpected hits fail with exit code 1.
import fs from 'fs';
import path from 'path';

// Reviewed 2026-09-09: each exempt file only carries CJK inside fixture or
// mock-facade payloads consumed by *.test.* files; none of them is wired into
// the production router (app/router.tsx uses the native facades instead).
const EXEMPT = {
  'features/import/api.ts':
    'createMockImportFacade fixture messages; consumed only by *.test.* files',
  'features/projects/api.ts':
    'preview fixture data (project assembly snapshot); never rendered by the production router',
  'features/recovery/api.ts':
    'recoveryFixture sample payload; no production consumer',
  'features/security/api.ts':
    'separateCheckFixture sample finding; consumed only by SecurityResults.test.tsx',
  'features/settings/api.ts':
    'settingsFixture/networkSettings/availableUpdate sample payloads; production uses nativeSettingsFacade',
};

function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

const results = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.') || entry.name === 'testFixtures.ts') continue;
    if (full.split(path.sep).includes('i18n')) continue;
    const stripped = stripComments(fs.readFileSync(full, 'utf8'));
    stripped.split('\n').forEach((line, i) => {
      const matches = line.match(/[\u4e00-\u9fa5]{2,}/g);
      if (matches) {
        const key = full
          .split(path.sep)
          .join('/')
          .replace(/^apps\/desktop\/src\//, '');
        (results[key] = results[key] || []).push(i + 1);
      }
    });
  }
}
walk('apps/desktop/src');

let exemptTotal = 0;
let openTotal = 0;
let failed = false;
const exempted = {};
for (const [file, hits] of Object.entries(results)) {
  if (EXEMPT[file]) {
    exempted[file] = hits;
    exemptTotal += hits.length;
    continue;
  }
  console.log(file, hits.length, `(${hits.join(',')})`);
  openTotal += hits.length;
  failed = true;
}
for (const [file, hits] of Object.entries(exempted)) {
  console.log(`EXEMPT ${file} ${hits.length} (${hits.join(',')}) — ${EXEMPT[file]}`);
}
console.log(
  'TOTAL files:',
  Object.keys(results).length,
  'lines:',
  openTotal + exemptTotal,
  '| user-visible (must fix):',
  openTotal,
  '| exempt fixture/comment lines:',
  exemptTotal,
);
if (failed) {
  console.error('FAIL: non-exempt CJK hits above must be replaced with i18n keys or exempted with a reviewed reason.');
  process.exit(1);
}
console.log('OK: no user-visible CJK outside reviewed exemptions.');
