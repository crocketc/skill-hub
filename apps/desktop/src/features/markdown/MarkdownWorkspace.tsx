import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Select } from "../../ui/Select";
import {
  type MarkdownFacade,
  type MarkdownReadOnlyReason,
  MarkdownUnavailableError,
  markdownKeys,
} from "./api";
import { MarkdownRenderer } from "./MarkdownRenderer";

// CodeMirror 及其语言包体积大，仅在进入编辑模式时加载。
const MarkdownEditor = lazy(() =>
  import("./MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);

interface MarkdownWorkspaceProps {
  /**
   * 详情原型视图：文件结构侧栏、阅读/源码对照联动滚动与图标化外部打开。
   * 生产详情在原型确认前保持既有单一视图。
   */
  fileRail?: boolean;
  facade: MarkdownFacade;
  reviewSaveFlow?: boolean;
  skillId: string;
}

type MarkdownMode = "compare" | "edit" | "read" | "source";

const readOnlyMessageKey = {
  builtin: "markdown.workspace.readOnly.builtin",
  external: "markdown.workspace.readOnly.external",
  permission: "markdown.workspace.readOnly.permission",
  plugin: "markdown.workspace.readOnly.plugin",
} as const satisfies Record<MarkdownReadOnlyReason, string>;

export function MarkdownWorkspace({
  facade,
  fileRail = false,
  reviewSaveFlow = false,
  skillId,
}: MarkdownWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedOverride, setSelectedOverride] = useState<string>();
  const [mode, setMode] = useState<MarkdownMode>("read");
  // 对照模式两侧按滚动比例联动；锁避免“滚动 A → 同步 B → B 又触发同步”。
  const compareSourceRef = useRef<HTMLDivElement>(null);
  const compareTargetRef = useRef<HTMLDivElement>(null);
  const syncLockRef = useRef(false);
  const syncScrollFrom = (source: HTMLDivElement, target: HTMLDivElement | null) => {
    if (!target || syncLockRef.current) return;
    syncLockRef.current = true;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const targetRange = target.scrollHeight - target.clientHeight;
    target.scrollTop = sourceRange > 0 ? (source.scrollTop / sourceRange) * Math.max(0, targetRange) : 0;
    window.requestAnimationFrame(() => {
      syncLockRef.current = false;
    });
  };
  const filesQuery = useQuery({
    queryFn: () => facade.listMarkdownFiles(skillId),
    queryKey: markdownKeys.files(skillId),
    retry: false,
  });
  const primaryPath = filesQuery.data?.find((entry) => entry.primary)?.path;
  const selectedPath = selectedOverride ?? primaryPath ?? filesQuery.data?.[0]?.path;
  const fileQuery = useQuery({
    enabled: Boolean(selectedPath),
    queryFn: () => facade.readMarkdownFile(skillId, selectedPath ?? ""),
    queryKey: markdownKeys.file(skillId, selectedPath ?? ""),
    retry: false,
  });

  if (filesQuery.isPending) {
    return <DataState message={t("markdown.workspace.loadingFiles")} state="loading" />;
  }
  if (filesQuery.isError) {
    return (
      <DataState
        actionLabel={filesQuery.error instanceof MarkdownUnavailableError ? undefined : t("actions.retry")}
        message={
          filesQuery.error instanceof MarkdownUnavailableError
            ? t("markdown.workspace.unavailable")
            : t("markdown.workspace.filesError")
        }
        onAction={
          filesQuery.error instanceof MarkdownUnavailableError
            ? undefined
            : () => void filesQuery.refetch()
        }
        state={filesQuery.error instanceof MarkdownUnavailableError ? "unavailable" : "error"}
      />
    );
  }
  if (!selectedPath || filesQuery.data.length === 0) {
    return <DataState message={t("markdown.workspace.empty")} state="empty" />;
  }

  const file = fileQuery.data;
  const effectiveMode =
    mode === "compare" && !fileRail
      ? "read"
      : mode === "edit" && !file?.editable
        ? "read"
        : mode;
  const selectFile = (path: string) => {
    setSelectedOverride(path);
    setMode("read");
  };
  const discardDraft = async () => {
    await facade.discardDraft(skillId, selectedPath);
    await queryClient.invalidateQueries({ queryKey: markdownKeys.file(skillId, selectedPath) });
  };

  const modes: MarkdownMode[] = fileRail ? ["read", "source", "compare"] : ["read", "source"];
  const modeLabel = (nextMode: MarkdownMode) =>
    nextMode === "compare" ? t("markdown.workspace.mode.compare") : t(`markdown.workspace.mode.${nextMode}`);

  return (
    <section className={fileRail ? "sh-markdown-workspace sh-markdown-workspace--rail" : "sh-markdown-workspace"}>
      <header className="sh-markdown-workspace__header">
        <div>
          <h3>{t("markdown.workspace.title")}</h3>
          <label htmlFor="skillhub-markdown-file">{t("markdown.workspace.file")}</label>
          <Select
            id="skillhub-markdown-file"
            onChange={(event) => selectFile(event.target.value)}
            value={selectedPath}
          >
            {filesQuery.data.map((entry) => (
              <option key={entry.path} value={entry.path}>{entry.label}</option>
            ))}
          </Select>
        </div>
        <div className="sh-markdown-workspace__external-actions">
          {fileRail ? (
            <IconButton
              icon="openExternal"
              label={t("markdown.workspace.openDefault")}
              onClick={() => void facade.openDefaultApplication(skillId, selectedPath)}
            />
          ) : (
            <Button
              onClick={() => void facade.openDefaultApplication(skillId, selectedPath)}
              size="sm"
              variant="ghost"
            >
              {t("markdown.workspace.openDefault")}
            </Button>
          )}
          <Button
            onClick={() => void facade.chooseExternalApplication(skillId, selectedPath)}
            size="sm"
            variant="ghost"
          >
            {t("markdown.workspace.chooseApp")}
          </Button>
          <Button
            onClick={() => void facade.openSkillFolder(skillId)}
            size="sm"
            variant="ghost"
          >
            {t("markdown.workspace.openFolder")}
          </Button>
        </div>
      </header>
      {fileQuery.isPending ? (
        <DataState message={t("markdown.workspace.loadingFile")} state="loading" />
      ) : fileQuery.isError || !file ? (
        <DataState
          actionLabel={t("actions.retry")}
          message={t("markdown.workspace.fileError")}
          onAction={() => void fileQuery.refetch()}
          state="error"
        />
      ) : (
        <div className="sh-markdown-workspace__body">
          {fileRail ? (
            <nav aria-label={t("markdown.workspace.fileStructure")} className="sh-markdown-workspace__rail">
              <ul>
                {filesQuery.data.map((entry) => (
                  <li key={entry.path}>
                    <button
                      aria-current={entry.path === selectedPath ? "true" : undefined}
                      className={entry.path === selectedPath ? "is-active" : undefined}
                      onClick={() => selectFile(entry.path)}
                      type="button"
                    >
                      <span className="sh-markdown-workspace__rail-path" title={entry.path}>{entry.label}</span>
                      {entry.primary ? <span className="sh-markdown-workspace__rail-badge">{t("markdown.workspace.primaryFile")}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <div className="sh-markdown-workspace__viewer">
            {file.draft ? (
              <div className="sh-markdown-workspace__draft" role="status">
                <span className="sh-markdown-status">
                  <Icon className="sh-markdown-status__icon" name="info" size={16} />
                  <span>{t("markdown.workspace.draftRestored")}</span>
                </span>
                <Button onClick={() => void discardDraft()} size="sm" variant="ghost">
                  {t("markdown.workspace.discardDraft")}
                </Button>
              </div>
            ) : null}
            {!file.editable && file.readOnlyReason ? (
              <div className="sh-markdown-workspace__read-only" role="status">
                <p className="sh-markdown-status">
                  <Icon className="sh-markdown-status__icon" name="warning" size={16} />
                  <span>{t(readOnlyMessageKey[file.readOnlyReason])}</span>
                </p>
                <Button onClick={() => void facade.requestTakeover(skillId)} variant="secondary">
                  {t("markdown.workspace.takeover")}
                </Button>
              </div>
            ) : null}
            <div aria-label={t("markdown.workspace.modes")} role="tablist">
              {modes.map((nextMode) => (
                <Button
                  aria-selected={effectiveMode === nextMode}
                  key={nextMode}
                  onClick={() => setMode(nextMode)}
                  role="tab"
                  size="sm"
                  variant={effectiveMode === nextMode ? "secondary" : "ghost"}
                >
                  {modeLabel(nextMode)}
                </Button>
              ))}
              {file.editable ? (
                <Button
                  aria-selected={effectiveMode === "edit"}
                  onClick={() => setMode("edit")}
                  role="tab"
                  size="sm"
                  variant={effectiveMode === "edit" ? "secondary" : "ghost"}
                >
                  {t("markdown.workspace.mode.edit")}
                </Button>
              ) : null}
            </div>
            {effectiveMode === "compare" ? (
              <p className="sh-markdown-workspace__compare-hint">{t("markdown.workspace.compareHint")}</p>
            ) : null}
            {effectiveMode === "read" ? (
              fileRail ? (
                <div className="sh-markdown-workspace__stage">
                  <MarkdownRenderer
                    facade={facade}
                    filePath={file.path}
                    markdown={file.markdown}
                    skillId={skillId}
                  />
                </div>
              ) : (
                <MarkdownRenderer
                  facade={facade}
                  filePath={file.path}
                  markdown={file.markdown}
                  skillId={skillId}
                />
              )
            ) : null}
            {effectiveMode === "source" ? (
              fileRail ? (
                <div className="sh-markdown-workspace__stage">
                  <pre className="sh-markdown-workspace__source">{file.markdown}</pre>
                </div>
              ) : (
                <pre className="sh-markdown-workspace__source">{file.markdown}</pre>
              )
            ) : null}
            {effectiveMode === "compare" ? (
              <div className="sh-markdown-workspace__compare">
                <div
                  className="sh-markdown-workspace__pane"
                  onScroll={(event) => syncScrollFrom(event.currentTarget, compareTargetRef.current)}
                  ref={compareSourceRef}
                >
                  <MarkdownRenderer
                    facade={facade}
                    filePath={file.path}
                    markdown={file.markdown}
                    skillId={skillId}
                  />
                </div>
                <div
                  className="sh-markdown-workspace__pane"
                  onScroll={(event) => syncScrollFrom(event.currentTarget, compareSourceRef.current)}
                  ref={compareTargetRef}
                >
                  <pre className="sh-markdown-workspace__source">{file.markdown}</pre>
                </div>
              </div>
            ) : null}
            {effectiveMode === "edit" ? (
              <Suspense
                fallback={
                  <DataState message={t("markdown.workspace.loadingFile")} state="loading" />
                }
              >
                <div className={fileRail ? "sh-markdown-workspace__stage sh-markdown-workspace__stage--editor" : undefined}>
                  <MarkdownEditor
                    facade={facade}
                    file={file}
                    key={reviewSaveFlow ? file.path : `${file.path}-${file.contentIdentity}-${file.draft?.savedAt ?? "formal"}`}
                    onExit={() => setMode("read")}
                    reviewSaveFlow={reviewSaveFlow}
                    onSaved={() => {
                      void queryClient.invalidateQueries({
                        queryKey: ["skill-detail", skillId, "summary"],
                      });
                      void queryClient.invalidateQueries({
                        queryKey: ["skill-detail", skillId, "versions"],
                      });
                    }}
                    skillId={skillId}
                  />
                </div>
              </Suspense>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
