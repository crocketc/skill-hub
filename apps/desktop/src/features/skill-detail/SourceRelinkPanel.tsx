import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";

export interface SourceRelinkFacade {
  /** 解析输入并调用 relink_source；由 native 层组合 parse + relink 两个契约。 */
  relinkSource: (skillId: string, sourceInput: string) => Promise<{ messageCode: string }>;
}

interface SourceRelinkPanelProps {
  facade: SourceRelinkFacade;
  skillId: string;
}

/**
 * FE-06 来源重新关联：把受管 Skill 关联到新的本地/远程来源。
 * 只改来源记录，不移动文件；成功与失败均如实反馈。
 */
export function SourceRelinkPanel({ facade, skillId }: SourceRelinkPanelProps) {
  const { t } = useTranslation();
  const [sourceInput, setSourceInput] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!sourceInput.trim()) return;
    setPending(true);
    setError(null);
    try {
      await facade.relinkSource(skillId, sourceInput.trim());
      setDone(true);
      setSourceInput("");
    } catch (reason) {
      // 结构化 AppError 直接 String() 会变成 "[object Object]"；统一走
      // 分类文案，让失败原因以中英文可读形式呈现。
      setError(
        describeNativeError(
          reason,
          (key, options) => String(t(key as never, options as never)),
          "skillDetail.sourceRelink.failureUnknown",
        ),
      );
      setDone(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label={t("skillDetail.sourceRelink.ariaLabel")} className="sh-source-relink">
      <div className="sh-source-relink__row">
        <input
          aria-label={t("skillDetail.sourceRelink.inputLabel")}
          disabled={pending}
          onChange={(event) => setSourceInput(event.target.value)}
          placeholder={t("skillDetail.sourceRelink.inputPlaceholder")}
          type="text"
          value={sourceInput}
        />
        <Button disabled={pending || !sourceInput.trim()} onClick={() => void submit()} variant="secondary">
          {t("skillDetail.sourceRelink.submit")}
        </Button>
      </div>
      {done ? <p role="status">{t("skillDetail.sourceRelink.done")}</p> : null}
      {error ? <p role="alert">{t("skillDetail.sourceRelink.failed", { error })}</p> : null}
    </section>
  );
}
