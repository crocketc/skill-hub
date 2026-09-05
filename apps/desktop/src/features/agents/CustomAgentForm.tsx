import { useState } from "react";
import { useTranslation } from "react-i18next";
import { desktopDirectoryPicker, type DirectoryPicker } from "../../platform/directoryPicker";
import { Button } from "../../ui/Button";
import { type AgentFacade, type AgentView, type CustomAgentFormValues } from "./api";

export interface CustomAgentFormProps {
  /** Present in edit mode; absent for creation. */
  agent?: AgentView;
  facade: AgentFacade;
  onCancel: () => void;
  onSaved: () => void;
  picker?: DirectoryPicker;
}

function isInvalidReferenceUrl(value: string): boolean {
  return !/^https?:\/\//.test(value);
}

export function CustomAgentForm({
  agent,
  facade,
  onCancel,
  onSaved,
  picker = desktopDirectoryPicker,
}: CustomAgentFormProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(agent?.instance ?? "");
  const [brand, setBrand] = useState(agent?.brand ?? "");
  const [referenceUrl, setReferenceUrl] = useState(agent?.officialReference ?? "");
  const [directoryPath, setDirectoryPath] = useState(agent?.discoveredPaths[0] ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const pickDirectory = async () => {
    setError(undefined);
    try {
      const picked = await picker.pickDirectory();
      if (picked) setDirectoryPath(picked);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    }
  };

  const submit = async () => {
    const values: CustomAgentFormValues = {
      brand: brand.trim(),
      displayName: displayName.trim(),
      directoryPath,
      referenceUrl: referenceUrl.trim(),
    };
    if (!values.displayName || !values.brand || !values.referenceUrl || !values.directoryPath) {
      setError(t("agents.customForm.errors.incomplete"));
      return;
    }
    if (isInvalidReferenceUrl(values.referenceUrl)) {
      setError(t("agents.customForm.errors.invalidReferenceUrl"));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      if (agent) await facade.updateCustomAgent(agent.id, values);
      else await facade.createCustomAgent(values);
      onSaved();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("agents.errors.unknown"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="sh-agent-custom-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>{t("agents.customForm.description")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <label>
        <span>{t("agents.customForm.displayName")}</span>
        <input
          onChange={(event) => setDisplayName(event.target.value)}
          type="text"
          value={displayName}
        />
      </label>
      <label>
        <span>{t("agents.customForm.brand")}</span>
        <input
          onChange={(event) => setBrand(event.target.value)}
          type="text"
          value={brand}
        />
      </label>
      <label>
        <span>{t("agents.customForm.referenceUrl")}</span>
        <input
          onChange={(event) => setReferenceUrl(event.target.value)}
          type="text"
          value={referenceUrl}
        />
      </label>
      <label>
        <span>{t("agents.customForm.directory")}</span>
        <code data-testid="custom-agent-directory">
          {directoryPath || t("agents.customForm.directoryMissing")}
        </code>
      </label>
      <div className="sh-agent-custom-form__actions">
        <Button onClick={() => void pickDirectory()} variant="secondary">
          {t("agents.actions.pickDirectory")}
        </Button>
        <Button loading={saving} type="submit">
          {t("agents.actions.save")}
        </Button>
        <Button onClick={onCancel} variant="ghost">
          {t("agents.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}
