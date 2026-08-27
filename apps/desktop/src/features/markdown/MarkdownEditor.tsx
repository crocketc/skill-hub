import { markdown } from "@codemirror/lang-markdown";
import { search } from "@codemirror/search";
import { useQueryClient } from "@tanstack/react-query";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import {
  MarkdownContentConflictError,
  type MarkdownFacade,
  type MarkdownFileContent,
  type MarkdownValidationIssue,
  markdownKeys,
} from "./api";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface MarkdownEditorProps {
  facade: MarkdownFacade;
  file: MarkdownFileContent;
  onSaved: (newVersionId: string) => void;
  skillId: string;
}

export function MarkdownEditor({ facade, file, onSaved, skillId }: MarkdownEditorProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const initial = file.draft?.markdown ?? file.markdown;
  const [source, setSource] = useState(() => initial);
  const [contentIdentity, setContentIdentity] = useState(file.contentIdentity);
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [issues, setIssues] = useState<MarkdownValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<string>();
  const [savedVersion, setSavedVersion] = useState<string>();
  const [saving, setSaving] = useState(false);
  const lastDraft = useRef(initial);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();
  const issuesRef = useRef<HTMLElement>(null);

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
        return;
      }
      await commit();
    } catch {
      setSaveError(t("markdown.editor.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const hasWarnings = issues.some((issue) => issue.severity === "warning");

  return (
    <section className="sh-markdown-editor">
      <div className="sh-markdown-editor__toolbar">
        <div aria-live="polite">
          {draftState === "saving" ? t("markdown.editor.draftSaving") : null}
          {draftState === "saved" ? t("markdown.editor.draftSaved") : null}
          {draftState === "error" ? t("markdown.editor.draftError") : null}
          {savedVersion ? t("markdown.editor.versionCreated", { version: savedVersion }) : null}
        </div>
        <Button loading={saving} onClick={() => void validateAndSave()}>
          {t("markdown.editor.save")}
        </Button>
      </div>
      {issues.length > 0 ? (
        <section
          aria-label={t("markdown.editor.issues")}
          ref={issuesRef}
          role="alert"
          tabIndex={-1}
        >
          <h3>{t("markdown.editor.issues")}</h3>
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
      {saveError ? <p role="alert">{saveError}</p> : null}
      <div className="sh-markdown-editor__split">
        <div>
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
        <div>
          <h3>{t("markdown.editor.preview")}</h3>
          <MarkdownRenderer
            facade={facade}
            filePath={file.path}
            markdown={source}
            skillId={skillId}
          />
        </div>
      </div>
    </section>
  );
}
