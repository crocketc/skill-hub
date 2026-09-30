import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CompatibilityStatus, DeploymentMode, RecordAgentCompatibility } from "../../api/bindings";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { describeNativeError } from "../../api/nativeErrors";
import "./agents.css";

export function CompatibilityFeedback({ targetId, mode, save, onSaved }: {
  targetId: string; mode: DeploymentMode;
  save: (request: RecordAgentCompatibility) => Promise<void>; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CompatibilityStatus>("unverified");
  const [version, setVersion] = useState("");
  const [evidence, setEvidence] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const submit = async () => {
    setBusy(true); setError(undefined); setSaved(false);
    try {
      await save({ target_id: targetId, mode, status, agent_version: version, evidence, agent_reading_checked: checked });
      setSaved(true);
      onSaved();
    } catch (reason) {
      setError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "agents.errors.unknown"));
    } finally { setBusy(false); }
  };
  return <fieldset disabled={busy} className="sh-compatibility-feedback">
    <legend>{t("agents.compatibility.mode", { mode: t(`agents.compatibility.methods.${mode}`) })}</legend>
    <p>{t("agents.compatibility.instructions")}</p>
    <label>{t("agents.compatibility.version")}<Input value={version} onChange={(event) => setVersion(event.target.value)} maxLength={200} /></label>
    <label>{t("agents.compatibility.result")}<Select value={status} onChange={(event) => setStatus(event.target.value as CompatibilityStatus)}>
      <option value="unverified">{t("agents.compatibility.unverified")}</option>
      <option value="supported">{t("agents.compatibility.supported")}</option>
      <option value="unsupported">{t("agents.compatibility.unsupported")}</option>
    </Select></label>
    <label>{t("agents.compatibility.evidence")}<textarea className="sh-input" value={evidence} onChange={(event) => setEvidence(event.target.value)} maxLength={4000} /></label>
    <label><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />{t("agents.compatibility.checked")}</label>
    <Button disabled={!version.trim() || !evidence.trim() || (status !== "unverified" && !checked)} loading={busy} onClick={() => void submit()}>{t("agents.compatibility.save")}</Button>
    {error ? <p role="alert">{error}</p> : null}
    {saved ? <p role="status">{t("agents.compatibility.saved")}</p> : null}
  </fieldset>;
}
