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
  /** 仅子页使用：返回发现主页（路由层显式导航到 /discovery）。 */
  onBack?: () => void;
  importFacade?: ImportFacade;
  /** When provided, the local discovery card renders the FE-07 workbench. */
  discoveryFacade?: DiscoveryFacade;
  initialSources?: string[];
  initialSourceText?: string;
  /** 全局操作跟踪；测试可注入独立实例，默认模块级单例（跨路由存续）。 */
  tracker?: OperationTracker;
  onImportComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
}

/** 子页内共享的导入向导控制器：状态与拦截逻辑保持单一实现。 */
interface WizardController {
  showImport: boolean;
  importBlocked: boolean;
  importGuide: string | undefined;
  wizardInitialSources: string[];
  openWizardWithDirectory: (directory: string) => void;
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
  icon: string;
  titleKey: HomeCardTextKey;
  descriptionKey: HomeCardTextKey;
  noteKey?: HomeCardTextKey;
  secondary?: boolean;
}

const HOME_CARDS: HomeCardSpec[] = [
  {
    view: "local",
    icon: "⌂",
    titleKey: "discovery.home.cards.local.title",
    descriptionKey: "discovery.home.cards.local.description",
  },
  {
    view: "online",
    icon: "↗",
    titleKey: "discovery.home.cards.online.title",
    descriptionKey: "discovery.home.cards.online.description",
  },
  {
    view: "repo",
    icon: "⭳",
    titleKey: "discovery.home.cards.repo.title",
    descriptionKey: "discovery.home.cards.repo.description",
  },
  {
    view: "lock",
    icon: "⇣",
    titleKey: "discovery.home.cards.lock.title",
    descriptionKey: "discovery.home.cards.lock.description",
    noteKey: "discovery.home.cards.lock.note",
    secondary: true,
  },
];

export function DiscoveryPage({
  view = "home",
  onNavigate,
  onBack,
  importFacade = nativeImportFacade,
  discoveryFacade,
  initialSources = [],
  initialSourceText,
  tracker = operationTracker,
  onImportComplete,
  onOpenLibrary,
}: DiscoveryPageProps) {
  const { t } = useTranslation();
  const [showImport, setShowImport] = useState(Boolean(initialSourceText) || initialSources.length > 0);
  const [wizardSources, setWizardSources] = useState<string[] | null>(null);
  const [importBlocked, setImportBlocked] = useState(false);
  // AR-014：后台导入进行中时禁止再次提交导入，统一在打开向导的入口拦截。
  const importRunning = useHasRunningOperation(tracker, "import");
  const importGuide = initialSources.length > 1
    ? t("discovery.onboardingImportGuideMultiple", { count: initialSources.length })
    : initialSources.length === 1
      ? t("discovery.onboardingImportGuideSingle")
      : undefined;

  // 下载并导入：临时下载目录以本地来源身份进入现有导入向导。
  const openWizardWithDirectory = (directory: string) => {
    if (importRunning) {
      setImportBlocked(true);
      return;
    }
    setImportBlocked(false);
    setWizardSources([directory]);
    setShowImport(true);
  };
  const openImportWizard = () => {
    if (importRunning) {
      setImportBlocked(true);
      return;
    }
    setImportBlocked(false);
    setShowImport(true);
  };
  const closeWizard = () => {
    setShowImport(false);
    setWizardSources(null);
    setImportBlocked(false);
  };
  const wizard: WizardController = {
    showImport,
    importBlocked,
    importGuide,
    wizardInitialSources: wizardSources ?? initialSources,
    openWizardWithDirectory,
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
      initialSourceText={initialSourceText}
      onBack={onBack}
      onImportComplete={onImportComplete}
      onOpenLibrary={onOpenLibrary}
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
              <span aria-hidden="true" className="sh-discovery-home__icon">{card.icon}</span>
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
  onBack?: () => void;
  facade?: DiscoveryFacade;
  wizard: WizardController;
  importFacade: ImportFacade;
  initialSourceText?: string;
  tracker: OperationTracker;
  onImportComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
}

/**
 * AR-012：每种发现方式的独立子页，承载原有的搜索、配置、结果与导入操作；
 * 顶部提供"返回发现主页"，导入向导保留在子页内切换。
 */
function DiscoveryModulePage({
  view,
  onBack,
  facade,
  wizard,
  importFacade,
  initialSourceText,
  tracker,
  onImportComplete,
  onOpenLibrary,
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
          onComplete={onImportComplete}
          onOpenLibrary={onOpenLibrary}
          tracker={tracker}
        />
      </div>
    );
  }

  return (
    <div className="sh-discovery-page">
      <div className="sh-discovery-page__backdrop">
        <button className="sh-discovery-page__back" onClick={onBack} type="button">
          {t("discovery.subpage.back")}
        </button>
      </div>
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
          {facade ? <LocalDiscoveryWorkbench facade={facade} /> : null}
          <LocalDiscovery onStartImport={wizard.openImportWizard} />
        </>
      ) : null}
      {view === "online" ? (
        <OnlineDiscovery
          facade={facade}
          onImportDirectory={wizard.openWizardWithDirectory}
          onStartImport={wizard.openImportWizard}
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
