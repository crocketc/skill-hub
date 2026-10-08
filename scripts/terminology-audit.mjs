// Terminology audit: verifies the user-visible wording rulings recorded in
// docs/product/统一术语与命名总表.md (2026-10-08) stay landed in production
// copy. Confirmed scope enforced here:
//   1. Global rename: 集中库 -> 技能库; 副本 -> 拷贝 (en: central library -> skill library).
//   2. Verbs: 结束关系 -> 解除关系; the reclaim button is 回收技能; bare 「移除」
//      buttons must name their object (Remove labels in en included).
//   3. Conflict words: 完全重复 -> 同一技能, 名称重复 -> 重名, 可能匹配/搜索匹配 -> 相似技能.
// Frozen relation-domain wording (deferred until the relationship model is
// re-adjudicated) stays legal and is encoded in FROZEN_COMPOUNDS and KEY_ALLOWLIST:
// relation-kind labels (托管/观察/导入/受管/复制/来源 副本), graph edges & legend,
// governance status words, source categories, file-form words, and the whole
// skillDetail.insights.dependencyShapes.* block. Code identifiers
// (CentralLibrary/central_library/centralLibrary, i18n key names) are out of
// scope and never checked. Any violation must be fixed or added to the allowlist
// with a reviewed reason; unexpected hits fail with exit code 1.
import fs from 'fs';
import path from 'path';

const ZH = JSON.parse(fs.readFileSync('apps/desktop/src/i18n/zh-CN/common.json', 'utf8'));
const EN = JSON.parse(fs.readFileSync('apps/desktop/src/i18n/en-US/common.json', 'utf8'));

// Relation-domain compound words whose wording is frozen (deferred rollout).
// They are stripped before the residual 副本 check, mirroring the positive-lock
// pattern in apps/desktop/src/i18n/terminology.test.ts.
const FROZEN_COMPOUNDS = /托管副本|观察副本|导入副本|受管副本|复制副本|来源副本|集中库副本/g;

// Keys/prefixes whose whole value is frozen relation-domain wording (stays as-is
// until the relationship model is re-adjudicated) plus reviewed 存疑 values that
// are intentionally not renamed in this round. `en` flags keys also allowed to
// keep "central library" wording for the same reason.
const KEY_ALLOWLIST = {
  // 关系域冻结（暂缓实施，见总表第八节）：关系种类标签、文件形态词、图谱块。
  'skillDetail.insights.dependencyShapes.': { zh: true, reason: '关系域冻结：详情页关系构成五词整块暂缓（总表第八节.3）' },
  'relationshipGovernance.relationship.': { zh: true, reason: '关系域冻结：关系种类标签（导入副本/复制部署/链接部署等）暂缓' },
  'relationshipGovernance.fileRepresentation.': { zh: true, reason: '文件形态词冻结（副本/目录联结等），随关系域统一实施' },
  'relationships.graph.': { zh: true, en: true, reason: '图谱连线/图例/筛选词冻结（总表第八节暂缓.1）' },
  // 来源分类词（治理页“来源”列）冻结（总表第八节暂缓.2）。
  'relationships.governance.source.': { zh: true, en: true, reason: '来源分类词冻结（Agent 本地副本/集中库副本等）暂缓' },
  // 治理页状态词面冻结（第五节暂缓），但“已保留(为)独立副本→拷贝”词对按裁决已落地。
  'relationships.governance.shortName.taken_overDescription': { zh: true, en: true, reason: '治理页状态描述冻结（含「集中库管理」词面）暂缓' },
  'relationships.governance.shortName.not_taken_overDescription': { zh: true, en: true, reason: '治理页状态描述冻结（含「集中库管理」词面）暂缓' },
  'relationships.governance.shortName.completedDescription': { zh: true, en: true, reason: '治理页状态描述冻结（含「集中库管理」词面）暂缓' },
  // 来源副本清理簇：与导入来源/技能原件再裁决绑定，随关系域统一实施。
  'relationships.governance.clean.': { zh: true, en: true, reason: '来源副本清理簇（关系域暂缓；含「集中库中的技能副本」值保持原样）' },
  'relationships.governance.importBatch.banner': { zh: true, reason: '来源副本簇（本地来源副本）随关系域统一实施' },
  'relationships.governance.history.action.clean_source_copy': { zh: true, reason: '来源副本簇（清理来源副本）随关系域统一实施' },
  'relationships.governance.history.action.retain_source_copy': { zh: true, reason: '来源副本簇（保留来源副本）随关系域统一实施' },
  'relationships.governance.retain.done': { zh: true, reason: '来源副本簇（已保留此来源副本）随关系域统一实施' },
  'relationships.governance.batch.mixing': { zh: true, reason: '来源副本簇（来源副本与部署关系分批提示）随关系域统一实施' },
  'operations.kinds.relink_source_copy': { zh: true, reason: '来源副本簇（重连来源副本）随关系域统一实施' },
  // 受管副本呈现块：核心词「受管副本」冻结，整块随关系域统一实施。
  'agents.managedDeploymentCount': { zh: true, reason: '受管副本计数（关系域冻结复合词）暂缓' },
  'agents.detail.managedDeployments': { zh: true, reason: '受管副本标签（关系域冻结复合词）暂缓' },
  'projects.detail.managedDeployments.': { zh: true, reason: '受管副本列表呈现块暂缓（总表第八节.3 同族）' },
  'projects.assemblyPlan.detachNote': { zh: true, reason: '引用受管副本列表名的导航提示，随该块统一实施' },
  // 复制副本/审阅任务词：含冻结复合词或待关系体系定稿的转换任务措辞。
  'relationshipGovernance.governanceTaskKind.convert_copy_to_managed_link': { zh: true, reason: '复制副本（文件形态冻结词）任务措辞随关系域统一实施' },
  'relationshipGovernance.precedence.lower_priority_copy': { zh: true, reason: '低优先级副本：关系域呈现词，暂缓（存疑保留）' },
  'pending.taskKinds.convert_copy_to_managed_link': { zh: true, reason: '审阅副本管理方式：转换任务措辞待关系体系定稿（存疑保留）' },
  'importWorkflow.governance.taskDetail.convert_copy_to_managed_link': { zh: true, reason: '复制副本（文件形态冻结词）任务措辞随关系域统一实施' },
  'importWorkflow.governance.rollback.content_identical_copy': { zh: true, reason: '来源副本（关系域复合词）回退说明暂缓' },
  'importWorkflow.governance.classification.contentIdenticalCopy': { zh: true, reason: '复制副本（文件形态冻结词）分类词暂缓' },
  // 存疑保留：原始副本属“导入原件/技能原件”域（裁决 2 暂缓），本回合不改。
  'importWorkflow.summary.originalsPreserved': { zh: true, reason: '存疑：「原始副本」待导入原件域（裁决 2）定稿后统一更名' },
  'importWorkflow.governance.description': { zh: true, reason: '存疑：句中「原始副本」待导入原件域（裁决 2）定稿后统一更名' },
  // en 存疑：zh 为「删除」而 en 为裸 "Remove"，动词归一待裁决（zh 不在本次范围）。
  'agents.actions.remove': { zh: false, en: true, reason: '存疑：zh「删除」/en "Remove" 动词不一致，待动词表补充裁决' },
};

function isAllowed(key, lang) {
  for (const [prefix, rule] of Object.entries(KEY_ALLOWLIST)) {
    if ((key === prefix || key.startsWith(prefix)) && rule[lang]) return rule.reason;
  }
  return null;
}

function leaves(node, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([key, v]);
    else out.push(...leaves(v, key));
  }
  return out;
}

const violations = [];
function report(lang, key, value, check, detail) {
  violations.push({ lang, key, value, check, detail });
}

// --- zh resource checks -----------------------------------------------------
function checkZhValue(key, value, allowed) {
  if (value.includes('集中库')) {
    if (!allowed) report('zh', key, value, '集中库', '应为「技能库」');
    return;
  }
  if (value.includes('结束关系')) {
    if (!allowed) report('zh', key, value, '结束关系', '应为「解除关系」');
    return;
  }
  for (const [banned, fix] of [['完全重复', '同一技能'], ['名称重复', '重名'], ['可能匹配', '相似技能'], ['搜索匹配', '相似技能']]) {
    if (value.includes(banned)) {
      if (!allowed) report('zh', key, value, banned, `应为「${fix}」`);
      return;
    }
  }
  if (value === '移除') {
    if (!allowed) report('zh', key, value, '裸「移除」按钮', '必须带具体宾语（移除标签、移除组合…）');
    return;
  }
  const residual = value.replace(FROZEN_COMPOUNDS, '');
  if (residual.includes('副本') && !allowed) {
    report('zh', key, value, '副本', '应为「拷贝」（冻结复合词与白名单除外）');
  }
}
for (const [key, value] of leaves(ZH)) {
  checkZhValue(key, value, isAllowed(key, 'zh'));
}

// --- en resource checks -----------------------------------------------------
const BANNED_EN_CONFLICT_LABELS = new Set([
  'Exact duplicate', 'Exact duplicates', 'Same name', 'Possible match',
  'Search-matched an existing Skill',
]);
for (const [key, value] of leaves(EN)) {
  const allowed = isAllowed(key, 'en');
  if (/central library|central-library/i.test(value)) {
    if (!allowed) report('en', key, value, 'central library', '应为 "skill library"');
    continue;
  }
  if (/end(ing)? (the |this )?relationship/i.test(value)) {
    if (!allowed) report('en', key, value, 'end relationship', '应为 "Release relation" 词形');
    continue;
  }
  if (BANNED_EN_CONFLICT_LABELS.has(value)) {
    if (!allowed) report('en', key, value, '旧冲突标签', '同一技能/重名/相似技能 按词表');
    continue;
  }
  if (value === 'Remove') {
    if (!allowed) report('en', key, value, 'bare "Remove" button', 'must name its object (Remove rule, Remove source…)');
  }
}

// --- inline copy in production components -----------------------------------
// Same production surface as scripts/i18n-cjk-audit.mjs (comments and reviewed
// fixture/preview exemptions are not user-visible copy).
const INLINE_EXEMPT = {
  'features/import/api.ts': 'mock facade fixture messages consumed only by *.test.* files',
  'features/projects/api.ts': 'preview fixture data; never rendered by the production router',
  'features/recovery/api.ts': 'recovery fixture sample payload; no production consumer',
  'features/security/api.ts': 'separate-check fixture sample finding',
  'features/settings/api.ts': 'settings fixture sample payloads; production uses nativeSettingsFacade',
  'features/dev-preview/UiFoundationsPreview.tsx': 'DEV-only UI foundations board (import.meta.env.DEV only)',
  'features/projects/ProjectsPreview.tsx': 'DEV-only projects preview fixture',
  'features/skills/SkillLibraryPreview.tsx': 'DEV-only skill library preview fixture',
  'features/skill-detail/SkillDetailPreview.tsx': 'DEV-only skill detail preview fixture',
  'features/relationships/governance/GovernancePreview.tsx': 'DEV-only governance preview fixture',
  'features/agents/AgentsPreview.tsx': 'DEV-only agents preview fixture',
  'features/settings/settingsSearch.ts': 'bilingual search alias data; labels render from i18n keys',
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

function walkSrc(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkSrc(full); continue; }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.') || entry.name === 'testFixtures.ts') continue;
    if (full.split(path.sep).includes('i18n')) continue;
    const rel = full.split(path.sep).join('/').replace(/^apps\/desktop\/src\//, '');
    if (INLINE_EXEMPT[rel]) continue;
    const lines = stripComments(fs.readFileSync(full, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (/集中库|结束关系|完全重复|名称重复|可能匹配|搜索匹配/.test(line)) {
        violations.push({ lang: 'inline', key: `${rel}:${i + 1}`, value: line.trim().slice(0, 120), check: '禁用词', detail: '组件内联文案不得含禁用词，改用 i18n 键' });
      } else if (line.includes('副本') && !line.replace(FROZEN_COMPOUNDS, '').includes('副本')) {
        // frozen compound only — tolerated inline (e.g. quoting frozen labels)
      } else if (line.includes('副本')) {
        violations.push({ lang: 'inline', key: `${rel}:${i + 1}`, value: line.trim().slice(0, 120), check: '副本', detail: '应为「拷贝」（冻结复合词除外）' });
      }
    });
  }
}
walkSrc('apps/desktop/src');

// --- report -----------------------------------------------------------------
if (violations.length > 0) {
  console.error(`FAIL: ${violations.length} terminology violation(s):`);
  for (const v of violations) {
    console.error(`  [${v.lang}] ${v.key} — ${v.check}: ${v.detail}\n    ${JSON.stringify(v.value)}`);
  }
  process.exit(1);
}
const allowlisted = Object.keys(KEY_ALLOWLIST).length;
console.log(`OK: terminology clean. zh/en resources and inline copy match the confirmed rulings; ${allowlisted} frozen/存疑 allowlist entries reviewed against 统一术语与命名总表.md.`);
