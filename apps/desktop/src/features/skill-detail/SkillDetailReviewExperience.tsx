import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { formatTimestamp } from "../../i18n";
import { MarkdownWorkspace } from "../markdown/MarkdownWorkspace";
import type { MarkdownFacade } from "../markdown/api";
import { SecurityResults } from "../security/SecurityResults";
import type { SecurityFacade } from "../security/api";
import { MetadataPanel } from "./MetadataPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { VersionTimeline } from "./VersionTimeline";
import { ReviewHeaderActions, ReviewOverviewStatus, ReviewSubjectLocation } from "./SkillDetailReviewScenarios";
import type { SkillLibraryReturnState } from "./detailContext";
import type {
  SkillDetailFacade,
  SkillDetailInsights,
  SkillDetailSummary,
  SkillMetadata,
  SkillProvenance,
  SkillRequirementFact,
} from "./api";

const sections = [
  ["review-overview", "概览"],
  ["review-content", "内容与文件"],
  ["review-safety", "安全检查"],
  ["review-usage", "使用去向"],
  ["review-sources", "来源更新"],
  ["review-versions", "版本历史"],
] as const;
type ReviewSectionId = typeof sections[number][0];

interface SkillDetailReviewExperienceProps {
  libraryReturn?: SkillLibraryReturnState;
  returnToLibrary: string;
  facade: SkillDetailFacade;
  insights?: SkillDetailInsights;
  markdownFacade?: MarkdownFacade;
  metadata?: SkillMetadata;
  provenance?: SkillProvenance;
  requirements?: SkillRequirementFact[];
  securityFacade: SecurityFacade;
  skillId: string;
  summary: SkillDetailSummary;
}

/** DEV review layout; writes remain in the in-memory preview facade. */
export function SkillDetailReviewExperience({
  libraryReturn,
  returnToLibrary,
  facade,
  insights,
  markdownFacade,
  metadata,
  provenance,
  requirements,
  securityFacade,
  skillId,
  summary,
}: SkillDetailReviewExperienceProps) {
  const [activeSection, setActiveSection] = useState<ReviewSectionId>(sections[0][0]);
  const reviewSecurityFacade = useMemo<SecurityFacade>(() => ({
    ...securityFacade,
    getPreferences: async () => ({ llmProvider: "", dataScope: "" }),
  }), [securityFacade]);
  const safeMetadata: SkillMetadata = {
    alias: metadata?.alias,
    author: metadata?.author,
    copyright: metadata?.copyright,
    invocationPolicy: metadata?.invocationPolicy,
    license: metadata?.license,
    note: metadata?.note,
    ownership: "导入记录",
    originalDescription: metadata?.originalDescription,
    purpose: metadata?.purpose ?? summary.purpose,
    source: "PDF 阅读工具原始目录",
    tags: metadata?.tags ?? [],
    translation: metadata?.translation
      ? { ...metadata.translation, model: "示例译文", sourceVersion: "当前内容" }
      : undefined,
  };

  return (
    <section className="sh-skill-detail sh-skill-detail--review" data-testid="skill-detail-review">
      <div className="sh-skill-detail__layout sh-skill-detail-review__layout">
        <aside className="sh-skill-detail__rail sh-skill-detail-review__rail">
          <Link
            className="sh-skill-detail__back"
            state={libraryReturn ? { libraryReturn } : undefined}
            to={returnToLibrary}
          >
            返回技能库
          </Link>
          <nav aria-label="技能详情导航" className="sh-skill-detail-review__nav">
            {sections.map(([id, label]) => (
              <a
                aria-current={activeSection === id ? "location" : undefined}
                className={activeSection === id ? "is-active" : undefined}
                href={`#${id}`}
                key={id}
                onClick={() => setActiveSection(id)}
              >
                {label}
              </a>
            ))}
          </nav>
        </aside>
        <main className="sh-skill-detail__content sh-skill-detail-review__main">
          <header className="sh-skill-detail-review__header">
            <div>
              <h1>{summary.name}</h1>
              <p>当前版本 · {summary.currentVersion}</p>
            </div>
            <div aria-label="技能操作" className="sh-skill-detail-review__actions">
              <ReviewHeaderActions />
            </div>
          </header>
          <p className="sh-skill-detail-review__prototype-note" role="note">
            原型示例 · 操作不会更改真实文件、网络来源或技能库数据。
          </p>

          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-overview">
            <h2>概览</h2>
            <div className="sh-skill-detail-review__overview">
              <ReviewOverviewStatus summary={summary} />
              {metadata ? <MetadataPanel facade={facade} metadata={safeMetadata} skillId={skillId} reviewPresentation /> : (
                <p role="status">正在读取技能画像…</p>
              )}
              <RequirementsPanel invocationPolicy={metadata?.invocationPolicy} requirements={requirements ?? []} />
              <ReviewSubjectLocation />
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-content">
            <h2>内容与文件</h2>
            {markdownFacade ? <MarkdownWorkspace facade={markdownFacade} reviewSaveFlow skillId={skillId} /> : <p role="status">正在读取技能文件…</p>}
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-safety">
            <h2>安全检查</h2>
            <SecurityResults facade={reviewSecurityFacade} skillId={skillId} versionId="current" variant="embedded" presentationMode="risk-aware" />
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-usage">
            <h2>使用去向</h2>
            <ReviewUsageDestinations />
            {insights ? <details className="sh-skill-detail-review__supplemental"><summary>依赖、重复候选与使用证据</summary><h3>依赖</h3><ul>{insights.dependencies.map((value) => <li key={value}>{value}</li>)}</ul><h3>可能重复的技能</h3><p>PDF Text Extractor · 内容比对候选，尚未确认重复。</p><p>AI 相似性分析未配置，当前保留确定性比对证据。</p><h3>使用证据</h3><p>{insights.usageEvidence ? `样例记录到 ${insights.usageEvidence.invocationCount} 次调用；不能据此保证 Agent 一定能执行。` : "暂无可靠调用记录。"}</p></details> : null}
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-sources">
            <h2>来源更新</h2>
          <div className="sh-skill-detail-review__import-record">
            <h3>导入记录</h3>
            {provenance ? <ReviewImportRecord provenance={provenance} /> : <p>没有可用的导入记录。</p>}
            {metadata ? (
              <dl className="sh-skill-detail-review__record sh-skill-detail-review__publisher-facts">
                <div><dt>导入来源</dt><dd>{safeMetadata.source}</dd></div>
                <div><dt>作者</dt><dd>{metadata.author || "未提供"}</dd></div>
                <div><dt>许可证</dt><dd>{metadata.license || "未提供"}</dd></div>
                <div><dt>版权</dt><dd>{metadata.copyright || "未提供"}</dd></div>
                <div><dt>当前归属</dt><dd>技能库中的独立主体</dd></div>
              </dl>
            ) : null}
          </div>
            <ReviewSourceUpdates />
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-versions">
            <h2>版本历史</h2>
            <VersionTimeline facade={facade} skillId={skillId} summary={summary} userFacingDates reviewPresentation />
            {insights ? <details className="sh-skill-detail-review__supplemental"><summary>外部变更与操作记录</summary><ul><li>2026年10月2日：SKILL.md 在 SkillHub 外发生修改</li><li>2026年9月14日：从本机目录导入</li></ul><p>仅为样例证据；未知时间或未覆盖范围不会推断为无变化。</p></details> : null}
          </section>
        </main>
      </div>
    </section>
  );
}

function ReviewUsageDestinations() {
  const [selectedTarget, setSelectedTarget] = useState<string>();
  const [targetView, setTargetView] = useState<"target" | "governance">("governance");
  const targets = [
    {
      id: "codex-copy",
      name: "Codex 终端",
      kind: "agent" as const,
      agentId: "openai.codex-cli",
      path: "~/Agents/Codex/skills/pdf-reader",
      status: "待集中管理",
      detail: "原位置仍是独立副本，当前内容尚未接管。",
    },
    {
      id: "shared-directory",
      name: "共享目录",
      kind: "shared" as const,
      agentId: "openai.codex-cli",
      path: "~/Agents/shared/skills/pdf-reader",
      status: "已集中管理",
      detail: "受管链接跟随集中库当前版本；共享目录只计一个物理去向。",
    },
    {
      id: "project-target",
      name: "文档协作项目",
      kind: "project" as const,
      agentId: "",
      path: "~/Projects/文档协作/skills/pdf-reader",
      status: "已集中管理",
      detail: "项目使用链接跟随集中库当前版本。",
    },
  ];
  return (
    <>
    <div aria-label="技能使用去向" className="sh-skill-detail-review__destinations">
      {targets.map((target) => {
        return (
          <article className="sh-skill-detail-review__destination" key={target.id}>
            <div className="sh-skill-detail-review__destination-heading">
              <div>
                {target.kind === "agent" || target.kind === "shared" ? (
                  <AgentPresentation agentId={target.agentId} />
                ) : <strong>{target.name}</strong>}
                {target.kind === "shared" ? <div className="sh-skill-detail-review__shared-consumers"><span>此物理目录的识别方</span><AgentPresentation agentId="codebuddy.code" /></div> : null}
              </div>
              <StatusBadge tone={target.status === "已集中管理" ? "success" : "warning"}>
                {target.status}
              </StatusBadge>
            </div>
            <p>{target.detail}</p>
            <code>{target.path}</code>
            <div className="sh-skill-detail-review__source-actions"><Button onClick={() => { setTargetView("target"); setSelectedTarget(target.id); }} size="sm" variant="ghost">{target.kind === "project" ? "进入项目" : "进入 Agent"}</Button><Button onClick={() => { setTargetView("governance"); setSelectedTarget(target.id); }} size="sm" variant="ghost">查看治理详情</Button></div>
          </article>
        );
      })}
    </div>
    {selectedTarget ? (() => {
      const target = targets.find((item) => item.id === selectedTarget);
      if (!target) return null;
      return (
        <Dialog.Root open onOpenChange={(open) => { if (!open) setSelectedTarget(undefined); }}>
          <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>{target.name} · {targetView === "target" ? "目标详情" : "使用关系"}</Dialog.Title>
            <Dialog.Description>{target.detail}</Dialog.Description>
            <dl className="sh-skill-detail-review__record"><div><dt>使用位置</dt><dd><code>{target.path}</code></dd></div><div><dt>当前管理方式</dt><dd>{target.status}</dd></div></dl>
            {targetView === "target" ? <p>此目标正在使用 PDF Reader。{target.kind === "shared" ? "这是一个物理共享目录；Codex 与 CodeBuddy 是其消费者，不重复计算目标。" : target.kind === "project" ? "当前项目：文档协作项目。" : "当前 Agent：Codex 终端。"}</p> : <p>{target.status === "已集中管理" ? "入口健康：链接可用，当前没有治理待办。" : "治理待处理：原入口是独立副本，等待选择是否集中管理。"}接管、保留/撤销、修复、回收、结束由统一关系治理流程承接。</p>}
            <p>已精确选中此目标上下文。返回技能详情不会改变使用状态。</p>
            <div className="sh-dialog__actions"><Button onClick={() => setTargetView((current) => current === "target" ? "governance" : "target")} size="sm" variant="secondary">{targetView === "target" ? "查看治理详情" : "查看目标详情"}</Button><Button onClick={() => setSelectedTarget(undefined)} size="sm">返回技能详情</Button></div>
          </Dialog.Content></Dialog.Portal>
        </Dialog.Root>
      );
    })() : null}
    </>
  );
}

function ReviewSourceUpdates() {
  const [sourceState, setSourceState] = useState<"missing" | "linked">("missing");
  const [lookup, setLookup] = useState<"idle" | "verified" | "failed">("idle");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<"associate" | "replace" | "adopt">("associate");
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [localChanges, setLocalChanges] = useState(false);
  const [actionResult, setActionResult] = useState<string>();
  const [sourceInput, setSourceInput] = useState("https://example.org/pdf-reader");
  const [derived, setDerived] = useState(false);
  const [upstreamOpen, setUpstreamOpen] = useState(false);
  const confirmTitle = confirmIntent === "adopt" ? "采用网络更新影响预览"
    : confirmIntent === "replace" ? "更换网络来源影响预览"
      : "关联影响预览";
  const confirmDescription = confirmIntent === "associate" ? "关联不会采用或替换当前内容"
    : confirmIntent === "replace" ? "更换来源只变更更新关系，不会采用新内容"
      : "采用将以核验的来源版本创建当前 Skill 的新版本";
  return (
    <section className="sh-skill-detail-review__source-updates" aria-label="网络更新来源">
      <div className="sh-skill-detail-review__section-heading">
        <div>
          <h3>网络更新来源</h3>
          <p>{sourceState === "linked" ? "已关联：PDF Reader 官方维护仓库" : "尚未关联更新来源"}</p>
        </div>
        <Button onClick={() => { setLookup("idle"); setConfirmIntent(sourceState === "linked" ? "replace" : "associate"); setChooserOpen(true); }} size="sm" variant="ghost">
          {sourceState === "linked" ? "更换来源" : "查找更新来源"}
        </Button>
      </div>
      <p>关联来源只建立更新关系，不会替换当前内容或自动升级。</p>
      {actionResult ? <p role="status">{actionResult}</p> : null}
      {sourceState === "linked" ? (
        <div className="sh-skill-detail-review__source-actions">
          <Button onClick={() => { setLookup("verified"); setActionResult(undefined); }} size="sm" variant="secondary">检查更新</Button>
          <Button onClick={() => setUnlinkOpen(true)} size="sm" variant="ghost">解除来源关联</Button>
        </div>
      ) : null}
      {sourceState === "linked" && localChanges ? <p className="sh-skill-detail-review__source-local-changes" role="status">本机内容有未同步修改。检查结果会保留为来源证据，采用前会说明覆盖影响。</p> : null}
      {lookup === "verified" && sourceState === "linked" ? (
        <div className="sh-skill-detail-review__source-candidate" role="status">
          <strong>发现可检查的上游更新</strong><span>当前内容没有被替换。</span>
          <Button onClick={() => { setConfirmIntent("adopt"); setConfirmOpen(true); }} size="sm">预览采用影响</Button>
        </div>
      ) : null}
      {lookup === "failed" && sourceState === "linked" ? <p role="alert">来源检查失败 · 上次关联仍保留，技能内容没有变化。</p> : null}
      <Dialog.Root open={chooserOpen} onOpenChange={setChooserOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sh-dialog__overlay" />
          <Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>选择网络更新来源</Dialog.Title>
            <Dialog.Description>导入记录会保留；这里只查找并核验候选来源，不会替换技能内容。</Dialog.Description>
            <label className="sh-skill-detail-review__dialog-field">来源地址<input value={sourceInput} onChange={(event) => { setSourceInput(event.currentTarget.value); setLookup("idle"); }} /></label>
            <div className="sh-skill-detail-review__source-actions">
              <Button disabled={!sourceInput.trim()} onClick={() => setLookup(sourceInput.startsWith("https://") ? "verified" : "failed")} size="sm" variant="secondary">查找来源</Button>
            </div>
            {lookup === "failed" ? <p role="alert">未能核验来源。请检查 HTTPS 来源地址后重试；当前关联和内容不变。</p> : null}
            {lookup === "verified" ? (
              <div className="sh-skill-detail-review__source-candidate" role="status">
                <strong>PDF Reader 官方维护仓库</strong>
                <span>来源已核验，可用于只读检查</span>
                <Button onClick={() => { setChooserOpen(false); setConfirmIntent(sourceState === "linked" ? "replace" : "associate"); setConfirmOpen(true); }} size="sm">{sourceState === "linked" ? "更换来源" : "关联来源"}</Button>
              </div>
            ) : null}
            <div className="sh-dialog__actions"><Button onClick={() => setChooserOpen(false)} size="sm" variant="ghost">关闭</Button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sh-dialog__overlay" />
          <Dialog.Content aria-describedby="review-source-impact-description" className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>{confirmTitle}</Dialog.Title>
            <Dialog.Description id="review-source-impact-description">{confirmDescription}</Dialog.Description>
            {confirmIntent === "adopt" ? (
              <div className="sh-skill-detail-review__action-impact"><strong>当前版本 v2.4.1 → 来源版本 v2.5.0</strong><ul><li>{localChanges ? "本机有未同步修改；采用前必须显式处理覆盖影响" : "未发现本机未同步修改"}</li><li>原有高风险发现保留在安全记录中，不会被更新覆盖</li><li>2 个受管链接会继续跟随新当前版本</li><li>1 个独立副本保持原状，不自动更新</li></ul></div>
            ) : confirmIntent === "replace" ? (
              <ul><li>当前来源关系更换为 PDF Reader 官方维护仓库</li><li>技能内容和现有版本保持不变</li><li>原导入来源记录继续保留</li></ul>
            ) : (
              <><p>导入记录会继续保留；后续检查为只读，采用更新需再次查看影响并明确确认。</p><ul><li>当前技能内容保持不变</li><li>导入时的本机来源记录继续保留</li><li>联网检查仅在你主动选择时执行</li></ul></>
            )}
            <div className="sh-dialog__actions">
              <Button onClick={() => setConfirmOpen(false)} size="sm" variant="ghost">取消</Button>
              <Button onClick={() => {
                if (confirmIntent === "adopt") {
                  setLocalChanges(false);
                  setLookup("idle");
                  setActionResult("示例更新已采用；新版本已创建，安全发现与独立副本仍保留。");
                } else if (confirmIntent === "replace") {
                  setActionResult("更新来源已更换；当前内容和导入记录未改变。");
                } else {
                  setActionResult("更新来源已关联；尚未采用任何内容。");
                }
                setSourceState("linked");
                setConfirmOpen(false);
              }} size="sm">{confirmIntent === "adopt" ? "确认采用更新" : confirmIntent === "replace" ? "确认更换来源" : "确认关联"}</Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
          <Dialog.Title>解除网络来源关联</Dialog.Title><Dialog.Description>只解除更新来源关系，技能主体、当前内容与导入记录都会保留。</Dialog.Description>
          <div className="sh-dialog__actions"><Button onClick={() => setUnlinkOpen(false)} size="sm" variant="ghost">取消</Button><Button onClick={() => { setSourceState("missing"); setLocalChanges(false); setLookup("idle"); setUnlinkOpen(false); }} size="sm">确认解除</Button></div>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      {derived ? <div className="sh-skill-detail-review__action-impact"><h3>复用修改的原技能</h3><p>从 PDF Reader 基础版 v2.3.2 创建，两个主体独立维护。此追溯不会自动建立网络更新来源。</p><Button onClick={() => setUpstreamOpen(true)} size="sm" variant="ghost">查看原技能</Button></div> : null}
      <Dialog.Root open={upstreamOpen} onOpenChange={setUpstreamOpen}><Dialog.Portal><Dialog.Overlay className="sh-dialog__overlay" /><Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog"><Dialog.Title>PDF Reader 基础版 · 原技能</Dialog.Title><Dialog.Description>起始版本 v2.3.2；复用修改关系只用于来源追溯，原技能后续修改不会自动覆盖当前主体。</Dialog.Description><Button onClick={() => setUpstreamOpen(false)} size="sm">返回当前技能</Button></Dialog.Content></Dialog.Portal></Dialog.Root>
      <details className="sh-skill-detail-review__dev-scenarios"><summary>DEV 场景演示</summary>
        <div>
          <Button onClick={() => { setSourceState("missing"); setLookup("idle"); }} size="sm" variant="ghost">模拟未关联</Button>
          <Button onClick={() => { setSourceState("linked"); setLocalChanges(false); }} size="sm" variant="ghost">模拟已关联</Button>
          <Button onClick={() => { setSourceState("linked"); setLocalChanges(true); }} size="sm" variant="ghost">模拟本地有修改</Button>
          <Button onClick={() => { setSourceState("linked"); setLookup("failed"); }} size="sm" variant="ghost">模拟检查失败</Button>
          <Button onClick={() => { setSourceState("missing"); setLookup("failed"); }} size="sm" variant="ghost">模拟查找失败</Button>
          <Button onClick={() => setDerived((current) => !current)} size="sm" variant="ghost">切换复用修改追溯</Button>
        </div>
      </details>
    </section>
  );
}

function ReviewImportRecord({ provenance }: { provenance: SkillProvenance }) {
  const { i18n } = useTranslation();
  const record = provenance.provenance;
  if (!record) return <p>此技能没有导入存证，不能据此推断网络更新来源。</p>;
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  return (
    <dl className="sh-skill-detail-review__record">
      <div><dt>导入类型</dt><dd>本机目录导入</dd></div>
      <div><dt>导入时间</dt><dd>{formatTimestamp(record.importedAt, locale)}</dd></div>
      <div><dt>来源记录</dt><dd>~/Agents/Codex/skills/pdf-reader</dd></div>
      <div><dt>记录说明</dt><dd>这是导入时的来源存证，不是可更新的网络来源。</dd></div>
    </dl>
  );
}
