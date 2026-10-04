import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { describeNativeError, nativeErrorCode, nativeErrorParams } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Select } from "../../ui/Select";
import {
  joinSkillTreePath,
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
  /** K9：SkillResult.root_path——可见树根绝对路径；打开命令与接管预填都依赖它。 */
  skillRootPath?: string | null;
  skillId: string;
}

type MarkdownMode = "edit" | "read" | "source";

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
  skillRootPath,
  skillId,
}: MarkdownWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedOverride, setSelectedOverride] = useState<string>();
  const [mode, setMode] = useState<MarkdownMode>("read");
  // K9：打开默认/所选应用与目录的失败必须留在原页面可处理，不得静默吞掉。
  const [openActionError, setOpenActionError] = useState<string>();
  // 编辑器注册的「切换前持久化草稿」回调；离开编辑模式时置回 null。
  const editorPersistRef = useRef<(() => Promise<void>) | null>(null);
  const registerEditorPersist = useCallback(
    (persist: (() => Promise<void>) | null) => {
      editorPersistRef.current = persist;
    },
    [],
  );
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
    mode === "edit" && !file?.editable
      ? "read"
      : mode;
  // K9：打开类动作共用同一条受控路径；失败与权限拒绝以可读说明留在原页。
  // 平台拒绝（如 macOS 无应用选择器 → local_open.unsupported）映射为专属
  // 可读文案，绝不伪装成功。
  const describeOpenFailure = (reason: unknown) => {
    const code = nativeErrorCode(reason);
    if (code === "local_open.unsupported") {
      const params = nativeErrorParams(reason);
      return t("markdown.workspace.openUnsupported", {
        platform: typeof params.platform === "string" ? params.platform : "",
      });
    }
    if (code === "local_open.opener_unavailable") {
      return t("markdown.workspace.openOpenerUnavailable");
    }
    return describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "markdown.workspace.openFailedDetail",
    );
  };
  const runOpenAction = (action: () => Promise<void>) => {
    setOpenActionError(undefined);
    void action().catch((reason: unknown) => {
      const detail = reason instanceof MarkdownUnavailableError
        ? t("markdown.workspace.unavailable")
        : describeOpenFailure(reason);
      setOpenActionError(t("markdown.workspace.openFailed", { detail }));
    });
  };
  // K9：打开命令要求树内绝对路径。可见树根未知（root_path 缺失）时无法给出
  // 真实路径：如实说明且不发出注定失败的调用，绝不拿相对路径冒充。
  const requireTreeRoot = () => {
    if (skillRootPath) return skillRootPath;
    setOpenActionError(t("markdown.workspace.openFailed", {
      detail: t("markdown.workspace.rootUnknown"),
    }));
    return null;
  };
  const openSelectedPath = (command: "open_default_application" | "choose_external_application") => {
    const root = requireTreeRoot();
    if (!root) return;
    const absolutePath = joinSkillTreePath(root, selectedPath);
    runOpenAction(() =>
      command === "open_default_application"
        ? facade.openDefaultApplication(skillId, absolutePath)
        : facade.chooseExternalApplication(skillId, absolutePath));
  };
  const openFolder = () => {
    const root = requireTreeRoot();
    if (!root) return;
    runOpenAction(() => facade.openSkillFolder(skillId, root));
  };
  // K9：接管不产生任何后端写入，也不以本地 mock 状态宣称已接管；跳转既有
  // 身份/共享/权限预览流程（本地发现的导入预览流），来源路径用真实可见树根
  // 预填；树根未知时诚实降级为不带预填，由用户在本地发现中自行选择来源。
  const requestTakeover = () => {
    navigate(
      "/discovery/local",
      skillRootPath ? { state: { initialSources: [skillRootPath] } } : undefined,
    );
  };
  // K4-B：切走前先把防抖窗口内的最新输入落成草稿；失败则留在编辑器，
  // 由编辑器的草稿错误状态 + 重试入口承接，绝不静默丢弃输入。
  const leaveEditor = async (apply: () => void) => {
    const persist = editorPersistRef.current;
    if (persist) {
      try {
        await persist();
      } catch {
        return;
      }
    }
    apply();
  };
  const selectFile = (path: string) => {
    void leaveEditor(() => {
      setSelectedOverride(path);
      setMode("read");
    });
  };
  const discardDraft = async () => {
    await facade.discardDraft(skillId, selectedPath);
    await queryClient.invalidateQueries({ queryKey: markdownKeys.file(skillId, selectedPath) });
  };

  const modes: MarkdownMode[] = ["read", "source"];
  const modeLabel = (nextMode: MarkdownMode) => t(`markdown.workspace.mode.${nextMode}`);

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
              onClick={() => openSelectedPath("open_default_application")}
            />
          ) : (
            <Button
              onClick={() => openSelectedPath("open_default_application")}
              size="sm"
              variant="ghost"
            >
              {t("markdown.workspace.openDefault")}
            </Button>
          )}
          <Button
            onClick={() => openSelectedPath("choose_external_application")}
            size="sm"
            variant="ghost"
          >
            {t("markdown.workspace.chooseApp")}
          </Button>
          <Button
            onClick={openFolder}
            size="sm"
            variant="ghost"
          >
            {t("markdown.workspace.openFolder")}
          </Button>
        </div>
      </header>
      {openActionError ? (
        <div className="sh-markdown-workspace__open-error" role="alert">
          <p className="sh-markdown-status">
            <Icon className="sh-markdown-status__icon" name="warning" size={16} />
            <span>{openActionError}</span>
          </p>
        </div>
      ) : null}
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
        <PrototypeLayout className="sh-markdown-workspace__body" enabled={fileRail}>
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
          <PrototypeLayout className="sh-markdown-workspace__viewer" enabled={fileRail}>
            {file.draft && effectiveMode !== "edit" ? (
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
                <Button onClick={requestTakeover} variant="secondary">
                  {t("markdown.workspace.takeover")}
                </Button>
              </div>
            ) : null}
            <div aria-label={t("markdown.workspace.modes")} role="tablist">
              {modes.map((nextMode) => (
                <Button
                  aria-selected={effectiveMode === nextMode}
                  key={nextMode}
                  onClick={() => void leaveEditor(() => setMode(nextMode))}
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
                  onClick={() => void leaveEditor(() => setMode("edit"))}
                  role="tab"
                  size="sm"
                  variant={effectiveMode === "edit" ? "secondary" : "ghost"}
                >
                  {t("markdown.workspace.mode.edit")}
                </Button>
              ) : null}
            </div>
            {effectiveMode === "read" ? (
              fileRail ? (
                <div className="sh-markdown-workspace__stage">
                  <MarkdownRenderer
                    facade={facade}
                    filePath={file.path}
                    markdown={file.markdown}
                    skillId={skillId}
                    versionId={file.versionId}
                  />
                </div>
              ) : (
                <MarkdownRenderer
                  facade={facade}
                  filePath={file.path}
                  markdown={file.markdown}
                  skillId={skillId}
                  versionId={file.versionId}
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
                    key={reviewSaveFlow ? file.path : `${file.path}-${file.contentIdentity}`}
                    onExit={() => setMode("read")}
                    registerPersist={registerEditorPersist}
                    reviewSaveFlow={reviewSaveFlow}
                    onSaved={() => {
                      void queryClient.invalidateQueries({
                        queryKey: ["skill-detail", skillId, "summary"],
                      });
                      void queryClient.invalidateQueries({
                        queryKey: ["skill-detail", skillId, "versions"],
                      });
                      // G-18：保存会写入操作历史并可能改变外部变化事实，保存后
                      // 洞察缓存一并失效，避免面板停留在旧读模型。
                      void queryClient.invalidateQueries({
                        queryKey: ["skill-detail", skillId, "insights"],
                      });
                    }}
                    skillId={skillId}
                  />
                </div>
              </Suspense>
            ) : null}
          </PrototypeLayout>
        </PrototypeLayout>
      )}
    </section>
  );
}

/** Keep the production workspace structure; review-only rails need these containers. */
function PrototypeLayout({ children, className, enabled }: { children: ReactNode; className: string; enabled: boolean }) {
  return enabled ? <div className={className}>{children}</div> : <>{children}</>;
}
