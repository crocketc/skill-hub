import { useMemo } from "react";
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
  const brandGroups = useMemo(() => {
    if (!targets) return [];
    const byBrand = new Map<string, CompatibilityTarget[]>();
    for (const target of targets) {
      const key = target.profileId ?? "";
      const list = byBrand.get(key) ?? [];
      list.push(target);
      byBrand.set(key, list);
    }
    return [...byBrand.entries()].map(([brand, items]) => ({ brand, items }));
  }, [targets]);
  // Grouped rendering only when the snapshot actually carries brand keys.
  const hasBrands = brandGroups.some((group) => group.brand !== "");

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
          {hasBrands ? (
            brandGroups.map((group) => (
              <div className="sh-onboarding__brand-group" key={group.brand || "__other"}>
                <p className="sh-onboarding__brand">
                  {group.brand || t("onboarding.brandOther")}
                </p>
                {group.items.map((target) => (
                  <TargetCheckbox
                    key={target.id}
                    target={target}
                    selectedTargetIds={selectedTargetIds}
                    onTargetSelectionChange={onTargetSelectionChange}
                  />
                ))}
              </div>
            ))
          ) : (
            targets.map((target) => (
              <TargetCheckbox
                key={target.id}
                target={target}
                selectedTargetIds={selectedTargetIds}
                onTargetSelectionChange={onTargetSelectionChange}
              />
            ))
          )}
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

function TargetCheckbox({
  target,
  selectedTargetIds,
  onTargetSelectionChange,
}: {
  target: CompatibilityTarget;
  selectedTargetIds: string[];
  onTargetSelectionChange: (targetId: string, selected: boolean) => void;
}) {
  const { t } = useTranslation();
  const kindKey = target.kind && isClientKind(target.kind)
    ? (`onboarding.clientKind.${target.kind}` as const)
    : null;
  return (
    <label className="sh-onboarding__check">
      <input
        aria-label={target.label}
        checked={selectedTargetIds.includes(target.id)}
        disabled={target.availability === "unavailable"}
        onChange={(event) => onTargetSelectionChange(target.id, event.target.checked)}
        type="checkbox"
      />
      {target.label}
      {kindKey ? <span className="sh-onboarding__kind">{t(kindKey)}</span> : null}
      {target.availability === "unavailable" ? ` (${t("onboarding.unavailable")})` : null}
    </label>
  );
}

const clientKindKeys = {
  cli: true,
  desktop: true,
  ide_extension: true,
  tui: true,
  headless: true,
  acp: true,
  web: true,
  mobile: true,
  bot: true,
} as const;

function isClientKind(kind: string): kind is keyof typeof clientKindKeys {
  return kind in clientKindKeys;
}
