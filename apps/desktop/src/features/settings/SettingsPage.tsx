import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { PageHeader } from "../../ui/PageHeader";
import {
  type AppUpdate,
  errorCodeOf,
  type SettingsFacade,
  type SettingsSnapshot,
  type UpdateProgress,
  type UpdateState,
  unavailableSettingsFacade,
} from "./api";
import { AiNetworkSettings } from "./AiNetworkSettings";
import { ApplicationUpdate } from "./ApplicationUpdate";
import { AutomationSettings } from "./AutomationSettings";
import { BackupSettings } from "./BackupSettings";
import { GeneralSettings } from "./GeneralSettings";
import { LibrarySettings } from "./LibrarySettings";
import { LlmCapabilitiesSettings } from "./LlmCapabilitiesSettings";
import { LlmProvidersSettings } from "./LlmProvidersSettings";
import { NetworkStoragePlaceholder } from "./NetworkStoragePlaceholder";
import {
  sectionPanelId,
  SettingsSectionNav,
  type SettingsSection,
  type SettingsSectionId,
} from "./SettingsSectionNav";
import { ViewSettings } from "./ViewSettings";

export function SettingsPage({ facade = unavailableSettingsFacade, initialSettings }: { facade?: SettingsFacade; initialSettings?: SettingsSnapshot }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsSnapshot | undefined>(initialSettings);
  const [error, setError] = useState<string>();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("general");
  useEffect(() => { if (initialSettings || !facade.get) return; void facade.get().then(setSettings).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [facade, initialSettings]);

  if (error) return <DataState message={error} state="unavailable" />;
  if (!settings) return <DataState message={t("settings.loading")} state="loading" />;

  const sections: SettingsSection[] = [
    {
      description: t("settings.sectionDescriptions.general"),
      heading: t("settings.sections.general"),
      id: "general",
    },
    {
      description: t("settings.sectionDescriptions.dataProtection"),
      heading: t("settings.sections.dataProtection"),
      id: "dataProtection",
    },
    {
      description: t("settings.sectionDescriptions.networkAi"),
      heading: t("settings.sections.networkAi"),
      id: "networkAi",
    },
    {
      description: t("settings.sectionDescriptions.automation"),
      heading: t("settings.sections.automation"),
      id: "automation",
    },
    {
      description: t("settings.sectionDescriptions.libraryMaintenance"),
      heading: t("settings.sections.libraryMaintenance"),
      id: "libraryMaintenance",
    },
    {
      description: t("settings.sectionDescriptions.appUpdate"),
      heading: t("settings.sections.appUpdate"),
      id: "appUpdate",
    },
  ];

  const panels: Record<SettingsSectionId, ReactNode> = {
    appUpdate: (
      <>
        <ApplicationUpdateCard facade={facade} settings={settings} />
        <NetworkStoragePlaceholder />
      </>
    ),
    automation: <AutomationSettings facade={facade} settings={settings} />,
    dataProtection: <BackupSettings facade={facade.backup} settings={settings} />,
    general: (
      <>
        <GeneralSettings facade={facade} settings={settings} />
        <ViewSettings facade={facade} settings={settings} />
      </>
    ),
    libraryMaintenance: <LibrarySettings health={facade.libraryHealth} settings={settings} />,
    networkAi: (
      <>
        <AiNetworkSettings facade={facade} settings={settings.network} />
        {facade.llm ? (
          <>
            <LlmProvidersSettings facade={facade.llm} />
            <LlmCapabilitiesSettings facade={facade.llm} />
          </>
        ) : null}
      </>
    ),
  };

  return (
    <main className="sh-page sh-settings-page">
      <PageHeader
        actions={
          <Link className="sh-settings-page__onboarding-link" to="/initialize">
            {t("settings.reopenOnboarding")}
          </Link>
        }
        description={t("settings.description")}
        title={t("settings.heading")}
      />
      <div className="sh-settings-layout">
        <SettingsSectionNav activeId={activeSection} onChange={setActiveSection} sections={sections} />
        <div className="sh-settings-panels">
          {sections.map((section) => (
            <section
              aria-labelledby={`settings-tab-${section.id}`}
              className="sh-settings-panel"
              hidden={section.id !== activeSection}
              id={sectionPanelId(section.id)}
              key={section.id}
              role="tabpanel"
            >
              <p className="sh-settings-panel__description">{section.description}</p>
              <div className="sh-settings-panel__cards">{panels[section.id]}</div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

function ApplicationUpdateCard({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const [state, setState] = useState<UpdateState>(settings.updateState);
  const [update, setUpdate] = useState<AppUpdate | null>(settings.update);
  const [progress] = useState<UpdateProgress>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const updates = facade.updates;

  const run = (phase: UpdateState, action: () => Promise<void>) => {
    if (!updates || busy) return;
    setBusy(true);
    setState(phase);
    void action()
      .then(() => setBusy(false))
      .catch((reason: unknown) => {
        setBusy(false);
        setState("failed");
        setErrorCode(errorCodeOf(reason));
      });
  };

  return (
    <ApplicationUpdate
      busy={busy}
      buildTrust={settings.buildTrust}
      errorCode={errorCode}
      onCheck={
        updates
          ? () =>
              run("checking", async () => {
                const result = await updates.check();
                setUpdate(result);
                setState(result ? "available" : "up_to_date");
              })
          : undefined
      }
      onCancel={
        updates
          ? () =>
              run("downloading", async () => {
                await updates.cancel();
                setState("available");
              })
          : undefined
      }
      onDownload={
        updates
          ? () =>
              run("downloading", async () => {
                setState("verifying");
                await updates.download();
                setState("ready_to_install");
              })
          : undefined
      }
      onInstall={
        updates
          ? () =>
              run("ready_to_install", async () => {
                await updates.install();
              })
          : undefined
      }
      onOpenRelease={() => void facade.execute({ type: "open_official_release" })}
      onRollback={
        updates
          ? () =>
              run("ready_to_install", async () => {
                await updates.rollback();
                setState("rolled_back");
              })
          : undefined
      }
      policy={settings.updatePolicy}
      progress={progress}
      state={state}
      update={update}
    />
  );
}
