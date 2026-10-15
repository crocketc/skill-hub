import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import type { SourceState, SourceUpdatePreview } from "../../api/bindings";
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
import type { LlmAdminFacade } from "../settings/llmApi";
import { SecurityAlertBadge } from "../shared/SecurityAlertBadge";
import { MetadataPanel } from "./MetadataPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { SemanticDuplicatePanel } from "./SemanticDuplicatePanel";
import { VersionTimeline } from "./VersionTimeline";
import { projectDisplayName, type UsageDestinationCard, type UsageDestinationsState } from "./usageDestinations";
import { ReviewHeaderActions, ReviewOverviewStatus, ReviewSubjectLocation } from "./SkillDetailReviewScenarios";
import type { SkillLibraryReturnState } from "./detailContext";
import type { GraphSourceContext } from "../relationships/graph/graphReturnContext";
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
  ["review-overview", "overview"],
  ["review-content", "content"],
  ["review-safety", "safety"],
  ["review-usage", "usage"],
  ["review-sources", "sources"],
  ["review-versions", "versions"],
] as const;
type ReviewSectionId = typeof sections[number][0];

interface SkillDetailReviewExperienceProps {
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  detailPathname: string;
  graphHref: string;
  graphSource?: GraphSourceContext;
  /** W3-6：主体位置「打开位置」走受控 open_local_directory；测试注入替身。 */
  directoryOpener?: DirectoryOpener;
  libraryReturn?: SkillLibraryReturnState;
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
  /** T05：统一使用关系释放入口，仅在该技能存在活动去向时传入。 */
  onReclaim?: () => void;
  /** T15：运行名只通过主体级预览与提交流程修改。 */
  onRenameRuntimeName?: () => void;
  /** W3-2：头部「删除」触发详情页既有的真实删除影响确认（K2 两段式）。 */
  onDelete: () => void;
  provenance?: SkillProvenance;
  refreshSnapshot?: () => Promise<void>;
  requirements?: SkillRequirementFact[];
  securityFacade: SecurityFacade;
  llmFacade?: Pick<LlmAdminFacade, "readRuntimeStatus">;
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
  graphHref,
  graphSource,
  directoryOpener,
  libraryReturn,
  facade,
  insights,
  markdownFacade,
  metadata,
  onCentralize,
  onReclaim,
  onRenameRuntimeName,
  onDelete,
  provenance,
  refreshSnapshot,
  requirements,
  securityFacade,
  llmFacade,
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
    ownership: metadata?.ownership,
    originalDescription: metadata?.originalDescription,
    purpose: metadata?.purpose ?? summary.purpose,
    source: metadata?.source,
    tags: metadata?.tags ?? [],
    translation: metadata?.translation,
  };

  return (
    <section className="sh-skill-detail sh-skill-detail--review" data-testid="skill-detail-review">
      <div className="sh-skill-detail__layout sh-skill-detail-review__layout">
        <aside className="sh-skill-detail__rail sh-skill-detail-review__rail">
          <div className="sh-skill-detail-review__identity">
            <div className="sh-skill-detail-review__identity-name">
              <h1>{summary.name}</h1>
              <p>{t("skillDetail.review.currentVersion", { version: summary.currentVersion ?? t("skillLibrary.noVersion") })}</p>
            </div>
            <div aria-label={t("skillDetail.review.actionsLabel")} className="sh-skill-detail-review__actions">
              <ReviewHeaderActions
                onCentralize={onCentralize}
                onReclaim={onReclaim}
                onRenameRuntimeName={onRenameRuntimeName}
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
          <nav aria-label={t("skillDetail.review.navLabel")} className="sh-skill-detail-review__nav">
            {sections.map(([id, labelKey]) => (
              <a
                aria-current={activeSection === id ? "location" : undefined}
                className={activeSection === id ? "is-active" : undefined}
                href={`#${id}`}
                key={id}
                onClick={() => navigateToSection(id)}
              >
                {t(`skillDetail.review.sections.${labelKey}`)}
              </a>
            ))}
          </nav>
          <ReviewAdjacentSkills adjacent={adjacent} backSearch={backSearch} detailPathname={detailPathname} libraryReturn={libraryReturn} />
        </aside>
        <main className="sh-skill-detail__content sh-skill-detail-review__main">
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-overview">
            <h2>
              <ReviewSectionToggle label={t("skillDetail.review.sections.overview")} onToggle={() => toggleSection("review-overview")} open={openSections["review-overview"]} sectionId="review-overview" />
            </h2>
            <div hidden={!openSections["review-overview"]} id="review-overview-body">
              <div className="sh-skill-detail-review__overview">
                {metadata ? <MetadataPanel facade={facade} llmFacade={llmFacade} metadata={safeMetadata} refreshSnapshot={refreshSnapshot} skillId={skillId} reviewPresentation /> : (
                  <p role="status">{t("skillDetail.review.loadingProfile")}</p>
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
              <ReviewSectionToggle label={t("skillDetail.review.sections.content")} onToggle={() => toggleSection("review-content")} open={openSections["review-content"]} sectionId="review-content" />
            </h2>
            <div hidden={!openSections["review-content"]} id="review-content-body">
              {markdownFacade ? <MarkdownWorkspace facade={markdownFacade} fileRail reviewSaveFlow skillId={skillId} skillRootPath={summary.rootPath} /> : <p role="status">{t("skillDetail.review.loadingFiles")}</p>}
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-safety">
            <h2>
              <ReviewSectionToggle label={t("skillDetail.review.sections.safety")} onToggle={() => toggleSection("review-safety")} open={openSections["review-safety"]} sectionId="review-safety" />
            </h2>
            <div hidden={!openSections["review-safety"]} id="review-safety-body">
              {summary.currentVersionId ? (
                <SecurityResults
                  facade={securityFacade}
                  llmFacade={llmFacade}
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
                <ReviewSectionToggle label={t("skillDetail.review.sections.usage")} onToggle={() => toggleSection("review-usage")} open={openSections["review-usage"]} sectionId="review-usage" />
              </h2>
              <ReviewGraphEntry graphHref={graphHref} graphSource={graphSource} />
            </div>
            <div hidden={!openSections["review-usage"]} id="review-usage-body">
              <p>{t("skillDetail.review.usage.guidance")}</p>
              <ReviewUsageDestinations destinations={usageDestinations} onOpenGovernance={onOpenGovernanceDestination} />
              {insights ? <ReviewUsageInsights facade={facade} insights={insights} llmFacade={llmFacade} skillId={skillId} /> : null}
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-sources">
            <h2>
              <ReviewSectionToggle label={t("skillDetail.review.sections.sources")} onToggle={() => toggleSection("review-sources")} open={openSections["review-sources"]} sectionId="review-sources" />
            </h2>
            <div hidden={!openSections["review-sources"]} id="review-sources-body">
              <div className="sh-skill-detail-review__import-record">
                <h3>{t("skillDetail.review.import.heading")}</h3>
                {provenance ? <ReviewImportRecord provenance={provenance} /> : <p>{t("skillDetail.review.import.unavailable")}</p>}
                {metadata ? (
                  <dl className="sh-skill-detail-review__record sh-skill-detail-review__publisher-facts">
                    <div><dt>{t("skillDetail.review.import.source")}</dt><dd>{safeMetadata.source ?? t("skillDetail.metadata.empty")}</dd></div>
                    <div><dt>{t("skillDetail.review.import.author")}</dt><dd>{metadata.author || t("skillDetail.metadata.empty")}</dd></div>
                    <div><dt>{t("skillDetail.review.import.license")}</dt><dd>{metadata.license || t("skillDetail.metadata.empty")}</dd></div>
                    <div><dt>{t("skillDetail.review.import.copyright")}</dt><dd>{metadata.copyright || t("skillDetail.metadata.empty")}</dd></div>
                    <div><dt>{t("skillDetail.review.import.ownership")}</dt><dd>{t("skillDetail.review.import.standalone")}</dd></div>
                  </dl>
                ) : null}
              </div>
              <ReviewSourceUpdates facade={facade} skillId={skillId} summary={summary} />
            </div>
          </section>
          <section className="sh-skill-detail__zone sh-skill-detail-review__section" id="review-versions">
            <h2>
              <ReviewSectionToggle label={t("skillDetail.review.sections.versions")} onToggle={() => toggleSection("review-versions")} open={openSections["review-versions"]} sectionId="review-versions" />
            </h2>
            <div hidden={!openSections["review-versions"]} id="review-versions-body">
              <VersionTimeline facade={facade} skillId={skillId} summary={summary} userFacingDates reviewPresentation />
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
 * 不提供刷新入口；重复候选走 SemanticDuplicatePanel 真实契约——确定性候选
 * 常显（insights.deterministicDuplicates），可选 AI 层使用共享能力状态，
 * 等待当前连接与能力前置条件就绪后才允许发起分析。
 */
function ReviewUsageInsights({ facade, insights, llmFacade, skillId }: {
  facade: SkillDetailFacade;
  insights: SkillDetailInsights;
  llmFacade?: Pick<LlmAdminFacade, "readRuntimeStatus">;
  skillId: string;
}) {
  const { t } = useTranslation();
  return (
    <details className="sh-skill-detail-review__supplemental" open>
      <summary>{t("skillDetail.review.insights.heading")}</summary>
      <h3>{t("skillDetail.review.insights.dependencies")}</h3>
      {/* G-18：依赖是结构化事实——形态、路径与代理可读名。 */}
      <ul>
        {insights.dependencies.map((dependency) => (
          <li key={dependency.id}>
            {`${dependency.shapeLabel} · ${dependency.path}`}
            {dependency.agentClientId ? ` · ${readableAgentIdName(dependency.agentClientId)}` : ""}
          </li>
        ))}
      </ul>
      <SemanticDuplicatePanel
        deterministicCandidates={insights.deterministicDuplicates}
        facade={facade}
        llmFacade={llmFacade}
        skillId={skillId}
      />
      <h3>{t("skillDetail.review.insights.usageEvidence")}</h3>
      <p>{insights.usageEvidence
        ? t("skillDetail.review.insights.usageCount", { count: insights.usageEvidence.invocationCount })
        : t("skillDetail.review.insights.usageEmpty")}</p>
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
function ReviewGraphEntry({ graphHref, graphSource }: { graphHref: string; graphSource?: GraphSourceContext }) {
  const { t } = useTranslation();
  return (
    <Link
      className="sh-button sh-button--ghost sh-button--sm sh-skill-detail-review__accent-action"
      state={graphSource ? { graphSource } : undefined}
      to={graphHref}
    >
      <Icon aria-hidden="true" name="relationships" size={16} />
      {t("skillDetail.review.graph")}
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
  const { t } = useTranslation();
  if (!destinations) return null;
  if (destinations.state === "loading") {
    return <p data-testid="usage-destinations-loading" role="status">{t("skillDetail.review.usage.loading")}</p>;
  }
  if (destinations.state === "unavailable") {
    return <p data-testid="usage-destinations-error" role="alert">{t("skillDetail.review.usage.error")}</p>;
  }
  if (destinations.cards.length === 0) {
    return (
      <p data-testid="usage-destinations-empty">
        {t("skillDetail.review.usage.empty")}
      </p>
    );
  }
  return (
    <div aria-label={t("skillDetail.review.usage.label")} className="sh-skill-detail-review__destinations">
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
  const { t } = useTranslation();
  const healthNote = card.unhealthy ? t("skillDetail.review.usage.health") : "";
  const detail = card.takenOver
    ? t("skillDetail.review.usage.managedLink", {
      shared: card.targetKind === "shared_directory" ? t("skillDetail.review.usage.sharedManaged") : "",
      health: healthNote ? ` ${healthNote}` : "",
    })
    : t("skillDetail.review.usage.unmanagedCopy", { health: healthNote ? ` ${healthNote}` : "" });
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
            <strong>{projectDisplayName(card.path) ?? t("skillDetail.review.usage.projectLocation")}</strong>
          ) : (
            <AgentPresentation agentId={card.agentClientIds[0] ?? ""} />
          )}
        </div>
        <StatusBadge tone={card.takenOver ? "success" : "warning"}>
          {t(card.takenOver ? "skillDetail.review.usage.managed" : "skillDetail.review.usage.unmanaged")}
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
          {t(card.targetKind === "project" ? "skillDetail.review.usage.enterProject" : "skillDetail.review.usage.enterAgent")}
        </Button>
        {onOpenGovernance ? (
          <Button onClick={() => onOpenGovernance(card.relationId)} size="sm" variant="ghost">
            {t("skillDetail.review.usage.governance")}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

// W3-4: source status and choices come from the facade; labels come from i18n.
const CHECK_RESULT_KEYS: Record<SourceState, string> = {
  up_to_date: "upToDate",
  update_available: "updateAvailable",
  update_available_with_local_changes: "updateAvailableLocalChanges",
  no_upstream: "noUpstream",
  source_unavailable: "unavailable",
  authentication_required: "authentication",
};

function ReviewSourceUpdates({ facade, skillId, summary }: {
  facade: SkillDetailFacade;
  skillId: string;
  summary: SkillDetailSummary;
}) {
  const { t, i18n } = useTranslation();
  const localize = (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never));
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryFn: () => facade.getSourceUpdateStatus(skillId),
    queryKey: skillDetailKeys.sourceUpdateStatus(skillId),
    retry: false,
  });
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
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
      setNotice(localize(`skillDetail.review.source.checkResult.${CHECK_RESULT_KEYS[result.state]}`));
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
      setNotice(localize("skillDetail.review.source.status.ignored"));
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
          ? localize("skillDetail.review.source.adoptionNeedsReview")
          : localize("skillDetail.review.source.adoptionComplete"),
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
      setNotice(localize("skillDetail.review.source.linkedNotice"));
      setActionError(null);
      invalidateSourceFacts();
    },
    onError: (reason: unknown) => setRelinkError(describeError(reason)),
  });
  const unlinkMutation = useMutation({
    mutationFn: (expectedSourceRevision: string) =>
      facade.unlinkUpdateSource(skillId, expectedSourceRevision),
    onSuccess: () => {
      setUnlinkOpen(false);
      setNotice(localize("skillDetail.review.source.unlinkedNotice"));
      setActionError(null);
      invalidateSourceFacts();
    },
    onError: (reason: unknown) => {
      setNotice(null);
      setActionError(describeError(reason));
    },
  });

  const status = statusQuery.data;
  const hasSource = status !== undefined && status.association !== null;
  const candidateAvailable = status !== undefined
    && status.check_capability === "git_repository"
    && (status.state === "update_available" || status.state === "update_available_with_local_changes")
    && !status.candidate_ignored
    && status.candidate_identity !== null;
  let stateText: string;
  if (statusQuery.isPending) stateText = localize("skillDetail.review.source.status.loading");
  else if (statusQuery.isError || status === undefined) stateText = localize("skillDetail.review.source.status.unavailable");
  else if (status.state === null) {
    if (!status.association) stateText = localize("skillDetail.review.source.status.noAssociation");
    else if (status.check_capability === "local_directory") {
      stateText = localize("skillDetail.review.source.status.localUnsupported");
    } else if (status.check_capability === "unsupported") {
      stateText = localize("skillDetail.review.source.status.unsupported");
    } else {
      stateText = localize("skillDetail.review.source.status.gitNotChecked");
    }
  }
  else {
    switch (status.state) {
      case "no_upstream":
        if (status.check_capability === "local_directory") {
          stateText = localize("skillDetail.review.source.status.noUpstreamLocal");
        } else if (status.association === null) {
          stateText = localize("skillDetail.review.source.status.noAssociationAvailable");
        } else {
          stateText = localize("skillDetail.review.source.status.noUpstream");
        }
        break;
      case "up_to_date": stateText = localize("skillDetail.review.source.status.upToDate"); break;
      case "update_available": stateText = localize("skillDetail.review.source.status.updateAvailable", { label: status.upstream_label ? ` (${status.upstream_label})` : "" }); break;
      case "update_available_with_local_changes": stateText = localize("skillDetail.review.source.status.updateAvailableLocalChanges", { label: status.upstream_label ? ` (${status.upstream_label})` : "" }); break;
      case "source_unavailable": stateText = localize("skillDetail.review.source.status.sourceUnavailable"); break;
      case "authentication_required": stateText = localize("skillDetail.review.source.status.authentication"); break;
    }
    if (status.candidate_ignored) stateText += localize("skillDetail.review.source.status.ignored");
  }

  return (
    <section className="sh-skill-detail-review__source-updates" aria-label={localize("skillDetail.review.source.heading")}>
      <div className="sh-skill-detail-review__section-heading">
        <div>
          <h3>{localize("skillDetail.review.source.heading")}</h3>
          <p>{stateText}</p>
          {status?.checked_at ? <p className="sh-skill-detail-review__secondary">{localize("skillDetail.review.source.recentCheck", { date: formatTimestamp(status.checked_at, locale) })}</p> : null}
        </div>
      </div>
      {status?.association ? (
        <p className="sh-skill-detail-review__source-association">
          {localize("skillDetail.review.source.currentSource", { kind: localize(`skillDetail.review.source.kind.${status.association.source.kind}`) })}
        </p>
      ) : null}
      <p>{localize("skillDetail.review.source.associationNote")}</p>
      {notice ? <p role="status">{notice}</p> : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      <div className="sh-skill-detail-review__source-actions">
        <Button
          disabled={status?.check_capability !== "git_repository"}
          loading={checkMutation.isPending}
          onClick={() => checkMutation.mutate()}
          size="sm"
          variant="secondary"
        >
          {t("skillDetail.sourceUpdates.actions.check")}
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
            {hasSource
              ? t("skillDetail.sourceUpdates.actions.replace")
              : t("skillDetail.sourceUpdates.actions.associate")}
          </Button>
        ) : null}
        {hasSource && status?.association_revision ? (
          <Button
            onClick={() => {
              setActionError(null);
              setUnlinkOpen(true);
            }}
            size="sm"
            variant="ghost"
          >
            {t("skillDetail.sourceUpdates.actions.unlink")}
          </Button>
        ) : null}
        {candidateAvailable ? (
          <>
            <Button onClick={() => void preparePreview()} size="sm">{localize("skillDetail.review.source.actions.preview")}</Button>
            <Button
              loading={ignoreMutation.isPending}
              onClick={() => ignoreMutation.mutate(status.candidate_identity as string)}
              size="sm"
              variant="ghost"
            >
              {localize("skillDetail.review.source.actions.ignore")}
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
            <Dialog.Title>{localize(hasSource ? "skillDetail.review.source.replaceTitle" : "skillDetail.review.source.associateTitle")}</Dialog.Title>
            <Dialog.Description>{localize("skillDetail.review.source.relinkDescription")}</Dialog.Description>
            <label className="sh-skill-detail-review__dialog-field">
              {localize("skillDetail.review.source.sourceType")}
              <select
                onChange={(event) => setRelinkKind(event.currentTarget.value as SourceRelinkInput["kind"])}
                value={relinkKind}
              >
                <option value="https">HTTPS URL</option>
                <option value="git">{localize("skillDetail.review.source.gitRepository")}</option>
                <option value="local">{localize("skillDetail.review.source.localFolder")}</option>
              </select>
            </label>
            <label className="sh-skill-detail-review__dialog-field">
              {localize("skillDetail.review.source.sourceAddress")}
              <input onChange={(event) => setRelinkValue(event.currentTarget.value)} value={relinkValue} />
            </label>
            {relinkError ? <p role="alert">{relinkError}</p> : null}
            <div className="sh-dialog__actions">
              <Button onClick={() => setRelinkOpen(false)} size="sm" variant="ghost">{localize("skillDetail.review.source.close")}</Button>
              <Button
                disabled={!relinkValue.trim()}
                loading={relinkMutation.isPending}
                onClick={() => relinkMutation.mutate({ kind: relinkKind, value: relinkValue.trim() })}
                size="sm"
                variant="secondary"
              >
                {localize(hasSource ? "skillDetail.review.source.confirmReplace" : "skillDetail.review.source.confirmAssociate")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={unlinkOpen}
        onOpenChange={(open) => {
          setUnlinkOpen(open);
          if (!open) setActionError(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="sh-dialog__overlay" />
          <Dialog.Content className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>{localize("skillDetail.review.source.unlinkTitle")}</Dialog.Title>
            <Dialog.Description>
              {localize("skillDetail.review.source.unlinkDescription")}
            </Dialog.Description>
            {actionError ? <p role="alert">{actionError}</p> : null}
            <div className="sh-dialog__actions">
              <Button onClick={() => setUnlinkOpen(false)} size="sm" variant="ghost">
                {localize("skillDetail.review.source.keepLinked")}
              </Button>
              <Button
                disabled={!status?.association_revision}
                loading={unlinkMutation.isPending}
                onClick={() => {
                  if (status?.association_revision) {
                    unlinkMutation.mutate(status.association_revision);
                  }
                }}
                size="sm"
                variant="secondary"
              >
                {localize("skillDetail.review.source.confirmUnlink")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sh-dialog__overlay" />
          <Dialog.Content aria-describedby="review-source-adopt-description" className="sh-dialog sh-dialog__content sh-skill-detail-review__dialog">
            <Dialog.Title>{localize("skillDetail.review.source.previewTitle")}</Dialog.Title>
            <Dialog.Description id="review-source-adopt-description">{localize("skillDetail.review.source.previewDescription")}</Dialog.Description>
            {preview?.upstream_label ? <p>{localize("skillDetail.review.source.sourceVersion", { version: preview.upstream_label })}</p> : null}
            <ul>
              {(preview?.files ?? []).map((file) => (
                <li key={file.path}>{`${file.path} (${localize(`skillDetail.review.source.${file.change}`)})`}</li>
              ))}
            </ul>
            {preview ? <p>{localize("skillDetail.review.source.previewExpiry", { date: formatTimestamp(preview.expires_at, locale) })}</p> : null}
            {commitError ? <p role="alert">{commitError}</p> : null}
            <div className="sh-dialog__actions">
              <Button onClick={() => setPreviewOpen(false)} size="sm" variant="ghost">{localize("skillDetail.review.source.cancel")}</Button>
              <Button
                disabled={!preview}
                loading={commitMutation.isPending}
                onClick={() => { if (preview) commitMutation.mutate(preview); }}
                size="sm"
              >
                {localize("skillDetail.review.source.confirmAdopt")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {summary.upstreamLineage ? (
        <div className="sh-skill-detail-review__action-impact">
          <h3>{localize("skillDetail.review.source.lineageHeading")}</h3>
          <p>
            {localize("skillDetail.review.source.lineagePrefix")}
            {summary.upstreamLineage.source_exists === false ? (
              <span>
                {summary.upstreamLineage.source_display_name ?? localize("skillDetail.review.source.unresolved")}
                {localize("skillDetail.review.source.deleted")}
              </span>
            ) : (
              <Link to={`/library/${encodeURIComponent(summary.upstreamLineage.source_skill_id)}`}>
                {summary.upstreamLineage.source_display_name ?? localize("skillDetail.review.source.unresolved")}
              </Link>
            )}
            {" "}{localize("skillDetail.review.source.lineageDescription")}
          </p>
        </div>
      ) : (
        <p>{localize("skillDetail.review.source.noLineage")}</p>
      )}
    </section>
  );
}

function ReviewImportRecord({ provenance }: { provenance: SkillProvenance }) {
  const { i18n, t } = useTranslation();
  const record = provenance.provenance;
  if (!record) return <p>{t("skillDetail.review.import.noRecord")}</p>;
  const locale = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en-US";
  const localize = (key: string) => String(t(key as never));
  return (
    <dl className="sh-skill-detail-review__record">
      <div><dt>{localize("skillDetail.review.import.type")}</dt><dd>{localize(`skillDetail.review.import.kind.${record.sourceKind}`)}</dd></div>
      <div><dt>{localize("skillDetail.review.import.time")}</dt><dd>{formatTimestamp(record.importedAt, locale)}</dd></div>
      <div><dt>{localize("skillDetail.review.import.originalLocation")}</dt><dd><code title={record.originalPath}>{record.originalPath}</code></dd></div>
      <div><dt>{localize("skillDetail.review.import.sourceRecord")}</dt><dd><code title={record.sourceLocator}>{record.sourceLocator}</code></dd></div>
      <div><dt>{localize("skillDetail.review.import.explanationLabel")}</dt><dd>{localize("skillDetail.review.import.explanation")}</dd></div>
    </dl>
  );
}
