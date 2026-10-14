import * as Dialog from "@radix-ui/react-dialog";
import { useState, type JSX } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CombinationResult } from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { skillLibraryKeys } from "./api";

export type BatchCombinationAction = "add" | "remove";

interface BatchCombinationDialogProps {
  action: BatchCombinationAction;
  count: number;
  error?: string;
  listCombinations: () => Promise<CombinationResult[]>;
  onCancel: () => void;
  onConfirm: (combinationNames: string[]) => void;
  pending: boolean;
}

export function BatchCombinationDialog({
  action,
  count,
  error,
  listCombinations,
  onCancel,
  onConfirm,
  pending,
}: BatchCombinationDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const combinationsQuery = useQuery({
    queryFn: listCombinations,
    queryKey: skillLibraryKeys.combinations(),
  });
  const combinations = combinationsQuery.data ?? [];
  const titleKey = action === "add"
    ? "skillLibrary.page.batch.addCombinations"
    : "skillLibrary.page.batch.removeCombinations";
  const descriptionKey = action === "add"
    ? "skillLibrary.page.batch.addCombinationsDescription"
    : "skillLibrary.page.batch.removeCombinationsDescription";
  const loadError = combinationsQuery.error
    ? describeNativeError(
      combinationsQuery.error,
      (key, options) => String(t(key as never, options as never)),
      "skillLibrary.page.batch.combinationsLoadError",
    )
    : undefined;
  const toggle = (name: string) => {
    setSelectedNames((current) => current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name]);
  };
  const loading = combinationsQuery.isPending || combinationsQuery.isFetching;
  const canSubmit = selectedNames.length > 0 && !loading && !combinationsQuery.isError && !pending;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="sh-overlay" />
        <Dialog.Content aria-describedby="batch-combination-description" className="sh-dialog sh-batch-combination-dialog" aria-label={t(titleKey)}>
          <Dialog.Title className="sh-dialog__title">{t(titleKey)}</Dialog.Title>
          <Dialog.Description className="sh-dialog__description" id="batch-combination-description">
            {t(descriptionKey, { count })}
          </Dialog.Description>

          {loading ? (
            <p className="sh-batch-combination-dialog__status" role="status">
              {t("skillLibrary.page.batch.combinationsLoading")}
            </p>
          ) : null}
          {loadError ? (
            <div className="sh-batch-combination-dialog__error" role="alert">
              <span>{loadError}</span>
              <Button disabled={pending} onClick={() => void combinationsQuery.refetch()} size="sm" variant="secondary">
                {t("actions.retry")}
              </Button>
            </div>
          ) : null}
          {!loading && !combinationsQuery.isError && combinations.length === 0 ? (
            <div className="sh-batch-combination-dialog__empty">
              <p>{t("skillLibrary.page.batch.combinationsEmpty")}</p>
              <Dialog.Close asChild>
                <Link className="sh-button sh-button--secondary sh-button--sm" to="/library/combinations">
                  {t("skillLibrary.page.batch.openCombinationManager")}
                </Link>
              </Dialog.Close>
            </div>
          ) : null}
          {combinations.length > 0 ? (
            <fieldset className="sh-batch-combination-dialog__choices" disabled={pending}>
              <legend>{t("skillLibrary.page.batch.combinationsLabel")}</legend>
              {combinations.map((combination) => (
                <label key={combination.name}>
                  <input
                    aria-label={combination.name}
                    checked={selectedNames.includes(combination.name)}
                    onChange={() => toggle(combination.name)}
                    type="checkbox"
                  />
                  <span>{combination.name}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {error ? <p className="sh-batch-combination-dialog__error" role="alert">{error}</p> : null}
          <div className="sh-dialog__actions">
            <Button disabled={pending} onClick={onCancel} variant="secondary">
              {t("actions.cancel")}
            </Button>
            <Button
              disabled={!canSubmit}
              loading={pending}
              onClick={() => onConfirm(selectedNames)}
            >
              {t(titleKey)}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
