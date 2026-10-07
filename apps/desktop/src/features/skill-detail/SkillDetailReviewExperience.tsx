import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import type { SourceState, SourceUpdateFileChange, SourceUpdatePreview } from "../../api/bindings";
import { AgentPresentation, inferAgentKindKey, readableAgentIdName } from "../../ui/AgentPresentation";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { StatusBadge } from "../../ui/StatusBadge";
import { formatTimestamp } from "../../i18n";
import type { DirectoryOpener } from "../../platform/directoryOpener";
import { MarkdownWorkspace } from "../markdown/MarkdownWorkspace";
import type { MarkdownFacade } from "../markdown/api";
import { SecurityResults } from "../security/SecurityResults";
import type { SecurityFacade } from "../security/api";
import { SecurityAlertBadge } from "../shared/SecurityAlertBadge";
import { MetadataPanel } from "./MetadataPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { VersionTimeline } from "./VersionTimeline";
import { projectDisplayName, type UsageDestinationCard, type UsageDestinationsState } from "./usageDestinations";
import { ReviewHeaderActions, ReviewOverviewStatus, ReviewSubjectLocation } from "./SkillDetailReviewScenarios";
import type { SkillLibraryReturnState } from "./detailContext";
import type {
  AdjacentSkillContext,
  SkillDetailFacade,
  SkillDetailInsights,
  SkillDetailSummary,
  SkillMetadata,
  SkillProvenance,
  SkillRequirementFact,
  SourceRelinkInput,
} from "./api";
import { skillDetailKeys } from "./api";

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
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  detailPathname: string;
  /** W3-6：主体位置「打开位置」走受控 open_local_directory；测试注入替身。 */
  directoryOpener?: DirectoryOpener;
  libraryReturn?: SkillLibraryReturnState;
  returnToLibrary: string;
  facade: SkillDetailFacade;
  insights?: SkillDetailInsights;
  markdownFacade?: MarkdownFacade;
  metadata?: SkillMetadata;
  /**
   * W3-3（§7.8 生产承载）：头部「转为集中管理」入口——仅当存在真实待接管
   * 使用关系（治理门面候选行非空）时由详情页传入，确认面板走真实治理批次
   * 契约；无候选行时缺省隐藏入口。
   */
  onCentralize?: () => void;
  /** W3-2：头部「删除」触发详情页既有的真实删除影响确认（K2 两段式）。 */
  onDelete: () => void;
  provenance?: SkillProvenance;
  refreshSnapshot?: () => Promise<void>;
  requirements?: SkillRequirementFact[];
  securityFacade: SecurityFacade;
  skillId: string;
  summary: SkillDetailSummary;
  /** W3-5：使用去向卡呈现模型（来自治理清单）；undefined 表示本路由未接治理门面。 */
  usageDestinations?: UsageDestinationsState;
  /** W3-3b（§7.8）：卡片治理入口携 Skill+关系身份深链治理页，由详情页提供。 */
  onOpenGovernanceDestination?: (relationId: string) => void;
}

/**
 * 技能详情评审布局（§9 裁决，2026-10-06）：生产默认呈现。
 * 安全区块接入真实 SecurityFacade 与安全预警事实（task C，六裁决安全呈现）；
 * 派发接真实部署对话框路由（W3-1），导出接标准导出流、删除接统一确认
 * （W3-2，§10 统一操作入口），头部转为集中管理接真实治理批次契约（W3-3a，
 * §7.8 生产承载）；
 * 使用去向卡接治理清单事实与治理页深链（W3-5/W3-3b）；
 * 来源更新区接真实五命令与 K6 预览绑定采用流（W3-4）：状态投影、只读检查、
 * 预览确认采用、按候选身份忽略与显式类型的来源关联，事实全部来自门面。
 */
export function SkillDetailReviewExperience({
  adjacent,
  backSearch,
  detailPathname,
  directoryOpener,
  libraryReturn,
  returnToLibrary,
  facade,
  insights,
  markdownFacade,
  metadata,
  onCentralize,
  onDelete,
  provenance,
  refreshSnapshot,
  requirements,
  securityFacade,
  skillId,
  summary,
  usageDestinations,
  onOpenGovernanceDestination,
}: SkillDetailReviewExperienceProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<ReviewSectionId>(sections[0][0]);
  // §分区折叠：默认全部展开；折叠用 hidden 隐藏 body，不卸载组件（保留编辑草稿等状态）。
  const [openSections, setOpenSections] = useState<Record<ReviewSectionId, boolean>>({
    "review-overview": true,
    "review-content": true,
    "review-safety": true,
    "review-usage": true,
    "review-sources": true,
    "review-versions": true,
  });
  const toggleSection = (id: ReviewSectionId) => {
    setOpenSections((current) => ({ ...current, [id]: !current[id] }));
  };
  // 侧栏导航联动：目标分区已收起时先展开，锚点滚动落在展开后的分区上。
  const navigateToSection = (id: ReviewSectionId) => {
    setActiveSection(id);
    setOpenSections((current) => (current[id] ? current : { ...current, [id]: true }));
  };
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
          <div className="sh-skill-detail-review__identity">
            <div className="sh-skill-detail-review__identity-name">
              <h1>{summary.name}</h1>
              <p>当前版本 · {summary.currentVersion}</p>
            </div>
            <div aria-label="技能操作" className="sh-skill-detail-review__actions">
              <ReviewHeaderActions
                onCentralize={onCentralize}
                onDispatch={() => navigate(`/library/${skillId}/deploy`)}
                onExport={() => navigate("/settings/data-protection", { state: { exportSkillIds: [skillId] } })}
                onDelete={onDelete}
              />
            </div>
            {/* 六裁决安全呈现（task C）：预警状态条 + 安全处理入口直达安全预警路由。 */}
            {summary.securityAlert ? (
              <div
                aria-label={t("securityAlert.recordLabel")}
                className="sh-skill-detail-review__security-alert"
                role="status"
              >
                <SecurityAlertBadge level={summary.securityAlert} />
                <span>{t("securityAlert.recordActive")}</span>
                <Button
                  onClick={() => navigate(`/library/${encodeURIComponent(skillId)}/security`, {
                    state: libraryReturn ? { libraryReturn } : undefined,
                  })}
                  size="sm"
                  variant="secondary"
                >
                  {t("skillDetail.actions.securityHandling")}
                </Button>
              </div>
            ) : null}
          </div>
          <nav aria-label="技能详情导航" className="sh-skill-detail-review__nav">
            {sections.map(([id, label]) => (
              <a
                aria-current={activeSection === id ? "location" : undefined}
                className={activeSection === id ? "is-active" : undefined}
                href={`#${id}`}
                key={id}
                onClick={() => navigateToSection(id)}
              >
                {label}
              </a>
            ))}
          </nav>
          <ReviewAdjacentSkills adjacent={adjacent} backSearch={backSearch} detailPathname={detailPathname} libraryReturn={libraryReturn} />
        </aside>
        <main className="sh-skill-detail__content sh-skill-detail-review__main">
          <p className="sh-skill-detail-review__prototype-note" role="note">
            原型示例 · 操作不会更改真实文件、网络来源或技能库数据。
          </p>

          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-overview">
            <h2>
              <ReviewSectionToggle label="概览" onToggle={() => toggleSection("review-overview")} open={openSections["review-overview"]} sectionId="review-overview" />
            </h2>
            <div hidden={!openSections["review-overview"]} id="review-overview-body">
              <div className="sh-skill-detail-review__overview">
                {metadata ? <MetadataPanel facade={facade} metadata={safeMetadata} refreshSnapshot={refreshSnapshot} skillId={skillId} reviewPresentation /> : (
                  <p role="status">正在读取技能画像…</p>
                )}
                <div className="sh-skill-detail-review__facts">
                  <ReviewOverviewStatus
                    combinations={insights?.combinations}
                    facade={facade}
                    onSummarySaved={() => { void queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }); }}
                    skillId={skillId}
                    summary={summary}
                  />
                  <ReviewSubjectLocation directoryOpener={directoryOpener} rootPath={summary.rootPath} />
                  <RequirementsPanel invocationPolicy={metadata?.invocationPolicy} requirements={requirements ?? []} />
                </div>
              </div>
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-content">
            <h2>
              <ReviewSectionToggle label="内容与文件" onToggle={() => toggleSection("review-content")} open={openSections["review-content"]} sectionId="review-content" />
            </h2>
            <div hidden={!openSections["review-content"]} id="review-content-body">
              {markdownFacade ? <MarkdownWorkspace facade={markdownFacade} fileRail reviewSaveFlow skillId={skillId} skillRootPath={summary.rootPath} /> : <p role="status">正在读取技能文件…</p>}
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-safety">
            <h2>
              <ReviewSectionToggle label="安全检查" onToggle={() => toggleSection("review-safety")} open={openSections["review-safety"]} sectionId="review-safety" />
            </h2>
            <div hidden={!openSections["review-safety"]} id="review-safety-body">
              {summary.currentVersionId ? (
                <SecurityResults
                  facade={securityFacade}
                  securityAlert={summary.securityAlert}
                  skillId={skillId}
                  versionId={summary.currentVersionId}
                  variant="embedded"
                  presentationMode="risk-aware"
                />
              ) : (
                <DataState
                  message={t("skillDetail.states.noCurrentVersionForSecurity")}
                  state="empty"
                />
              )}
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-usage">
            <div className="sh-skill-detail-review__section-heading">
              <h2>
                <ReviewSectionToggle label="使用去向" onToggle={() => toggleSection("review-usage")} open={openSections["review-usage"]} sectionId="review-usage" />
              </h2>
              <ReviewGraphEntry skillId={skillId} />
            </div>
            <div hidden={!openSections["review-usage"]} id="review-usage-body">
              <p>此处汇总每个使用位置的健康状态与治理待办；接管、保留/撤销、修复、回收、结束在关系治理（或对应 Agent/项目页）执行，点击卡片按钮会携带该技能与具体关系的上下文跳转。</p>
              <ReviewUsageDestinations destinations={usageDestinations} onOpenGovernance={onOpenGovernanceDestination} />
              {insights ? <ReviewUsageInsights insights={insights} /> : null}
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-sources">
            <h2>
              <ReviewSectionToggle label="来源更新" onToggle={() => toggleSection("review-sources")} open={openSections["review-sources"]} sectionId="review-sources" />
            </h2>
            <div hidden={!openSections["review-sources"]} id="review-sources-body">
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
              <ReviewSourceUpdates facade={facade} skillId={skillId} summary={summary} />
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-versions">
            <h2>
              <ReviewSectionToggle label="版本历史" onToggle={() => toggleSection("review-versions")} open={openSections["review-versions"]} sectionId="review-versions" />
            </h2>
            <div hidden={!openSections["review-versions"]} id="review-versions-body">
              <VersionTimeline facade={facade} skillId={skillId} summary={summary} userFacingDates reviewPresentation />
              {insights ? <details className="sh-skill-detail-review__supplemental" open><summary>外部变更与操作记录</summary><ul><li>2026年10月2日：SKILL.md 在 SkillHub 外发生修改</li><li>2026年9月14日：从本机目录导入</li></ul><p>仅为样例证据；未知时间或未覆盖范围不会推断为无变化。</p></details> : null}
            </div>
          </section>
        </main>
      </div>
    </section>
  );
}

/** 分区折叠开关：标题整行可点，chevron 指示状态；按钮内不放其他交互元素。 */
function ReviewSectionToggle({ label, onToggle, open, sectionId }: {
  label: string;
  onToggle: () => void;
  open: boolean;
  sectionId: ReviewSectionId;
}) {
  return (
    <button
      aria-controls={`${sectionId}-body`}
      aria-expanded={open}
      className="sh-skill-detail-review__section-toggle"
      onClick={onToggle}
      type="button"
    >
      {label}
      <Icon aria-hidden="true" className="sh-skill-detail-review__section-chevron" name="chevronDown" size={16} />
    </button>
  );
}

/**
 * 依赖、重复候选与使用证据：依赖与使用证据是随页面数据加载的确定性只读事实，
 * 不提供刷新入口；AI 相似性分析是独立可选入口，默认未配置，只读演示不发送内容。
 */
function ReviewUsageInsights({ insights }: { insights: SkillDetailInsights }) {
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiResult, setAiResult] = useState(false);
  const runAnalysis = () => {
    if (!aiConfigured || aiRunning) return;
    setAiRunning(true);
    window.setTimeout(() => {
      setAiRunning(false);
      setAiResult(true);
    }, 300);
  };
  return (
    <details className="sh-skill-detail-review__supplemental" open>
      <summary>依赖、重复候选与使用证据</summary>
      <h3>依赖</h3>
      {/* G-18：依赖是结构化事实——形态、路径与代理可读名。 */}
      <ul>
        {insights.dependencies.map((dependency) => (
          <li key={dependency.id}>
            {`${dependency.shapeLabel} · ${dependency.path}`}
            {dependency.agentClientId ? ` · ${readableAgentIdName(dependency.agentClientId)}` : ""}
          </li>
        ))}
      </ul>
      <div className="sh-skill-detail-review__section-heading">
        <h3>可能重复的技能</h3>
        <Button disabled={!aiConfigured} loading={aiRunning} onClick={runAnalysis} size="sm" variant="secondary">AI 相似性分析</Button>
      </div>
      <p>PDF Text Extractor · 内容比对候选，尚未确认重复。</p>
      {!aiConfigured ? (
        <>
          <p>AI 相似性分析未配置，当前保留确定性比对证据。</p>
          <p>可在设置中的网络与 AI 配置提供商；当前原型不会发送内容。</p>
        </>
      ) : null}
      {aiResult ? (
        <div role="status">
          <p>AI 相似性分析完成：PDF Text Extractor 相似度最高，建议人工确认；未发现其他高相似候选。</p>
          <p>AI 结果只是辅助证据，不替代确定性比对。</p>
        </div>
      ) : null}
      <h3>使用证据</h3>
      <p>{insights.usageEvidence ? `样例记录到 ${insights.usageEvidence.invocationCount} 次调用；不能据此保证 Agent 一定能执行。` : "暂无可靠调用记录。"}</p>
      <div className="sh-skill-detail-review__source-actions">
        <span className="sh-skill-detail-review__inline-status">DEV 演示：只影响本区</span>
        <Button
          onClick={() => { setAiConfigured((current) => !current); setAiRunning(false); setAiResult(false); }}
          size="sm"
          variant="ghost"
        >
          {aiConfigured ? "恢复未配置" : "模拟 AI 已配置"}
        </Button>
      </div>
    </details>
  );
}

/** 相邻技能切换（W1-5/D7-A：上下文由库列表前端推导，本组件只消费契约结果）。 */
function ReviewAdjacentSkills({ adjacent, backSearch, detailPathname, libraryReturn }: {
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  detailPathname: string;
  libraryReturn?: SkillLibraryReturnState;
}) {
  const { t } = useTranslation();
  if (!adjacent) return null;
  const navigationState = libraryReturn ? { libraryReturn } : undefined;
  return (
    <nav aria-label={String(t("skillDetail.navigation.label"))} className="sh-skill-detail__adjacent">
      <span>{String(t("skillDetail.navigation.position", { position: adjacent.position, total: adjacent.total }))}</span>
      <div className="sh-skill-detail__adjacent-controls">
        {adjacent.previous ? (
          <Link
            className="sh-button sh-button--ghost sh-button--sm"
            state={navigationState}
            to={{ pathname: `${detailPathname}/${adjacent.previous.id}`, search: backSearch }}
          >
            {String(t("skillDetail.navigation.previous"))}
          </Link>
        ) : (
          <button className="sh-button sh-button--ghost sh-button--sm" disabled type="button">
            {String(t("skillDetail.navigation.previous"))}
          </button>
        )}
        {adjacent.next ? (
          <Link
            className="sh-button sh-button--ghost sh-button--sm"
            state={navigationState}
            to={{ pathname: `${detailPathname}/${adjacent.next.id}`, search: backSearch }}
          >
            {String(t("skillDetail.navigation.next"))}
          </Link>
        ) : (
          <button className="sh-button sh-button--ghost sh-button--sm" disabled type="button">
            {String(t("skillDetail.navigation.next"))}
          </button>
        )}
      </div>
    </nav>
  );
}

/** 图谱查阅入口（§16 查阅与定位；FB-②）：携当前 Skill 身份真实跳转图谱页，
 * 图谱仍是使用关系与复用修改的权威展示，详情页不复制图谱画布。 */
function ReviewGraphEntry({ skillId }: { skillId: string }) {
  return (
    <Link
      className="sh-button sh-button--ghost sh-button--sm sh-skill-detail-review__accent-action"
      to={`/relationships?skillId=${encodeURIComponent(skillId)}`}
    >
      <Icon aria-hidden="true" name="relationships" size={16} />
      在图谱中查看
    </Link>
  );
}

// W3-5：使用去向卡由治理清单驱动（usageDestinations.ts 模型），状态、路径
// 与关系身份都来自真实行事实；接管状态变化由清单刷新承载，不用前端状态
// 翻转徽标（§7.8）。治理入口经 onOpenGovernanceDestination 深链治理页，
// 卡片不复制头部接管确认；Agent/项目入口进真实列表页（Agent 详情路由的
// id 空间与治理行的 client id 不同，不伪造直达链接）。
function ReviewUsageDestinations({
  destinations,
  onOpenGovernance,
}: {
  destinations?: UsageDestinationsState;
  onOpenGovernance?: (relationId: string) => void;
}) {
  const navigate = useNavigate();
  if (!destinations) return null;
  if (destinations.state === "loading") {
    return <p data-testid="usage-destinations-loading" role="status">正在获取使用去向。</p>;
  }
  if (destinations.state === "unavailable") {
    return <p data-testid="usage-destinations-error" role="alert">使用去向暂时无法获取；关系治理清单不可用。</p>;
  }
  if (destinations.cards.length === 0) {
    return (
      <p data-testid="usage-destinations-empty">
        还没有使用去向；通过「派发」创建第一个使用位置后，这里会显示各位置的状态。
      </p>
    );
  }
  return (
    <div aria-label="技能使用去向" className="sh-skill-detail-review__destinations">
      {destinations.cards.map((card) => (
        <UsageDestinationCardView
          card={card}
          key={card.relationId}
          onOpenAgentList={() => navigate("/agents")}
          onOpenGovernance={onOpenGovernance}
          onOpenProjectList={() => navigate("/projects")}
        />
      ))}
    </div>
  );
}

function UsageDestinationCardView({
  card,
  onOpenAgentList,
  onOpenGovernance,
  onOpenProjectList,
}: {
  card: UsageDestinationCard;
  onOpenAgentList: () => void;
  onOpenGovernance?: (relationId: string) => void;
  onOpenProjectList: () => void;
}) {
  const healthNote = card.unhealthy ? "入口健康异常，请在关系治理中检查。" : "";
  const detail = card.takenOver
    ? `受管链接跟随集中库当前版本。${card.targetKind === "shared_directory" ? "共享目录只计一个物理去向。" : ""}${healthNote}`
    : `原位置仍是独立副本；可在关系治理中纳入集中管理。${healthNote}`;
  return (
    <article className="sh-skill-detail-review__destination" data-testid={`usage-destination-${card.relationId}`}>
      <div className="sh-skill-detail-review__destination-heading">
        <div>
          {card.targetKind === "shared_directory" ? (
            <AgentPresentation
              sharedAgentBrandKinds={Object.fromEntries(
                card.agentClientIds.map((clientId) => [clientId, [inferAgentKindKey(clientId)]]),
              )}
              sharedAgentBrands={card.agentClientIds}
              sharedDirectory
            />
          ) : card.targetKind === "project" ? (
            <strong>{projectDisplayName(card.path) ?? "项目位置"}</strong>
          ) : (
            <AgentPresentation agentId={card.agentClientIds[0] ?? ""} />
          )}
        </div>
        <StatusBadge tone={card.takenOver ? "success" : "warning"}>
          {card.takenOver ? "已集中管理" : "待集中管理"}
        </StatusBadge>
      </div>
      <p title={detail}>{detail}</p>
      <code title={card.path}>{card.path}</code>
      <div className="sh-skill-detail-review__source-actions">
        <Button
          onClick={card.targetKind === "project" ? onOpenProjectList : onOpenAgentList}
          size="sm"
          variant="ghost"
        >
          {card.targetKind === "project" ? "进入项目" : "进入 Agent"}
        </Button>
        {onOpenGovernance ? (
          <Button onClick={() => onOpenGovernance(card.relationId)} size="sm" variant="ghost">
            查看治理详情
          </Button>
        ) : null}
      </div>
    </article>
  );
}

// W3-4：来源更新区接真实五命令——getSourceUpdateStatus（持久化状态投影）、
// checkSourceUpdate（只读检查）、prepareSourceUpdate+commitSourceUpdate（K6
// 预览绑定采用流）、ignoreSourceUpdate（按候选身份忽略）、relinkSource（G-15
// 显式来源类型）。状态、候选与谱系全部来自门面事实；后端没有「解除来源关联」
// 命令，界面不提供该入口（登记为契约缺口待开发项）。
const SOURCE_KIND_LABELS: Record<string, string> = {
  local: "本机目录导入",
  https: "网络 HTTPS 导入",
  git: "Git 仓库导入",
};

const SOURCE_UPDATE_FILE_CHANGE_LABELS: Record<SourceUpdateFileChange["change"], string> = {
  added: "新增",
  removed: "移除",
  modified: "修改",
};

function checkResultNotice(state: SourceState): string {
  switch (state) {
    case "up_to_date": return "来源检查完成：已是最新。";
    case "update_available": return "来源检查完成：发现可采用的更新候选。";
    case "update_available_with_local_changes": return "来源检查完成：发现可采用的更新候选；本机内容有未同步修改。";
    case "no_upstream": return "来源检查完成：没有可检查更新的上游来源。";
    case "source_unavailable": return "来源检查失败 · 上次关联仍保留，技能内容没有变化。";
    case "authentication_required": return "来源需要认证后才能检查更新。";
  }
}

function ReviewSourceUpdates({ facade, skillId, summary }: {
  facade: SkillDetailFacade;
  skillId: string;
  summary: SkillDetailSummary;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryFn: () => facade.getSourceUpdateStatus(skillId),
    queryKey: skillDetailKeys.sourceUpdateStatus(skillId),
    retry: false,
  });
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [relinkKind, setRelinkKind] = useState<SourceRelinkInput["kind"]>("https");
  const [relinkValue, setRelinkValue] = useState("");
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SourceUpdatePreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  const describeError = useCallback(
    (reason: unknown) => describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "tasks.notices.failureUnknown",
    ),
    [t],
  );
  const invalidateSourceFacts = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: skillDetailKeys.sourceUpdateStatus(skillId) });
    void queryClient.invalidateQueries({ queryKey: skillDetailKeys.versions(skillId) });
    void queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) });
  }, [queryClient, skillId]);

  const checkMutation = useMutation({
    mutationFn: () => facade.checkSourceUpdate(skillId),
    onSuccess: (result) => {
      setNotice(checkResultNotice(result.state));
      setActionError(null);
      invalidateSourceFacts();
    },
    onError: (reason: unknown) => {
      setNotice(null);
      setActionError(describeError(reason));
    },
  });
  const ignoreMutation = useMutation({
    mutationFn: (candidateIdentity: string) => facade.ignoreSourceUpdate(skillId, candidateIdentity),
    onSuccess: () => {
      setNotice("已忽略当前候选；之后的新候选会再次提醒。");
      setActionError(null);
      invalidateSourceFacts();
    },
    onError: (reason: unknown) => {
      setNotice(null);
      setActionError(describeError(reason));
    },
  });
  // K6：采纳入口先取得真实候选预览（preview_id + 文件级变化），确认后才提交。
  const preparePreview = async () => {
    setActionError(null);
    setCommitError(null);
    try {
      setPreview(await facade.prepareSourceUpdate(skillId));
      setPreviewOpen(true);
    } catch (reason: unknown) {
      setActionError(describeError(reason));
    }
  };
  const commitMutation = useMutation({
    mutationFn: (boundPreview: SourceUpdatePreview) =>
      facade.commitSourceUpdate(boundPreview.preview_id, "take_upstream"),
    onSuccess: (applied) => {
      setPreviewOpen(false);
      setPreview(null);
      setNotice(
        applied.deployments_need_reconciliation
          ? "已采用来源更新并创建新版本。有部署需要重新对账；请在关系治理中检查。"
          : "已采用来源更新并创建新版本。",
      );
      setActionError(null);
      invalidateSourceFacts();
    },
    onError: (reason: unknown) => setCommitError(describeError(reason)),
  });
  const relinkMutation = useMutation({
    mutationFn: (source: SourceRelinkInput) => facade.relinkSource(skillId, source),
    onSuccess: () => {
      setRelinkOpen(false);
      setRelinkValue("");
      setRelinkError(null);
      setNotice("已登记更新来源；可随时执行只读检查。");
      setActionError(null);
      invalidateSourceFacts();
    },
    onError: (reason: unknown) => setRelinkError(describeError(reason)),
  });

  const status = statusQuery.data;
  const hasSource = status !== undefined && status.state !== null && status.state !== "no_upstream";
  const candidateAvailable = status !== undefined
    && (status.state === "update_available" || status.state === "update_available_with_local_changes")
    && !status.candidate_ignored
    && status.candidate_identity !== null;
  let stateText: string;
  if (statusQuery.isPending) stateText = "正在获取来源更新状态。";
  else if (statusQuery.isError || status === undefined) stateText = "来源更新状态暂时无法获取。";
  else {
    switch (status.state) {
      case null: stateText = "尚未检查更新来源。"; break;
      case "no_upstream": stateText = "没有可检查更新的上游来源；本地创建或仅本机目录导入的技能没有网络更新来源。"; break;
      case "up_to_date": stateText = "来源为最新状态。"; break;
      case "update_available": stateText = `发现可采用的更新候选${status.upstream_label ? `（${status.upstream_label}）` : ""}。`; break;
      case "update_available_with_local_changes": stateText = `发现可采用的更新候选${status.upstream_label ? `（${status.upstream_label}）` : ""}；本机内容有未同步修改，采用前会说明覆盖影响。`; break;
      case "source_unavailable": stateText = "来源暂不可用；已登记的来源保持不变，技能内容没有变化。"; break;
      case "authentication_required": stateText = "来源需要认证后才能检查更新。"; break;
    }
    if (status.candidate_ignored) stateText += "当前候选已被忽略；之后的新候选会再次提醒。";
  }

  return (
    <section className="sh-skill-detail-review__source-updates" aria-label="网络更新来源">
      <div className="sh-skill-detail-review__section-heading">
        <div>
          <h3>网络更新来源</h3>
          <p>{stateText}</p>
          {status?.checked_at ? <p className="sh-skill-detail-review__secondary">最近检查：{formatTimestamp(status.checked_at, locale)}</p> : null}
        </div>
      </div>
      <p>关联来源只建立更新关系，不会替换当前内容或自动升级。</p>
      {notice ? <p role="status">{notice}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      <div className="sh-skill-detail-review__source-actions">
        <Button
          loading={checkMutation.isPending}
          onClick={() => checkMutation.mutate()}
          size="sm"
          variant="secondary"
        >
          检查更新
        </Button>
        {!statusQuery.isError ? (
          <Button
            className="sh-skill-detail-review__accent-action"
            onClick={() => {
              setRelinkError(null);
              setRelinkKind("https");
              setRelinkOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            {hasSource ? "更换来源" : "关联更新来源"}
          </Button>
        ) : null}
        {candidateAvailable ? (
          <>
            <Button onClick={() => void preparePreview()} size="sm">预览采用影响</Button>
            <Button
              loading={ignoreMutation.isPending}
              onClick={() => ignoreMutation.mutate(status.candidate_identity as string)}
              size="sm"
              variant="ghost"
            >
              忽略本次更新
            </Button>
          </>
        ) : null}
      </div>
      <Dialog.Root
        open={relinkOpen}
        onOpenChange={(open) => {
          setRelinkOpen(open);
          if (!open) setRelinkError(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="sh-dialog__overlay" />
          <Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>{hasSource ? "更换网络更新来源" : "关联网络更新来源"}</Dialog.Title>
            <Dialog.Description>来源类型由你显式选择；SkillHub 不会从地址文本猜测协议，也不会替换当前内容。</Dialog.Description>
            <label className="sh-skill-detail-review__dialog-field">
              来源类型
              <select
                onChange={(event) => setRelinkKind(event.currentTarget.value as SourceRelinkInput["kind"])}
                value={relinkKind}
              >
                <option value="https">HTTPS URL</option>
                <option value="git">Git 仓库</option>
                <option value="local">本地目录</option>
              </select>
            </label>
            <label className="sh-skill-detail-review__dialog-field">
              来源地址
              <input onChange={(event) => setRelinkValue(event.currentTarget.value)} value={relinkValue} />
            </label>
            {relinkError ? <p role="alert">{relinkError}</p> : null}
            <div className="sh-dialog__actions">
              <Button onClick={() => setRelinkOpen(false)} size="sm" variant="ghost">关闭</Button>
              <Button
                disabled={!relinkValue.trim()}
                loading={relinkMutation.isPending}
                onClick={() => relinkMutation.mutate({ kind: relinkKind, value: relinkValue.trim() })}
                size="sm"
                variant="secondary"
              >
                {hasSource ? "确认更换" : "确认关联"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sh-dialog__overlay" />
          <Dialog.Content aria-describedby="review-source-adopt-description" className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>采用更新影响预览</Dialog.Title>
            <Dialog.Description id="review-source-adopt-description">确认后将按以下文件级变化创建新版本；当前内容保留为历史版本。</Dialog.Description>
            {preview?.upstream_label ? <p>来源版本：{preview.upstream_label}</p> : null}
            <ul>
              {(preview?.files ?? []).map((file) => (
                <li key={file.path}>{`${file.path}（${SOURCE_UPDATE_FILE_CHANGE_LABELS[file.change]}）`}</li>
              ))}
            </ul>
            {preview ? <p>预览有效期至 {formatTimestamp(preview.expires_at, locale)}；过期后需重新预览。</p> : null}
            {commitError ? <p role="alert">{commitError}</p> : null}
            <div className="sh-dialog__actions">
              <Button onClick={() => setPreviewOpen(false)} size="sm" variant="ghost">取消</Button>
              <Button
                disabled={!preview}
                loading={commitMutation.isPending}
                onClick={() => { if (preview) commitMutation.mutate(preview); }}
                size="sm"
              >
                确认采用更新
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {summary.upstreamLineage ? (
        <div className="sh-skill-detail-review__action-impact">
          <h3>复用修改的原技能</h3>
          <p>
            从{" "}
            {summary.upstreamLineage.source_display_name ? (
              <Link to={`/library/${encodeURIComponent(summary.upstreamLineage.source_skill_id)}`}>
                {summary.upstreamLineage.source_display_name}
              </Link>
            ) : (
              "来源主体（名称不可解析）"
            )}
            {" "}复用修改创建，两个主体独立维护。此追溯不会自动建立网络更新来源。
          </p>
        </div>
      ) : (
        <p>无复用修改依据。此技能不是从其他 Skill 复用修改创建的。</p>
      )}
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
      <div><dt>导入类型</dt><dd>{SOURCE_KIND_LABELS[record.sourceKind] ?? record.sourceKind}</dd></div>
      <div><dt>导入时间</dt><dd>{formatTimestamp(record.importedAt, locale)}</dd></div>
      <div><dt>原始位置</dt><dd><code title={record.originalPath}>{record.originalPath}</code></dd></div>
      <div><dt>来源记录</dt><dd><code title={record.sourceLocator}>{record.sourceLocator}</code></dd></div>
      <div><dt>记录说明</dt><dd>这是导入时的来源存证，不是可更新的网络来源。</dd></div>
    </dl>
  );
}
