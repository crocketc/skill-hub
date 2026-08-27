import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import {
  type MarkdownFacade,
  type MarkdownReadOnlyReason,
  MarkdownUnavailableError,
  markdownKeys,
} from "./api";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface MarkdownWorkspaceProps {
  facade: MarkdownFacade;
  skillId: string;
}

type MarkdownMode = "edit" | "read" | "source";

const readOnlyMessageKey = {
  builtin: "markdown.workspace.readOnly.builtin",
  external: "markdown.workspace.readOnly.external",
  permission: "markdown.workspace.readOnly.permission",
  plugin: "markdown.workspace.readOnly.plugin",
} as const satisfies Record<MarkdownReadOnlyReason, string>;

export function MarkdownWorkspace({ facade, skillId }: MarkdownWorkspaceProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedOverride, setSelectedOverride] = useState<string>();
  const [mode, setMode] = useState<MarkdownMode>("read");
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
  const effectiveMode = mode === "edit" && !file?.editable ? "read" : mode;
  const discardDraft = async () => {
    await facade.discardDraft(skillId, selectedPath);
    await queryClient.invalidateQueries({ queryKey: markdownKeys.file(skillId, selectedPath) });
  };

  return (
    <section className="sh-markdown-workspace">
      <header className="sh-markdown-workspace__header">
        <div>
          <h3>{t("markdown.workspace.title")}</h3>
          <label htmlFor="skillhub-markdown-file">{t("markdown.workspace.file")}</label>
          <select
            id="skillhub-markdown-file"
            onChange={(event) => {
              setSelectedOverride(event.target.value);
              setMode("read");
            }}
            value={selectedPath}
          >
            {filesQuery.data.map((entry) => (
              <option key={entry.path} value={entry.path}>{entry.label}</option>
            ))}
          </select>
        </div>
        <div className="sh-markdown-workspace__external-actions">
          <Button
            onClick={() => void facade.openDefaultApplication(skillId, selectedPath)}
            size="sm"
            variant="ghost"
          >
            {t("markdown.workspace.openDefault")}
          </Button>
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
        <>
          <div aria-label={t("markdown.workspace.modes")} role="tablist">
            {(["read", "source"] as const).map((nextMode) => (
              <Button
                aria-selected={effectiveMode === nextMode}
                key={nextMode}
                onClick={() => setMode(nextMode)}
                role="tab"
                size="sm"
                variant={effectiveMode === nextMode ? "secondary" : "ghost"}
              >
                {t(`markdown.workspace.mode.${nextMode}`)}
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
          {file.draft ? (
            <div className="sh-markdown-workspace__draft" role="status">
              <span>{t("markdown.workspace.draftRestored")}</span>
              <Button onClick={() => void discardDraft()} size="sm" variant="ghost">
                {t("markdown.workspace.discardDraft")}
              </Button>
            </div>
          ) : null}
          {!file.editable && file.readOnlyReason ? (
            <div className="sh-markdown-workspace__read-only">
              <p>{t(readOnlyMessageKey[file.readOnlyReason])}</p>
              <Button onClick={() => void facade.requestTakeover(skillId)} variant="secondary">
                {t("markdown.workspace.takeover")}
              </Button>
            </div>
          ) : null}
          {effectiveMode === "read" ? (
            <MarkdownRenderer
              facade={facade}
              filePath={file.path}
              markdown={file.markdown}
              skillId={skillId}
            />
          ) : null}
          {effectiveMode === "source" ? (
            <pre className="sh-markdown-workspace__source">{file.markdown}</pre>
          ) : null}
          {effectiveMode === "edit" ? (
            <MarkdownEditor
              facade={facade}
              file={file}
              key={`${file.path}-${file.contentIdentity}-${file.draft?.savedAt ?? "formal"}`}
              onSaved={() => undefined}
              skillId={skillId}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
