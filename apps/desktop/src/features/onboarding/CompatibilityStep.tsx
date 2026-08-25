import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

interface CompatibilityStepProps {
  confirmed: boolean;
  isDiscovering: boolean;
  onConfirmChange: (confirmed: boolean) => void;
  onDiscover: () => void;
}

export function CompatibilityStep({
  confirmed,
  isDiscovering,
  onConfirmChange,
  onDiscover,
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
    </section>
  );
}
