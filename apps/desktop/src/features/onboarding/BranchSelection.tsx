import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";

export type InitializationBranch = "create" | "existing" | "restore";

interface BranchSelectionProps {
  onSelect: (branch: InitializationBranch) => void;
}

export function BranchSelection({ onSelect }: BranchSelectionProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="branch-selection-title" className="sh-onboarding__card">
      <span className="sh-onboarding__ordinal">0</span>
      <h1 id="branch-selection-title">{t("onboarding.branchTitle")}</h1>
      <p>{t("onboarding.branchDescription")}</p>
      <div className="sh-onboarding__branches">
        <Button onClick={() => onSelect("create")}>{t("onboarding.createLibrary")}</Button>
        <Button onClick={() => onSelect("existing")}>{t("onboarding.useExistingLibrary")}</Button>
        <Button onClick={() => onSelect("restore")}>{t("onboarding.restoreBackup")}</Button>
      </div>
    </section>
  );
}
