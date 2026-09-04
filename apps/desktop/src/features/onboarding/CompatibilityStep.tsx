import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import type { CompatibilityTarget } from "../bootstrap/api";

interface CompatibilityStepProps {
  confirmed: boolean;
  isDiscovering: boolean;
  selectionConfirmed: boolean;
  selectedTargetIds: string[];
  targets: CompatibilityTarget[] | null;
  onConfirmChange: (confirmed: boolean) => void;
  onDiscover: () => void;
  onSelectionConfirmChange: (confirmed: boolean) => void;
  onTargetSelectionChange: (targetId: string, selected: boolean) => void;
  onSelectAllAvailable: () => void;
}

export function CompatibilityStep({
  confirmed,
  isDiscovering,
  selectionConfirmed,
  selectedTargetIds,
  targets,
  onConfirmChange,
  onDiscover,
  onSelectionConfirmChange,
  onTargetSelectionChange,
  onSelectAllAvailable,
}: CompatibilityStepProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="compatibility-step-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">2</span>
      <h1 id="compatibility-step-title">{t("onboarding.compatibilityTitle")}</h1>
      <p>{t("onboarding.compatibilityDescription")}</p>
      <label className="sh-onboarding__check">
        <input
          checked={confirmed}
          onChange={(event) => onConfirmChange(event.target.checked)}
          type="checkbox"
        />
        {t("onboarding.compatibilityConfirmation")}
      </label>
      <Button
        disabled={!confirmed}
        loading={isDiscovering}
        onClick={onDiscover}
      >
        {t("onboarding.discoverAgents")}
      </Button>
      {targets && targets.length === 0 ? <p>{t("onboarding.noCompatibleTargets")}</p> : null}
      {targets && targets.length > 0 ? (
        <fieldset className="sh-onboarding__targets">
          <legend>{t("onboarding.compatibilityTargets")}</legend>
          {targets.some((target) => target.availability === "available") ? (
            <Button onClick={onSelectAllAvailable} size="sm" variant="secondary">
              {t("onboarding.selectAllAvailable")}
            </Button>
          ) : null}
          {targets.map((target) => (
            <label className="sh-onboarding__check" key={target.id}>
              <input
                aria-label={target.label}
                checked={selectedTargetIds.includes(target.id)}
                disabled={target.availability === "unavailable"}
                onChange={(event) => onTargetSelectionChange(target.id, event.target.checked)}
                type="checkbox"
              />
              {target.label}
              {target.availability === "unavailable" ? ` (${t("onboarding.unavailable")})` : null}
            </label>
          ))}
        </fieldset>
      ) : null}
      {selectedTargetIds.length > 0 ? (
        <label className="sh-onboarding__check">
          <input
            checked={selectionConfirmed}
            onChange={(event) => onSelectionConfirmChange(event.target.checked)}
            type="checkbox"
          />
          {t("onboarding.selectionConfirmation")}
        </label>
      ) : null}
    </section>
  );
}
