import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

interface ScanStepProps {
  isScanning: boolean;
  onScan: () => void;
}

export function ScanStep({ isScanning, onScan }: ScanStepProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="scan-step-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">3</span>
      <h1 id="scan-step-title">{t("onboarding.scanTitle")}</h1>
      <p>{t("onboarding.scanDescription")}</p>
      <Button loading={isScanning} onClick={onScan}>
        {t("onboarding.startReadOnlyScan")}
      </Button>
    </section>
  );
}
