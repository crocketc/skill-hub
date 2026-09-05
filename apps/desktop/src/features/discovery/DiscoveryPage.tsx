import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ImportWizard } from "../import/ImportWizard";
import { type ImportFacade, type ImportResult } from "../import/api";
import { nativeImportFacade } from "../import/nativeApi";
import { LocalDiscovery } from "./LocalDiscovery";
import { LocalDiscoveryWorkbench } from "./LocalDiscoveryWorkbench";
import { OnlineDiscovery } from "./OnlineDiscovery";
import { RepoDiscovery } from "./RepoDiscovery";
import type { DiscoveryFacade } from "./api";

export interface DiscoveryPageProps {
  importFacade?: ImportFacade;
  /** When provided, the local discovery card renders the FE-07 workbench. */
  discoveryFacade?: DiscoveryFacade;
  initialSources?: string[];
  initialSourceText?: string;
  onImportComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
}

export function DiscoveryPage({
  importFacade = nativeImportFacade,
  discoveryFacade,
  initialSources = [],
  initialSourceText,
  onImportComplete,
  onOpenLibrary,
}: DiscoveryPageProps) {
  const { t } = useTranslation();
  const [showImport, setShowImport] = useState(Boolean(initialSourceText) || initialSources.length > 0);
  const [wizardSources, setWizardSources] = useState<string[] | null>(null);
  const importGuide = initialSources.length > 1
    ? t("discovery.onboardingImportGuideMultiple", { count: initialSources.length })
    : initialSources.length === 1
      ? t("discovery.onboardingImportGuideSingle")
      : undefined;

  // 下载并导入：临时下载目录以本地来源身份进入现有导入向导。
  const openWizardWithDirectory = (directory: string) => {
    setWizardSources([directory]);
    setShowImport(true);
  };
  const closeWizard = () => {
    setShowImport(false);
    setWizardSources(null);
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
      <div className="sh-discovery-page__grid">
        <div className="sh-discovery-page__local">
          {discoveryFacade ? <LocalDiscoveryWorkbench facade={discoveryFacade} /> : null}
          <LocalDiscovery onStartImport={() => setShowImport(true)} />
        </div>
        <OnlineDiscovery facade={discoveryFacade} onStartImport={() => setShowImport(true)} />
        {discoveryFacade ? (
          <RepoDiscovery facade={discoveryFacade} onImportDirectory={openWizardWithDirectory} />
        ) : null}
      </div>
    </div>
  );
}
