import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { AgentPresentation, inferAgentKindKey, readableAgentIdName } from "../../ui/AgentPresentation";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { StatusBadge } from "../../ui/StatusBadge";
import { formatTimestamp } from "../../i18n";
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
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  detailPathname: string;
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
 * 来源更新示例流保持原型确认行为，接真实数据由后续任务裁决。
 */
export function SkillDetailReviewExperience({
  adjacent,
  backSearch,
  detailPathname,
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
                  <ReviewOverviewStatus summary={summary} />
                  <ReviewSubjectLocation />
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
              <ReviewSourceUpdates markdownFacade={markdownFacade} />
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

function ReviewSourceUpdates({ markdownFacade }: { markdownFacade?: MarkdownFacade }) {
  const [sourceState, setSourceState] = useState<"missing" | "linked">("missing");
  const [lookup, setLookup] = useState<"idle" | "verified" | "failed">("idle");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<"associate" | "replace" | "adopt">("associate");
  // §18.1：无来源时允许“关联并采用更新”一次确认；单独关联仍走 associate。
  const [adoptCombined, setAdoptCombined] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [localChanges, setLocalChanges] = useState(false);
  const [actionResult, setActionResult] = useState<string>();
  const [sourceInput, setSourceInput] = useState("https://example.org/pdf-reader");
  // §来源追溯：复用修改依据默认可见；DEV 场景按钮可在两态间切换演示。
  const [derived, setDerived] = useState(true);
  const [upstreamOpen, setUpstreamOpen] = useState(false);
  const confirmTitle = confirmIntent === "adopt"
    ? adoptCombined ? "关联并采用更新影响预览" : "采用网络更新影响预览"
    : confirmIntent === "replace" ? "更换网络来源影响预览"
      : "关联影响预览";
  const confirmDescription = confirmIntent === "associate" ? "关联不会采用或替换当前内容"
    : confirmIntent === "replace" ? "更换来源只变更更新关系，不会采用新内容"
      : adoptCombined ? "一次确认同时登记更新来源并采用其核验版本；当前内容保留为历史版本。"
        : "采用将以核验的来源版本创建当前 Skill 的新版本";
  return (
    <section className="sh-skill-detail-review__source-updates" aria-label="网络更新来源">
      <div className="sh-skill-detail-review__section-heading">
        <div>
          <h3>网络更新来源</h3>
          <p>{sourceState === "linked" ? "已关联：PDF Reader 官方维护仓库" : "尚未关联更新来源"}</p>
          {sourceState === "linked" ? (
            <p className="sh-skill-detail-review__source-badges" aria-label="来源形态">
              <span>网络仓库</span>
              <span>GitHub</span>
            </p>
          ) : null}
        </div>
        <Button className="sh-skill-detail-review__accent-action" onClick={() => { setLookup("idle"); setConfirmIntent(sourceState === "linked" ? "replace" : "associate"); setAdoptCombined(false); setChooserOpen(true); }} size="sm" variant="ghost">
          {sourceState === "linked" ? "更换来源" : "查找更新来源"}
        </Button>
      </div>
      <p>关联来源只建立更新关系，不会替换当前内容或自动升级。</p>
      {actionResult ? <p role="status">{actionResult}</p> : null}
      {sourceState === "linked" ? (
        <div className="sh-skill-detail-review__source-actions">
          <Button onClick={() => { setLookup("verified"); setActionResult(undefined); }} size="sm" variant="secondary">检查更新</Button>
          <Button
            onClick={() => {
              if (markdownFacade) void markdownFacade.openExternalUrl(sourceInput);
              setActionResult("原型演示：已请求在浏览器打开来源页面；不会发送技能内容或凭据。");
            }}
            size="sm"
            variant="ghost"
          >
            打开来源页面
          </Button>
          <Button onClick={() => setUnlinkOpen(true)} size="sm" variant="ghost">解除来源关联</Button>
        </div>
      ) : null}
      {sourceState === "linked" && localChanges ? <p className="sh-skill-detail-review__source-local-changes" role="status">本机内容有未同步修改。检查结果会保留为来源证据，采用前会说明覆盖影响。</p> : null}
      {lookup === "verified" && sourceState === "linked" ? (
        <div className="sh-skill-detail-review__source-candidate" role="status">
          <strong>发现可检查的上游更新</strong><span>当前内容没有被替换。</span>
          <Button onClick={() => { setAdoptCombined(false); setConfirmIntent("adopt"); setConfirmOpen(true); }} size="sm">预览采用影响</Button>
          <Button
            onClick={() => {
              setLookup("idle");
              setActionResult("已忽略本次更新；该决定只作用于这一候选，之后的新候选会再次提醒。");
            }}
            size="sm"
            variant="ghost"
          >
            忽略本次更新
          </Button>
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
                <div className="sh-skill-detail-review__source-actions">
                  <Button onClick={() => { setChooserOpen(false); setConfirmIntent(sourceState === "linked" ? "replace" : "associate"); setAdoptCombined(false); setConfirmOpen(true); }} size="sm" variant="secondary">{sourceState === "linked" ? "更换来源" : "只关联来源"}</Button>
                  {sourceState === "missing" ? (
                    <Button onClick={() => { setChooserOpen(false); setConfirmIntent("adopt"); setAdoptCombined(true); setConfirmOpen(true); }} size="sm">关联并采用更新</Button>
                  ) : null}
                </div>
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
                  setActionResult(adoptCombined
                    ? "已关联来源并采用示例更新；新版本已创建，安全发现与独立副本仍保留。"
                    : "示例更新已采用；新版本已创建，安全发现与独立副本仍保留。");
                  setAdoptCombined(false);
                } else if (confirmIntent === "replace") {
                  setActionResult("更新来源已更换；当前内容和导入记录未改变。");
                } else {
                  // §6.4：关联成功后自动进行一次只读检查，避免重复点击。
                  setLookup("verified");
                  setActionResult("已关联更新来源，并自动完成一次只读检查；未采用任何内容。");
                }
                setSourceState("linked");
                setConfirmOpen(false);
              }} size="sm">{confirmIntent === "adopt" ? (adoptCombined ? "确认关联并采用更新" : "确认采用更新") : confirmIntent === "replace" ? "确认更换来源" : "确认关联"}</Button>
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
      {derived ? <div className="sh-skill-detail-review__action-impact"><h3>复用修改的原技能</h3><p>从 PDF Reader 基础版 v2.3.2 创建，两个主体独立维护。此追溯不会自动建立网络更新来源。</p><Button onClick={() => setUpstreamOpen(true)} size="sm" variant="ghost">查看原技能</Button></div> : <p>无复用修改依据。此技能不是从其他 Skill 复用修改创建的。</p>}
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
