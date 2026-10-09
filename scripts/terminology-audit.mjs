// Audit user-facing copy against the confirmed relationship terminology.
// Product wording belongs in locale resources; development comments and fixture
// data are excluded from the inline scan below.
import fs from 'node:fs';
import path from 'node:path';

const ZH = JSON.parse(fs.readFileSync('apps/desktop/src/i18n/zh-CN/common.json', 'utf8'));
const EN = JSON.parse(fs.readFileSync('apps/desktop/src/i18n/en-US/common.json', 'utf8'));

function leaves(node, prefix = '') {
  const result = [];
  for (const [name, value] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'string') result.push([key, value]);
    else if (value !== null && typeof value === 'object') result.push(...leaves(value, key));
  }
  return result;
}

const violations = [];
const report = (lang, key, value, reason) => violations.push({ lang, key, value, reason });
const ZH_BANNED = /集中库|(?:待|已|转为|确认转为)集中管理|纳入技能库管理|副本|结束关系|完全重复|名称重复|可能匹配|搜索匹配|受管|托管|观察|(?:复制|链接)部署|复制派发|部署|管理拷贝/;
const EN_BANNED = /central[ -]library|centrally managed|manage(?:d|s|ing)? (?:\w+ )?centrally|end(ing)? (the |this )?relationship|managed (?:links?|cop(?:y|ies))|observed (?:links?|cop(?:y|ies))|(?:link|cop(?:y|ies)) deployments?|deployments? relationship|\b(?:un)?deploy(?:ment|ed|ing|s)?\b|^(?:exact duplicates?|same name(?:, different content)?|possible match|search-matched an existing skill)$/i;
const TECHNICAL_WORD_KEYS = new Set(['settings.llm.protocol.azure_open_ai']);

for (const [key, value] of leaves(ZH)) {
  if (!TECHNICAL_WORD_KEYS.has(key) && ZH_BANNED.test(value.replace(/\{\{[^}]*\}\}/g, ''))) report('zh', key, value, '文案与已确认术语不符');
  if (value === '移除') report('zh', key, value, '移除动作必须说明对象');
}

for (const [key, value] of leaves(EN)) {
  if (!TECHNICAL_WORD_KEYS.has(key) && EN_BANNED.test(value.replace(/\{\{[^}]*\}\}/g, ''))) report('en', key, value, 'Copy does not match confirmed terminology');
  if (value === 'Remove') report('en', key, value, 'Removal labels must name their object');
}

// These files contain preview-only data or bilingual search aliases, not
// production labels. Keep the exceptions at file granularity and documented.
const INLINE_EXEMPT = new Set([
  'features/import/api.ts',
  'features/projects/api.ts',
  'features/recovery/api.ts',
  'features/security/api.ts',
  'features/settings/api.ts',
  'features/dev-preview/UiFoundationsPreview.tsx',
  'features/projects/ProjectsPreview.tsx',
  'features/skills/SkillLibraryPreview.tsx',
  'features/skill-detail/SkillDetailPreview.tsx',
  'features/relationships/governance/GovernancePreview.tsx',
  'features/agents/AgentsPreview.tsx',
  'features/settings/settingsSearch.ts',
]);

function stripComments(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
    } else if (source[index] === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') output += '\n';
        index++;
      }
      index += 2;
    } else {
      output += source[index];
      index++;
    }
  }
  return output;
}

function sourceCopy(line) {
  const values = [];
  let index = 0;
  while (index < line.length) {
    const quote = line[index];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      index++;
      continue;
    }
    const context = line.slice(0, index);
    const isNonCopyAttribute = /\b(?:className|data-testid|id|href|to|aria-labelledby)\s*=\s*$/.test(context)
      || /\b(?:className|data-testid|id|href|to)\s*:\s*$/.test(context);
    const isThrownDiagnostic = /throw\s+new\s+Error\(\s*$/.test(context);
    index++;
    let value = '';
    while (index < line.length && line[index] !== quote) {
      if (line[index] === '\\' && index + 1 < line.length) index++;
      value += line[index++];
    }
    if (index < line.length) index++;
    // i18n keys and code enum values are identifiers, not user-facing copy.
    const withoutInterpolation = value.replace(/\$\{[^{}]*\}/g, '');
    const isCodeToken = /^[A-Za-z./][A-Za-z0-9_.:/?&={}\\-]*$/.test(withoutInterpolation);
    const isCssClassList = value.split(/\s+/).every((part) => /^(?:sh-|[a-z]+-)[A-Za-z0-9_-]+$/.test(part));
    if (withoutInterpolation.trim() && !isCodeToken && !isCssClassList && !isNonCopyAttribute && !isThrownDiagnostic) values.push(withoutInterpolation);
  }

  for (let start = 0; start < line.length; start++) {
    if (line[start] !== '>' || line[start - 1] === '=') continue;
    const end = line.indexOf('<', start + 1);
    if (end < 0) continue;
    const value = line.slice(start + 1, end).trim();
    if (value && !/[{}]/.test(value)) values.push(value);
  }
  return values.join(' ');
}

function scanSource(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanSource(fullPath);
      continue;
    }
    if ((!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) || entry.name.includes('.test.') || entry.name === 'testFixtures.ts') continue;
    if (fullPath.split(path.sep).includes('i18n')) continue;
    const relative = fullPath.split(path.sep).join('/').replace(/^apps\/desktop\/src\//, '');
    if (INLINE_EXEMPT.has(relative)) continue;
    stripComments(fs.readFileSync(fullPath, 'utf8')).split('\n').forEach((line, index) => {
      const copy = sourceCopy(line);
      if (ZH_BANNED.test(copy) || EN_BANNED.test(copy)) {
        report('inline', `${relative}:${index + 1}`, line.trim().slice(0, 160), '生产组件中的文案应使用已确认词表和 i18n 资源');
      }
    });
  }
}

scanSource('apps/desktop/src');

if (violations.length > 0) {
  console.error(`FAIL: ${violations.length} terminology violation(s):`);
  for (const item of violations) {
    console.error(`  [${item.lang}] ${item.key} — ${item.reason}\n    ${JSON.stringify(item.value)}`);
  }
  process.exit(1);
}

console.log('OK: locale resources and production inline copy match confirmed terminology.');
