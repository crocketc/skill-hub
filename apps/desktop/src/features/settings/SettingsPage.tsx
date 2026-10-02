import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { describeNativeError } from "../../api/nativeErrors";
import { DataState } from "../../ui/DataState";
import { PageHeader } from "../../ui/PageHeader";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
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
import { searchSettings } from "./settingsSearch";

const SETTINGS_SECTIONS: readonly SettingsSectionId[] = [
  "general",
  "interfaceView",
  "dataProtection",
  "networkAi",
  "automation",
  "libraryMaintenance",
  "appUpdate",
];

function isTextEditingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

function targetIdFromHash(hash: string): string | null {
  try {
    return hash ? decodeURIComponent(hash.slice(1)) : null;
  } catch {
    return null;
  }
}

export function SettingsPage({ facade = unavailableSettingsFacade, initialSettings }: { facade?: SettingsFacade; initialSettings?: SettingsSnapshot }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsSnapshot | undefined>(initialSettings);
  const [error, setError] = useState<string>();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSection = params.get("section");
  const activeSection = SETTINGS_SECTIONS.includes(requestedSection as SettingsSectionId)
    ? requestedSection as SettingsSectionId
    : "general";
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResults = useMemo(
    () => searchSettings(searchText, (key) => String(t(key as never))),
    [searchText, t],
  );
  const activateSection = useCallback((id: SettingsSectionId) => {
    const next = new URLSearchParams(params);
    next.set("section", id);
    navigate({ pathname: location.pathname, search: `?${next.toString()}` }, { preventScrollReset: true });
  }, [location.pathname, navigate, params]);
  const openSearchResult = useCallback((entry: ReturnType<typeof searchSettings>[number]) => {
    if (entry.href) {
      navigate(entry.href);
      return;
    }
    const next = new URLSearchParams(params);
    next.set("section", entry.sectionId);
    const targetId = entry.targetId ?? sectionPanelId(entry.sectionId);
    navigate({
      pathname: location.pathname,
      search: `?${next.toString()}`,
      hash: `#${targetId}`,
    }, { preventScrollReset: true });
  }, [location.pathname, navigate, params]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f" && !isTextEditingTarget(event.target)) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useLayoutEffect(() => {
    const targetId = targetIdFromHash(location.hash);
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "center" });
  }, [activeSection, location.hash]);
  const updateLlmProvider = useCallback((providerLabel: string) => {
    setSettings((current) =>
      current
        ? { ...current, network: { ...current.network, llmProvider: providerLabel } }
        : current,
    );
  }, []);
  useEffect(() => { if (initialSettings || !facade.get) return; void facade.get().then(setSettings).catch((reason: unknown) => setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "tasks.notices.failureUnknown"))); }, [facade, initialSettings, t]);

  if (error) return <DataState message={error} state="unavailable" />;
  if (!settings) return <DataState message={t("settings.loading")} state="loading" />;

  const sections: SettingsSection[] = [
    {
      description: t("settings.sectionDescriptions.general"),
      heading: t("settings.sections.general"),
      group: "preferences",
      icon: "settings",
      id: "general",
    },
    {
      description: t("settings.sectionDescriptions.interfaceView"),
      heading: t("settings.sections.interfaceView"),
      group: "preferences",
      icon: "panelLeft",
      id: "interfaceView",
    },
    {
      description: t("settings.sectionDescriptions.dataProtection"),
      heading: t("settings.sections.dataProtection"),
      group: "data",
      icon: "restore",
      id: "dataProtection",
    },
    {
      description: t("settings.sectionDescriptions.networkAi"),
      heading: t("settings.sections.networkAi"),
      group: "network",
      icon: "info",
      id: "networkAi",
    },
    {
      description: t("settings.sectionDescriptions.automation"),
      heading: t("settings.sections.automation"),
      group: "maintenance",
      icon: "pending",
      id: "automation",
    },
    {
      description: t("settings.sectionDescriptions.libraryMaintenance"),
      heading: t("settings.sections.libraryMaintenance"),
      group: "maintenance",
      icon: "library",
      id: "libraryMaintenance",
    },
    {
      description: t("settings.sectionDescriptions.appUpdate"),
      heading: t("settings.sections.appUpdate"),
      group: "maintenance",
      icon: "update",
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
    dataProtection: <BackupSettings facade={facade.backup} resolveSkillName={facade.resolveSkillName} settings={settings} />,
    general: <GeneralSettings facade={facade} settings={settings} />,
    interfaceView: <ViewSettings facade={facade} settings={settings} />,
    libraryMaintenance: <LibrarySettings health={facade.libraryHealth} resolveSkillName={facade.resolveSkillName} settings={settings} />,
    networkAi: (
      <>
        <AiNetworkSettings facade={facade} settings={settings.network} />
        {facade.llm ? (
          <>
            <LlmProvidersSettings
              facade={facade.llm}
              onProviderStatusChange={updateLlmProvider}
            />
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
        headingLevel="h1"
        title={t("settings.heading")}
      />
      <div className="sh-settings-layout">
        <aside className="sh-settings-sidebar">
          <div className="sh-settings-search">
            <label className="sh-settings-search__label" htmlFor="settings-search-input">{t("settings.search.label")}</label>
            <div className="sh-settings-search__control">
              <input
                aria-controls="settings-search-results"
                aria-label={t("settings.search.label")}
                autoComplete="off"
                id="settings-search-input"
                onChange={(event) => setSearchText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchText) {
                    event.preventDefault();
                    setSearchText("");
                  } else if (event.key === "ArrowDown" && searchResults.length > 0) {
                    event.preventDefault();
                    document.getElementById(`settings-search-result-${searchResults[0]!.id}`)?.focus();
                  }
                }}
                placeholder={t("settings.search.placeholder")}
                ref={searchInputRef}
                role="searchbox"
                type="search"
                value={searchText}
              />
              {searchText ? (
                <button
                  aria-label={t("settings.search.clear")}
                  className="sh-settings-search__clear"
                  onClick={() => { setSearchText(""); searchInputRef.current?.focus(); }}
                  type="button"
                >×</button>
              ) : <kbd aria-hidden="true">Ctrl+F</kbd>}
            </div>
            {searchText ? (
              searchResults.length > 0 ? (
                <ul aria-label={t("settings.search.resultsLabel")} className="sh-settings-search__results" id="settings-search-results">
                  {searchResults.map((entry) => {
                    const label = t(entry.labelKey as never);
                    const groupLabel = t(`settings.sections.${entry.sectionId}` as never);
                    return (
                      <li key={entry.id}>
                        {entry.href ? (
                          <Link
                            aria-label={label}
                            className="sh-settings-search__result"
                            id={`settings-search-result-${entry.id}`}
                            onClick={() => setSearchText("")}
                            to={entry.href}
                          >
                            <span>{label}</span><small aria-hidden="true">{groupLabel}</small>
                          </Link>
                        ) : (
                          <button
                            aria-label={label}
                            className="sh-settings-search__result"
                            id={`settings-search-result-${entry.id}`}
                            onClick={() => openSearchResult(entry)}
                            type="button"
                          >
                            <span>{label}</span><small aria-hidden="true">{groupLabel}</small>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="sh-settings-search__empty" role="status">{t("settings.search.empty")}</p>
            ) : <p className="sh-settings-search__hint">{t("settings.search.hint")}</p>}
          </div>
          <SettingsSectionNav activeId={activeSection} onChange={activateSection} sections={sections} />
        </aside>
        <div className="sh-settings-panels">
          {sections.map((section) => (
            <section
              aria-labelledby={`settings-tab-${section.id}`}
              className="sh-settings-panel"
              data-section={section.id}
              hidden={section.id !== activeSection}
              id={sectionPanelId(section.id)}
              key={section.id}
              role="tabpanel"
              tabIndex={-1}
            >
              <header className="sh-settings-panel__header">
                <h2>{section.heading}</h2>
                <p className="sh-settings-panel__description">{section.description}</p>
              </header>
              <div className="sh-settings-panel__cards">{panels[section.id]}</div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

function ApplicationUpdateCard({ facade, settings }: { facade: SettingsFacade; settings: SettingsSnapshot }) {
  const { t } = useTranslation();
  const notifications = useOptionalAppNotifications();
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
          networkEnabled={settings.network.networkEnabled}
          onPolicyChange={(policy) => runTrackedOperation({
            kind: "settings_update_policy",
            label: t("settings.update.heading"),
            mode: "instant",
            notifications,
            translate: (name, options) => String(t(name as never, options as never)),
            successNotice: () => ({ tone: "success", title: t("settings.update.policySaved") }),
            errorNotice: (_error, message) => ({ tone: "danger", title: t("settings.update.policySaveFailed"), detail: message }),
            run: () => facade.execute({ type: "set_application_update_policy", payload: policy }),
          })}
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
