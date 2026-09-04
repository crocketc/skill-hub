import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ImportWizard } from "../import/ImportWizard";
import { type ImportFacade, type ImportResult } from "../import/api";
import { nativeImportFacade } from "../import/nativeApi";
import { LocalDiscovery } from "./LocalDiscovery";
import { OnlineDiscovery } from "./OnlineDiscovery";

export interface DiscoveryPageProps {
  importFacade?: ImportFacade;
  initialSources?: string[];
  initialSourceText?: string;
  onImportComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
}

export function DiscoveryPage({
  importFacade = nativeImportFacade,
  initialSources = [],
  initialSourceText,
  onImportComplete,
  onOpenLibrary,
}: DiscoveryPageProps) {
  const { t } = useTranslation();
  const [showImport, setShowImport] = useState(Boolean(initialSourceText));
  const importGuide = initialSources.length > 1
    ? t("discovery.onboardingImportGuideMultiple", { count: initialSources.length })
    : initialSources.length === 1
      ? t("discovery.onboardingImportGuideSingle")
      : undefined;

  if (showImport) {
    return (
      <div className="sh-discovery-page sh-discovery-page--import">
        <div className="sh-discovery-page__backdrop">
          <button className="sh-discovery-page__back" onClick={() => setShowImport(false)} type="button">
            {t("actions.back")}
          </button>
        </div>
        <ImportWizard
          facade={importFacade}
          importGuide={importGuide}
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
        <LocalDiscovery onStartImport={() => setShowImport(true)} />
        <OnlineDiscovery onStartImport={() => setShowImport(true)} />
      </div>
    </div>
  );
}
