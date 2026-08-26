import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { skillLibraryKeys } from "../skills/api";
import type { SkillDetailFacade, SkillDetailSummary } from "./api";
import { skillDetailKeys } from "./api";

interface TrialActionsProps {
  facade: SkillDetailFacade;
  skillId: string;
  summary: SkillDetailSummary;
}

export function TrialActions({ facade, skillId, summary }: TrialActionsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(summary.trialDue ?? "");
  const [pending, setPending] = useState<"date" | "convert" | "abandon">();
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState<string>();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
      queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
    ]);
  };
  const saveDate = (due: string | null, kind: "date" | "convert") => {
    setPending(kind);
    setError(undefined);
    void facade.setTrial(skillId, due).then(
      async () => {
        await refresh();
        setEditing(false);
        setAnnouncement(
          due
            ? t("skillDetail.trial.saved", { date: due })
            : t("skillDetail.trial.converted"),
        );
      },
      () => setError(t("skillDetail.trial.saveError")),
    ).finally(() => setPending(undefined));
  };
  const abandon = () => {
    setPending("abandon");
    setError(undefined);
    void facade.emitIntent({ skillId, type: "abandon_trial" }).catch(() => {
      setError(t("skillDetail.trial.abandonError"));
    }).finally(() => setPending(undefined));
  };

  return (
    <div className="sh-trial-actions">
      {editing ? (
        <div className="sh-trial-actions__date">
          <label>
            {t("skillDetail.trial.reviewDate")}
            <input
              disabled={pending === "date"}
              onChange={(event) => setDate(event.currentTarget.value)}
              type="date"
              value={date}
            />
          </label>
          <Button
            disabled={!date || pending === "date"}
            loading={pending === "date"}
            onClick={() => saveDate(date, "date")}
            size="sm"
          >
            {t("skillDetail.trial.saveDate")}
          </Button>
          <Button disabled={pending === "date"} onClick={() => setEditing(false)} size="sm" variant="ghost">
            {t("actions.cancel")}
          </Button>
        </div>
      ) : summary.lifecycle === "trial" ? (
        <div className="sh-trial-actions__buttons">
          <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
            {t("skillDetail.trial.extend")}
          </Button>
          <Button loading={pending === "convert"} onClick={() => saveDate(null, "convert")} size="sm">
            {t("skillDetail.trial.convert")}
          </Button>
          <Button loading={pending === "abandon"} onClick={abandon} size="sm" variant="ghost">
            {t("skillDetail.trial.abandon")}
          </Button>
        </div>
      ) : (
        <Button onClick={() => setEditing(true)} size="sm" variant="secondary">
          {t("skillDetail.trial.set")}
        </Button>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {announcement ? <p aria-live="polite">{announcement}</p> : null}
    </div>
  );
}
