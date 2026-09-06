import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CombinationResult } from "../../api/bindings";
import { Button } from "../../ui/Button";
import type { SkillLibraryFacade } from "./api";

interface CombinationPanelProps {
  facade: SkillLibraryFacade;
  skillNames: Record<string, string>;
}

type PanelError = { message: string };

/**
 * FE-04 组合视图：组合列表 + 成员维护 + 删除内联确认 + 标准导出入口。
 * facade 未提供组合方法时整个面板不渲染（页面侧守卫）。
 */
export function CombinationPanel({ facade, skillNames }: CombinationPanelProps): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<PanelError>();
  const [exportResult, setExportResult] = useState<string>();
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<CombinationResult>();

  const combinationsQuery = useQuery({
    queryKey: ["skill-combinations"],
    queryFn: () => facade.listCombinations!(),
  });
  const combinations = combinationsQuery.data ?? [];

  const memberLabel = (skillId: string) => skillNames[skillId] ?? skillId.slice(0, 8);
  const describeMembers = (combination: CombinationResult) =>
    combination.members.map(memberLabel).join("、") || t("skillLibrary.combinations.noMembers");

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skill-combinations"] });
  };

  const run = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason: unknown) {
      setError({ message: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const submitCreation = () =>
    run(async () => {
      const name = newName.trim();
      if (!name || selectedMembers.length === 0) return;
      await facade.createCombination!(name, selectedMembers);
      setCreatorOpen(false);
      setNewName("");
      setSelectedMembers([]);
      await refresh();
    });

  const exportCombination = (combination: CombinationResult) =>
    run(async () => {
      setExportResult(undefined);
      const result = await facade.exportCombination!(combination.name);
      setExportResult(result.path);
    });

  const confirmDelete = (combination: CombinationResult) =>
    run(async () => {
      await facade.deleteCombination!(combination.name);
      setConfirmDeleteFor(undefined);
      await refresh();
    });

  return (
    <section className="sh-combination-panel" aria-label={t("skillLibrary.combinations.heading")}>
      <div className="sh-combination-panel__header">
        <h3>{t("skillLibrary.combinations.heading")}</h3>
        <Button size="sm" onClick={() => setCreatorOpen(true)}>
          {t("skillLibrary.combinations.create")}
        </Button>
      </div>
      {error ? <p role="alert">{error.message}</p> : null}
      {exportResult ? (
        <p role="status">{t("skillLibrary.combinations.exported", { path: exportResult })}</p>
      ) : null}
      {combinationsQuery.isLoading ? (
        <p>{t("skillLibrary.combinations.loading")}</p>
      ) : null}
      <ul>
        {combinations.map((combination) => (
          <li key={combination.name}>
            <div>
              <strong>{combination.name}</strong>
              <p>{describeMembers(combination)}</p>
            </div>
            <div className="sh-combination-panel__actions">
              {confirmDeleteFor?.name === combination.name ? (
                <>
                  <span role="status">
                    {t("skillLibrary.combinations.deleteBody", { name: combination.name })}
                  </span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void confirmDelete(combination)}
                  >
                    {t("skillLibrary.combinations.confirmDelete")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setConfirmDeleteFor(undefined)}
                  >
                    {t("skillLibrary.combinations.cancel")}
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={() => void exportCombination(combination)}>
                    {t("skillLibrary.combinations.export", { name: combination.name })}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setError(undefined);
                      setExportResult(undefined);
                      setConfirmDeleteFor(combination);
                    }}
                  >
                    {t("skillLibrary.combinations.delete", { name: combination.name })}
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
        {!combinationsQuery.isLoading && combinations.length === 0 ? (
          <li>{t("skillLibrary.combinations.empty")}</li>
        ) : null}
      </ul>
      {creatorOpen ? (
        <form
          aria-label={t("skillLibrary.combinations.create")}
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreation();
          }}
        >
          <label>
            {t("skillLibrary.combinations.nameLabel")}
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t("skillLibrary.combinations.namePlaceholder")}
            />
          </label>
          <fieldset>
            <legend>{t("skillLibrary.combinations.membersLabel")}</legend>
            {Object.entries(skillNames).map(([skillId, name]) => (
              <label key={skillId}>
                <input
                  type="checkbox"
                  checked={selectedMembers.includes(skillId)}
                  onChange={(event) =>
                    setSelectedMembers((current) =>
                      event.target.checked
                        ? [...current, skillId]
                        : current.filter((id) => id !== skillId),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </fieldset>
          <div className="sh-combination-panel__actions">
            <Button
              size="sm"
              type="submit"
              disabled={!newName.trim() || selectedMembers.length === 0}
            >
              {t("skillLibrary.combinations.save")}
            </Button>
            <Button size="sm" onClick={() => setCreatorOpen(false)}>
              {t("skillLibrary.combinations.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
