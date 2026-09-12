import { markdown } from "@codemirror/lang-markdown";
import { search } from "@codemirror/search";
import { useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Icon } from "../../ui/Icon";
import {
  MarkdownContentConflictError,
  type MarkdownFacade,
  type MarkdownFileContent,
  type MarkdownValidationIssue,
  markdownKeys,
} from "./api";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ReplaceSaveDialog } from "./ReplaceSaveDialog";
import {
  type ScrollSyncEcho,
  applyScrollSync,
  readSyncScrollPreference,
  writeSyncScrollPreference,
} from "./syncScroll";

interface MarkdownEditorProps {
  facade: MarkdownFacade;
  file: MarkdownFileContent;
  onSaved: (newVersionId: string) => void;
  /** 用户明确结束编辑（保存后或放弃后）时回调；工作流据此回到阅读模式。 */
  onExit?: () => void;
  skillId: string;
}

export function MarkdownEditor({ facade, file, onSaved, onExit, skillId }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const initial = file.draft?.markdown ?? file.markdown;
  const [source, setSource] = useState(() => initial);
  // 预览解析成本高，用 deferred 值让输入保持响应；保存/校验仍基于最新 source。
  const deferredSource = useDeferredValue(source);
  const [contentIdentity, setContentIdentity] = useState(file.contentIdentity);
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [issues, setIssues] = useState<MarkdownValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<string>();
  const [copySaved, setCopySaved] = useState(false);
  const [savedVersion, setSavedVersion] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [syncScroll, setSyncScroll] = useState(() =>
    readSyncScrollPreference(
      typeof window === "undefined" ? undefined : window.localStorage,
    ),
  );
  const lastDraft = useRef(initial);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();
  const issuesRef = useRef<HTMLElement>(null);
  const sourcePaneRef = useRef<HTMLDivElement>(null);
  const previewPaneRef = useRef<HTMLDivElement>(null);
  const syncScrollRef = useRef(syncScroll);
  const syncEchoRef = useRef<ScrollSyncEcho | null>(null);
  syncScrollRef.current = syncScroll;

  useEffect(() => {
    const sourcePane = sourcePaneRef.current;
    const previewPane = previewPaneRef.current;
    if (!sourcePane || !previewPane) {
      return;
    }
    // 源码侧真正滚动的是 CodeMirror 的 .cm-scroller（编辑器固定 420px 高），
    // 且它在本 effect 之后才挂载——所以源码面板用捕获监听收下后代滚动事件，
    // 处理器内再判定目标；预览侧滚动容器是分屏面板本身（overflow-y: auto），
    // 只认面板自身，忽略表格/代码块的内部横向滚动。
    const isSourceScroller = (element: EventTarget | null): element is HTMLElement =>
      element instanceof HTMLElement &&
      (element === sourcePane || element.classList.contains("cm-scroller"));
    const resolveSourceScroller = () =>
      sourcePane.querySelector<HTMLElement>(".cm-scroller") ?? sourcePane;
    const handleSourceScroll = (event: Event) => {
      if (!isSourceScroller(event.target) || !syncScrollRef.current) {
        return;
      }
      applyScrollSync({
        echoRef: syncEchoRef,
        source: event.target,
        target: previewPane,
      });
    };
    const handlePreviewScroll = (event: Event) => {
      if (event.target !== previewPane || !syncScrollRef.current) {
        return;
      }
      applyScrollSync({
        echoRef: syncEchoRef,
        source: previewPane,
        target: resolveSourceScroller(),
      });
    };
    sourcePane.addEventListener("scroll", handleSourceScroll, true);
    previewPane.addEventListener("scroll", handlePreviewScroll);
    return () => {
      sourcePane.removeEventListener("scroll", handleSourceScroll, true);
      previewPane.removeEventListener("scroll", handlePreviewScroll);
    };
  }, []);

  useEffect(() => {
    if (source === lastDraft.current) {
      return;
    }
    setDraftState("saving");
    draftTimer.current = setTimeout(() => {
      void facade.saveDraft(skillId, file.path, source)
        .then(() => {
          lastDraft.current = source;
          setDraftState("saved");
        })
        .catch(() => setDraftState("error"));
    }, 500);
    return () => {
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
      }
    };
  }, [facade, file.path, skillId, source]);

  const persistCurrentDraft = async () => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
    }
    await facade.saveDraft(skillId, file.path, source);
    lastDraft.current = source;
    setDraftState("saved");
  };

  const commit = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await facade.saveSkillContent(
        skillId,
        file.path,
        source,
        contentIdentity,
      );
      setContentIdentity(result.contentIdentity);
      setIssues([]);
      setSavedVersion(result.newVersionId);
      setDraftState("idle");
      await queryClient.invalidateQueries({ queryKey: markdownKeys.file(skillId, file.path) });
      onSaved(result.newVersionId);
    } catch (error) {
      setSaveError(
        error instanceof MarkdownContentConflictError
          ? t("markdown.editor.conflict")
          : t("markdown.editor.saveError"),
      );
    } finally {
      setSaving(false);
    }
  };

  const saveAsCopy = async () => {
    setSaving(true);
    setSaveError(undefined);
    setCopySaved(false);
    try {
      await persistCurrentDraft();
      await facade.saveMarkdownAsCopy(skillId, file.path, source, contentIdentity);
      setCopySaved(true);
    } catch (error) {
      setSaveError(
        error instanceof MarkdownContentConflictError
          ? t("markdown.editor.conflict")
          : t("markdown.editor.copyError"),
      );
    } finally {
      setSaving(false);
    }
  };

  const validateAndSave = async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await persistCurrentDraft();
      const nextIssues = await facade.validateMarkdown(skillId, file.path, source);
      setIssues(nextIssues);
      if (nextIssues.length > 0) {
        queueMicrotask(() => issuesRef.current?.focus());
      }
      if (nextIssues.some((issue) => issue.severity === "error")) {
        return;
      }
      if (nextIssues.some((issue) => issue.severity === "warning")) {
        // 警告路径维持显式"仍要保存"按钮：那本身就是一次对替换的明确确认。
        return;
      }
      // 受控替换：校验通过后先确认，再走既有 commit（仍然生成新版本）。
      setReplaceConfirmOpen(true);
    } catch {
      setSaveError(t("markdown.editor.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const toggleSyncScroll = (enabled: boolean) => {
    syncEchoRef.current = null;
    setSyncScroll(enabled);
    if (typeof window !== "undefined") {
      writeSyncScrollPreference(window.localStorage, enabled);
    }
  };

  const hasWarnings = issues.some((issue) => issue.severity === "warning");
  const dirty = source !== file.markdown;

  const discardAndExit = async () => {
    try {
      await facade.discardDraft(skillId, file.path);
      await queryClient.invalidateQueries({ queryKey: markdownKeys.file(skillId, file.path) });
    } finally {
      onExit?.();
    }
  };

  return (
    <section className="sh-markdown-editor">
      <div className="sh-markdown-editor__toolbar">
        {onExit && dirty ? (
          <ConfirmDialog
            cancelLabel={t("actions.cancel")}
            confirmLabel={t("markdown.editor.exitConfirmConfirm")}
            description={t("markdown.editor.exitConfirmDescription")}
            onConfirm={() => void discardAndExit()}
            title={t("markdown.editor.exitConfirmTitle")}
            trigger={
              <Button size="sm" variant="ghost">
                {t("markdown.editor.exitWithoutSaving")}
              </Button>
            }
            variant="danger"
          />
        ) : onExit ? (
          <Button onClick={onExit} size="sm" variant="ghost">
            {t("markdown.editor.exit")}
          </Button>
        ) : null}
        <div aria-live="polite" className="sh-markdown-editor__save-status" role="status">
          {draftState === "saving" ? t("markdown.editor.draftSaving") : null}
          {draftState === "saved" ? t("markdown.editor.draftSaved") : null}
          {draftState === "error" ? t("markdown.editor.draftError") : null}
          {copySaved ? t("markdown.editor.copyCreated") : null}
          {savedVersion ? t("markdown.editor.versionCreated", { version: savedVersion }) : null}
        </div>
        <div className="sh-markdown-editor__save-cluster">
          <span className="sh-markdown-editor__save-hint">
            {t("markdown.editor.saveHint")}
          </span>
          <span className="sh-markdown-editor__copy-note">
            <Button
              aria-label={t("markdown.editor.saveAsCopy")}
              disabled={saving}
              loading={saving}
              onClick={() => void saveAsCopy()}
              size="sm"
              variant="secondary"
            >
              {t("markdown.editor.saveAsCopy")}
            </Button>
            {t("markdown.editor.copyHint")}
          </span>
          <Button loading={saving} onClick={() => void validateAndSave()}>
            {t("markdown.editor.save")}
          </Button>
        </div>
      </div>
      {issues.length > 0 ? (
        <section
          aria-label={t("markdown.editor.issues")}
          ref={issuesRef}
          role="alert"
          tabIndex={-1}
        >
          <h3 className="sh-markdown-editor__issues-title">
            <Icon
              className="sh-markdown-status__icon"
              name={issues.some((issue) => issue.severity === "error") ? "failure" : "warning"}
              size={16}
            />
            <span>{t("markdown.editor.issues")}</span>
          </h3>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.code}-${issue.line ?? 0}-${issue.message}`}>
                {issue.message}
              </li>
            ))}
          </ul>
          {hasWarnings && !issues.some((issue) => issue.severity === "error") ? (
            <Button onClick={() => void commit()} variant="secondary">
              {t("markdown.editor.saveWarnings")}
            </Button>
          ) : null}
        </section>
      ) : null}
      {saveError ? (
        <p className="sh-markdown-editor__save-error" role="alert">
          <Icon className="sh-markdown-status__icon" name="failure" size={16} />
          <span>{saveError}</span>
        </p>
      ) : null}
      <div className="sh-markdown-editor__split-header">
        <label className="sh-markdown-editor__sync-toggle">
          <input
            aria-label={t("markdown.editor.syncScrollToggle")}
            checked={syncScroll}
            onChange={(event) => toggleSyncScroll(event.target.checked)}
            type="checkbox"
          />
          <span>{t("markdown.editor.syncScrollToggle")}</span>
        </label>
      </div>
      <div className="sh-markdown-editor__split">
        <div
          className="sh-markdown-editor__pane sh-markdown-editor__pane--source"
          ref={sourcePaneRef}
        >
          <h3>{t("markdown.editor.source")}</h3>
          <CodeMirror
            basicSetup={{
              foldGutter: true,
              highlightActiveLine: true,
              lineNumbers: true,
            }}
            extensions={[markdown(), search({ top: true })]}
            height="420px"
            onChange={setSource}
            onCreateEditor={(view) => {
              view.contentDOM.setAttribute(
                "aria-label",
                t("markdown.editor.sourceLabel"),
              );
            }}
            value={source}
          />
        </div>
        <div
          className="sh-markdown-editor__pane sh-markdown-editor__pane--preview"
          ref={previewPaneRef}
        >
          <h3>{t("markdown.editor.preview")}</h3>
          <MarkdownRenderer
            facade={facade}
            filePath={file.path}
            markdown={deferredSource}
            skillId={skillId}
          />
        </div>
      </div>
      <ReplaceSaveDialog
        busy={saving}
        onConfirmReplace={() => void commit()}
        onOpenChange={setReplaceConfirmOpen}
        onSaveCopy={() => void saveAsCopy()}
        open={replaceConfirmOpen}
        path={file.path}
      />
    </section>
  );
}
