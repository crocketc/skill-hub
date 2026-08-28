import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { skillLibraryKeys } from "../skills/api";
import type {
  SkillDetailFacade,
  SkillMetadata,
  SkillMetadataPatch,
} from "./api";
import { skillDetailKeys } from "./api";

interface MetadataPanelProps {
  facade: SkillDetailFacade;
  metadata: SkillMetadata;
  skillId: string;
}

interface EditableTextSectionProps {
  hint?: string;
  label: string;
  multiline?: boolean;
  onSave: (value: string) => Promise<void>;
  value: string;
}

function EditableTextSection({
  hint,
  label,
  multiline = false,
  onSave,
  value,
}: EditableTextSectionProps): JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"read" | "edit" | "saving">("read");
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  const [error, setError] = useState<string>();
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const save = () => {
    setMode("saving");
    setError(undefined);
    void onSave(draft).then(
      () => {
        setSavedValue(draft);
        setMode("read");
      },
      () => {
        setMode("edit");
        setError(t("skillDetail.metadata.saveError"));
        queueMicrotask(() => fieldRef.current?.focus());
      },
    );
  };

  return (
    <section className="sh-metadata-panel__editable">
      <div className="sh-metadata-panel__section-heading">
        <h3>{label}</h3>
        {mode === "read" ? (
          <Button
            aria-label={t("skillDetail.metadata.edit", { label })}
            onClick={() => {
              setDraft(savedValue);
              setError(undefined);
              setMode("edit");
            }}
            size="sm"
            variant="ghost"
          >
            {t("skillDetail.metadata.editAction")}
          </Button>
        ) : null}
      </div>
      {mode === "read" ? (
        <p aria-label={label}>{savedValue || t("skillDetail.metadata.empty")}</p>
      ) : (
        <div className="sh-metadata-panel__form">
          {multiline ? (
            <textarea
              aria-label={label}
              disabled={mode === "saving"}
              onChange={(event) => setDraft(event.currentTarget.value)}
              ref={(element) => {
                fieldRef.current = element;
              }}
              rows={4}
              value={draft}
            />
          ) : (
            <input
              aria-label={label}
              disabled={mode === "saving"}
              onChange={(event) => setDraft(event.currentTarget.value)}
              ref={(element) => {
                fieldRef.current = element;
              }}
              value={draft}
            />
          )}
          {hint ? <p className="sh-metadata-panel__hint">{hint}</p> : null}
          <div>
            <Button
              aria-label={t("skillDetail.metadata.save", { label })}
              disabled={mode === "saving"}
              loading={mode === "saving"}
              onClick={save}
              size="sm"
            >
              {t("skillDetail.metadata.saveAction")}
            </Button>
            <Button
              disabled={mode === "saving"}
              onClick={() => {
                setDraft(savedValue);
                setError(undefined);
                setMode("read");
              }}
              size="sm"
              variant="ghost"
            >
              {t("actions.cancel")}
            </Button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      )}
    </section>
  );
}

export function MetadataPanel({ facade, metadata, skillId }: MetadataPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [translationConfirmation, setTranslationConfirmation] = useState(false);

  const savePatch = async (patch: SkillMetadataPatch) => {
    await facade.saveMetadata(skillId, patch);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: skillDetailKeys.metadata(skillId) }),
      queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
      queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
    ]);
  };
  const requestTranslation = async (overwriteUserRevision: boolean) => {
    await facade.emitIntent({
      locale: metadata.translation?.locale ?? "zh-CN",
      overwriteUserRevision,
      skillId,
      type: "translate_description",
    });
    setTranslationConfirmation(false);
  };

  return (
    <div className="sh-metadata-panel">
      <section className="sh-metadata-panel__facts">
        <h3>{t("skillDetail.metadata.identityFacts")}</h3>
        <dl>
          <div>
            <dt>{t("skillDetail.metadata.source")}</dt>
            <dd>{metadata.source ?? t("skillDetail.metadata.empty")}</dd>
          </div>
          <div>
            <dt>{t("skillDetail.metadata.ownership")}</dt>
            <dd>{metadata.ownership ?? t("skillDetail.metadata.empty")}</dd>
          </div>
          <div>
            <dt>{t("skillDetail.metadata.author")}</dt>
            <dd>{metadata.author ?? t("skillDetail.metadata.empty")}</dd>
          </div>
          <div>
            <dt>{t("skillDetail.metadata.license")}</dt>
            <dd>{metadata.license ?? t("skillDetail.metadata.empty")}</dd>
          </div>
          <div>
            <dt>{t("skillDetail.metadata.copyright")}</dt>
            <dd>{metadata.copyright ?? t("skillDetail.metadata.empty")}</dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>{t("skillDetail.metadata.originalDescription")}</h3>
        <p>{metadata.originalDescription ?? t("skillDetail.metadata.empty")}</p>
      </section>
      <section>
        <div className="sh-metadata-panel__section-heading">
          <h3>{t("skillDetail.metadata.translation")}</h3>
          <Button
            onClick={() => {
              if (metadata.translation?.userRevised) setTranslationConfirmation(true);
              else void requestTranslation(false);
            }}
            size="sm"
            variant="ghost"
          >
            {t("skillDetail.metadata.retranslate")}
          </Button>
        </div>
        <EditableTextSection
          key={`translation-${metadata.translation?.text ?? ""}`}
          label={t("skillDetail.metadata.translationText")}
          multiline
          onSave={(translationText) => savePatch({ translationText: translationText || null })}
          value={metadata.translation?.text ?? ""}
        />
        {metadata.translation ? (
          <div className="sh-metadata-panel__translation-facts">
            <span>{metadata.translation.locale}</span>
            <span>{metadata.translation.model}</span>
            <span>{metadata.translation.sourceVersion}</span>
            {metadata.translation.stale ? (
              <StatusBadge tone="warning">{t("skillDetail.metadata.stale")}</StatusBadge>
            ) : null}
            {metadata.translation.userRevised ? (
              <StatusBadge tone="info">{t("skillDetail.metadata.userRevised")}</StatusBadge>
            ) : null}
          </div>
        ) : null}
        {translationConfirmation ? (
          <div className="sh-metadata-panel__confirmation" role="alertdialog">
            <p>
              {t("skillDetail.metadata.translationOverwrite", {
                locale: metadata.translation?.locale,
              })}
            </p>
            <Button onClick={() => void requestTranslation(true)} size="sm">
              {t("skillDetail.metadata.confirmRetranslate")}
            </Button>
            <Button onClick={() => setTranslationConfirmation(false)} size="sm" variant="ghost">
              {t("actions.cancel")}
            </Button>
          </div>
        ) : null}
      </section>
      <EditableTextSection
        key={`alias-${metadata.alias ?? ""}`}
        label={t("skillDetail.metadata.alias")}
        onSave={(alias) => savePatch({ alias: alias || null })}
        value={metadata.alias ?? ""}
      />
      <EditableTextSection
        key={`purpose-${metadata.purpose}`}
        label={t("skillDetail.metadata.purpose")}
        multiline
        onSave={(purpose) => savePatch({ purpose })}
        value={metadata.purpose}
      />
      <EditableTextSection
        key={`tags-${metadata.tags.join(",")}`}
        label={t("skillDetail.metadata.tags")}
        hint={t("skillDetail.metadata.tagsHint")}
        onSave={(tags) =>
          savePatch({ tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) })
        }
        value={metadata.tags.join(", ")}
      />
      <EditableTextSection
        key={`note-${metadata.note ?? ""}`}
        label={t("skillDetail.metadata.note")}
        multiline
        onSave={(note) => savePatch({ note: note || null })}
        value={metadata.note ?? ""}
      />
    </div>
  );
}
