import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ImportWizard } from "../import/ImportWizard";
import { type ImportFacade, type ImportResult } from "../import/api";
import { nativeImportFacade } from "../import/nativeApi";
import {
  operationTracker,
  useHasRunningOperation,
  type OperationTracker,
} from "../../platform/operationTracker";
import { Button } from "../../ui/Button";
import { Icon, type IconName } from "../../ui/Icon";
import { LocalDiscovery } from "./LocalDiscovery";
import { LocalDiscoveryWorkbench } from "./LocalDiscoveryWorkbench";
import { OnlineDiscovery } from "./OnlineDiscovery";
import { AgentsLockDiscovery } from "./AgentsLockDiscovery";
import { RepoDiscovery } from "./RepoDiscovery";
import type { DiscoveryFacade } from "./api";

/** 主页四张固定模块卡片对应的子页视图。 */
export type DiscoveryModuleView = "local" | "online" | "repo" | "lock";
export type DiscoveryView = "home" | DiscoveryModuleView;

export interface DiscoveryPageProps {
  /** 渲染哪一屏：模块网格主页（默认）或单个模块子页。 */
  view?: DiscoveryView;
  /** 仅主页使用：进入某个模块子页（路由层映射到 /discovery/<view>）。 */
  onNavigate?: (view: DiscoveryModuleView) => void;
  importFacade?: ImportFacade;
  /** When provided, the local discovery card renders the FE-07 workbench. */
  discoveryFacade?: DiscoveryFacade;
  initialSources?: string[];
  initialSourceText?: string;
  /** 初始化向导/重新扫描交接进入的批量导入：隐藏手动追加来源按钮。 */
  onboardingImport?: boolean;
  /** 全局操作跟踪；测试可注入独立实例，默认模块级单例（跨路由存续）。 */
  tracker?: OperationTracker;
  onImportComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
  /** AI 就绪提示的"前往设置"动作；路由层注入应用内导航，缺省整页跳转兜底。 */
  onOpenSettings?: () => void;
  /** C2 收口：可选地提供库内 Skill 显示名，用于在线结果"已在库"标记。 */
  importedNames?: () => Promise<string[]>;
}

/** 子页内共享的导入向导控制器：状态与拦截逻辑保持单一实现。 */
interface WizardController {
  showImport: boolean;
  importBlocked: boolean;
  importGuide: string | undefined;
  wizardInitialSources: string[];
  /** 向导变体：onboarding 语义下隐藏手动追加来源入口。 */
  variant: "onboarding" | "standard";
  openWizardWithDirectory: (directory: string) => void;
  /** P1-04：在线单 Skill 专用安装——下载目录为唯一来源的受限向导。 */
  openWizardWithSingleSkill: (directory: string) => void;
  /** P1-04：把本次扫描候选目录作为向导来源（审查并导入链路）。 */
  openWizardWithCandidates: (candidatePaths: string[]) => void;
  openImportWizard: () => void;
  closeWizard: () => void;
}

/** AR-012：主页固定模块卡片规格；lock 卡片按 AR-013 降级为最后的次级来源。 */
type HomeCardTextKey =
  | "discovery.home.cards.local.title"
  | "discovery.home.cards.local.description"
  | "discovery.home.cards.online.title"
  | "discovery.home.cards.online.description"
  | "discovery.home.cards.repo.title"
  | "discovery.home.cards.repo.description"
  | "discovery.home.cards.lock.title"
  | "discovery.home.cards.lock.description"
  | "discovery.home.cards.lock.note";

interface HomeCardSpec {
  view: DiscoveryModuleView;
  /** ui/Icon 功能注册表名；与品牌 Logo 注册表严格分离。 */
  icon: IconName;
  titleKey: HomeCardTextKey;
  descriptionKey: HomeCardTextKey;
  noteKey?: HomeCardTextKey;
  secondary?: boolean;
}

const HOME_CARDS: HomeCardSpec[] = [
  {
    view: "local",
    icon: "overview",
    titleKey: "discovery.home.cards.local.title",
    descriptionKey: "discovery.home.cards.local.description",
  },
  {
    view: "online",
    icon: "open-external",
    titleKey: "discovery.home.cards.online.title",
    descriptionKey: "discovery.home.cards.online.description",
  },
  {
    view: "repo",
    icon: "import",
    titleKey: "discovery.home.cards.repo.title",
    descriptionKey: "discovery.home.cards.repo.description",
  },
  {
    view: "lock",
    icon: "operations",
    titleKey: "discovery.home.cards.lock.title",
    descriptionKey: "discovery.home.cards.lock.description",
    noteKey: "discovery.home.cards.lock.note",
    secondary: true,
  },
];

export function DiscoveryPage({
  view = "home",
  onNavigate,
  importFacade = nativeImportFacade,
  discoveryFacade,
  initialSources = [],
  initialSourceText,
  onboardingImport = false,
  tracker = operationTracker,
  onImportComplete,
  onOpenLibrary,
  onOpenSettings,
  importedNames,
}: DiscoveryPageProps) {
  const { t } = useTranslation();
  const [showImport, setShowImport] = useState(Boolean(initialSourceText) || initialSources.length > 0);
  const [wizardSources, setWizardSources] = useState<string[] | null>(null);
  const [importBlocked, setImportBlocked] = useState(false);
  // P1-04：单 Skill 安装/审查并导入等入口的向导导语覆盖；空向导入口会清除。
  const [wizardGuideOverride, setWizardGuideOverride] = useState<string | undefined>(undefined);
  // P1-04：单 Skill 安装以 onboarding 语义打开（隐藏手动追加来源入口）。
  const [wizardVariantOverride, setWizardVariantOverride] = useState<"onboarding" | "standard" | null>(null);
  // AR-014：后台导入进行中时禁止再次提交导入，统一在打开向导的入口拦截。
  const importRunning = useHasRunningOperation(tracker, "import");
  const importGuide = wizardGuideOverride ?? (initialSources.length > 1
    ? t("discovery.onboardingImportGuideMultiple", { count: initialSources.length })
    : initialSources.length === 1
      ? t("discovery.onboardingImportGuideSingle")
      : undefined);

  // 下载并导入：临时下载目录以本地来源身份进入现有导入向导。
  const openWizardWithDirectory = (directory: string) => {
    if (importRunning) {
      setImportBlocked(true);
      return;
    }
    setImportBlocked(false);
    setWizardSources([directory]);
    setWizardGuideOverride(undefined);
    setWizardVariantOverride(null);
    setShowImport(true);
  };
  // P1-04：在线单 Skill 专用安装——下载目录是唯一来源，复用 onboarding
  // 变体隐藏"手动追加来源"，导语注明单 Skill 安装；不夹带仓库内其他 Skill。
  const openWizardWithSingleSkill = (directory: string) => {
    if (importRunning) {
      setImportBlocked(true);
      return;
    }
    setImportBlocked(false);
    setWizardSources([directory]);
    setWizardGuideOverride(t("discovery.online.singleInstallGuide"));
    setWizardVariantOverride("onboarding");
    setShowImport(true);
  };
  const openImportWizard = () => {
    if (importRunning) {
      setImportBlocked(true);
      return;
    }
    setImportBlocked(false);
    setWizardSources(null);
    setWizardGuideOverride(undefined);
    setWizardVariantOverride(null);
    setShowImport(true);
  };
  // P1-04：审查并导入——本次扫描发现的候选目录即向导来源，默认全选；
  // 每个候选以 SKILL.md 所在目录（DiscoveredSkill.path）为单位，绝不
  // 要求用户从零重新选择目录。
  const openWizardWithCandidates = (candidatePaths: string[]) => {
    if (importRunning) {
      setImportBlocked(true);
      return;
    }
    setImportBlocked(false);
    const directories = Array.from(new Set(candidatePaths.map((path) => path.trim()).filter(Boolean)));
    if (directories.length === 0) {
      openImportWizard();
      return;
    }
    setWizardSources(directories);
    setWizardGuideOverride(
      t("discovery.workbench.reviewImportGuide", { count: directories.length }),
    );
    setShowImport(true);
  };
  const closeWizard = () => {
    setShowImport(false);
    setWizardSources(null);
    setImportBlocked(false);
    setWizardGuideOverride(undefined);
    setWizardVariantOverride(null);
  };
  const wizard: WizardController = {
    showImport,
    importBlocked,
    importGuide,
    wizardInitialSources: wizardSources ?? initialSources,
    variant: wizardVariantOverride ?? (onboardingImport ? "onboarding" : "standard"),
    openWizardWithDirectory,
    openWizardWithSingleSkill,
    openWizardWithCandidates,
    openImportWizard,
    closeWizard,
  };

  if (view === "home") {
    return <DiscoveryHome onNavigate={onNavigate} />;
  }
  return (
    <DiscoveryModulePage
      facade={discoveryFacade}
      importFacade={importFacade}
      importedNames={importedNames}
      initialSourceText={initialSourceText}
      onImportComplete={onImportComplete}
      onOpenLibrary={onOpenLibrary}
      onOpenSettings={onOpenSettings}
      tracker={tracker}
      view={view}
      wizard={wizard}
    />
  );
}

function DiscoveryHome({ onNavigate }: { onNavigate?: (view: DiscoveryModuleView) => void }) {
  const { t } = useTranslation();
  return (
    <div className="sh-discovery-page">
      <div className="sh-discovery-page__heading">
        <div>
          <p className="sh-discovery-page__eyebrow">{t("discovery.eyebrow")}</p>
          <h1>{t("discovery.title")}</h1>
          <p>{t("discovery.description")}</p>
        </div>
        <span className="sh-discovery-page__count">{t("discovery.scope")}</span>
      </div>
      <div className="sh-discovery-home__grid">
        {HOME_CARDS.map((card) => {
          const title = t(card.titleKey);
          return (
            <article
              key={card.view}
              className={
                card.secondary
                  ? "sh-discovery-home__card sh-discovery-home__card--secondary"
                  : "sh-discovery-home__card"
              }
            >
              <span aria-hidden="true" className="sh-discovery-home__icon">
                <Icon name={card.icon} size={20} />
              </span>
              <h2 className="sh-discovery-home__title">{title}</h2>
              <p className="sh-discovery-home__description">{t(card.descriptionKey)}</p>
              {card.noteKey ? (
                <p className="sh-discovery-home__note">{t(card.noteKey)}</p>
              ) : null}
              <Button
                aria-label={t("discovery.home.enterAria", { module: title })}
                onClick={() => onNavigate?.(card.view)}
                variant="secondary"
              >
                {t("discovery.home.enter")}
              </Button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

interface DiscoveryModulePageProps {
  view: DiscoveryModuleView;
  facade?: DiscoveryFacade;
  wizard: WizardController;
  importFacade: ImportFacade;
  initialSourceText?: string;
  tracker: OperationTracker;
  onImportComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
  /** AI 就绪提示的"前往设置"动作；路由层注入应用内导航，缺省整页跳转兜底。 */
  onOpenSettings?: () => void;
  /** C2 收口：可选地提供库内 Skill 显示名，用于在线结果"已在库"标记。 */
  importedNames?: () => Promise<string[]>;
}

/**
 * AR-012：每种发现方式的独立子页，承载原有的搜索、配置、结果与导入操作；
 * 返回发现主页由壳层顶栏承载（子路由 fallback），导入向导保留在子页内切换。
 */
function DiscoveryModulePage({
  view,
  facade,
  wizard,
  importFacade,
  initialSourceText,
  tracker,
  onImportComplete,
  onOpenLibrary,
  onOpenSettings,
  importedNames,
}: DiscoveryModulePageProps) {
  const { t } = useTranslation();

  if (wizard.showImport) {
    return (
      <div className="sh-discovery-page sh-discovery-page--import">
        <div className="sh-discovery-page__backdrop">
          <button className="sh-discovery-page__back" onClick={wizard.closeWizard} type="button">
            {t("actions.back")}
          </button>
        </div>
        <ImportWizard
          facade={importFacade}
          importGuide={wizard.importGuide}
          initialSources={wizard.wizardInitialSources}
          initialSourceText={initialSourceText}
          variant={wizard.variant}
          onComplete={onImportComplete}
          onOpenLibrary={onOpenLibrary}
          tracker={tracker}
        />
      </div>
    );
  }

  return (
      <div className="sh-discovery-page">
        {view === "lock" ? (
        <p className="sh-discovery-subpage__note">{t("discovery.lockNote")}</p>
      ) : null}
      {wizard.importBlocked ? (
        <p role="alert" className="sh-discovery-page__notice">
          {t("discovery.importRunning")}
        </p>
      ) : null}
      {view === "local" ? (
        <>
          {/* M-18：本地发现区域（导入 Skill 入口）先于工作台渲染，
              Agent 目录盘点再多也不把操作推出首屏。 */}
          <LocalDiscovery onStartImport={wizard.openImportWizard} />
          {facade ? (
            <LocalDiscoveryWorkbench
              facade={facade}
              // P1-04：审查并导入以候选的 SKILL.md 所在目录为单位带入向导。
              onReviewCandidates={(candidates) =>
                wizard.openWizardWithCandidates(candidates.map((candidate) => candidate.path))}
            />
          ) : null}
        </>
      ) : null}
      {view === "online" ? (
        <OnlineDiscovery
          importedNames={importedNames}
          facade={facade}
          // P1-04：在线安装走单 Skill 专用安装入口（下载目录=唯一来源）。
          onImportDirectory={wizard.openWizardWithSingleSkill}
          onStartImport={wizard.openImportWizard}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
      {view === "repo" && facade ? (
        <RepoDiscovery facade={facade} onImportDirectory={wizard.openWizardWithDirectory} />
      ) : null}
      {view === "lock" && facade ? (
        <AgentsLockDiscovery facade={facade} onImportDirectory={wizard.openWizardWithDirectory} />
      ) : null}
    </div>
  );
}
