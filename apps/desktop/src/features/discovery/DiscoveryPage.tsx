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
import { LocalDiscovery } from "./LocalDiscovery";
import { LocalDiscoveryWorkbench } from "./LocalDiscoveryWorkbench";
import { OnlineDiscovery } from "./OnlineDiscovery";
import { AgentsLockDiscovery } from "./AgentsLockDiscovery";
import { RepoDiscovery } from "./RepoDiscovery";
import type { DiscoveryFacade } from "./api";

export interface DiscoveryPageProps {
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

export function DiscoveryPage({
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
  const wizardInitialSources = wizardSources ?? initialSources;

  if (showImport) {
    return (
      <div className="sh-discovery-page sh-discovery-page--import">
        <div className="sh-discovery-page__backdrop">
          <button className="sh-discovery-page__back" onClick={closeWizard} type="button">
            {t("actions.back")}
          </button>
        </div>
        <ImportWizard
          facade={importFacade}
          importGuide={importGuide}
          initialSources={wizardInitialSources}
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
      <div className="sh-discovery-page__heading">
        <div>
          <p className="sh-discovery-page__eyebrow">{t("discovery.eyebrow")}</p>
          <h1>{t("discovery.title")}</h1>
          <p>{t("discovery.description")}</p>
        </div>
        <span className="sh-discovery-page__count">{t("discovery.scope")}</span>
      </div>
      {importBlocked ? (
        <p role="alert" className="sh-discovery-page__notice">
          {t("discovery.importRunning")}
        </p>
      ) : null}
      <div className="sh-discovery-page__grid">
        <div className="sh-discovery-page__local">
          {discoveryFacade ? <LocalDiscoveryWorkbench facade={discoveryFacade} /> : null}
          <LocalDiscovery onStartImport={openImportWizard} />
        </div>
        <OnlineDiscovery facade={discoveryFacade} onStartImport={openImportWizard} />
        {discoveryFacade ? (
          <RepoDiscovery facade={discoveryFacade} onImportDirectory={openWizardWithDirectory} />
        ) : null}
        {discoveryFacade ? (
          <AgentsLockDiscovery facade={discoveryFacade} onImportDirectory={openWizardWithDirectory} />
        ) : null}
      </div>
    </div>
  );
}
