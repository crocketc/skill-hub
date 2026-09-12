import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { CombinationResult } from "../../api/bindings";
import {
  describeNativeError,
  nativeErrorCode,
  nativeErrorParams,
} from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import type { SkillLibraryFacade, SkillLibraryQuery, SkillTableRow } from "./api";

/** 成员候选分页大小：候选经 listSkills 真实分页查询，「加载更多」按页追加。 */
const CANDIDATE_PAGE_SIZE = 50;
/** 硬上限，防御异常 total 导致的无限追加；正常库远达不到。 */
const CANDIDATE_MAX_PAGES = 200;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * P1-09 组合命令错误 → 可读文案。组合语义的错误码（TargetExists、
 * 同名遗留数据的 OperationConflict、ObjectNotFound）优先给出含上下文的
 * 诚实文案；其余交给统一 describeNativeError 兜底，绝不显示裸错误对象。
 */
export function describeCombinationError(error: unknown, translate: Translate): string {
  const code = nativeErrorCode(error);
  const params = nativeErrorParams(error);
  const name = typeof params.combination === "string" ? params.combination : "";
  if (code === "deployment.target_exists") {
    return translate("skillLibrary.combinations.errors.targetExists", { name });
  }
  if (code === "operation.conflict") {
    return translate("skillLibrary.combinations.errors.conflict", {
      matches: typeof params.matches === "number" ? params.matches : String(params.matches ?? ""),
      name,
    });
  }
  if (code === "object.not_found") {
    return translate("skillLibrary.combinations.errors.notFound", { name });
  }
  return describeNativeError(error, translate, "skillLibrary.combinations.errors.generic");
}

interface MemberPickerProps {
  facade: SkillLibraryFacade;
  onCandidates: (items: SkillTableRow[]) => void;
  onToggle: (skillId: string, checked: boolean) => void;
  selected: string[];
}

/** 成员候选查询基线：与技能库默认查询一致，仅覆盖分页与文本/标签筛选。 */
const DEFAULT_MEMBER_QUERY: SkillLibraryQuery = {
  filters: {
    aiCheck: [],
    basicCheck: [],
    deployment: "any",
    lifecycle: [],
    tags: [],
    version: "any",
  },
  page: 1,
  pageSize: CANDIDATE_PAGE_SIZE,
  sort: { column: "name", direction: "asc" },
  text: "",
};

/**
 * P1-09 成员选择器：按名称/标签定位 Skill。候选来自真实 listSkills 分页
 * 查询（text + filters.tags），「加载更多」按页追加；不再一次性复述全库，
 * 也不依赖组件外部传入的固定窗口。
 */
function MemberPicker({ facade, onCandidates, onToggle, selected }: MemberPickerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  // 搜索文本防抖：避免每次按键都发起一次 listSkills IPC。
  const [debouncedText, setDebouncedText] = useState("");
  const [tag, setTag] = useState("");
  const [items, setItems] = useState<SkillTableRow[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedPages, setLoadedPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const reportCandidates = useRef(onCandidates);
  reportCandidates.current = onCandidates;
  // 查询代际：筛选变化重查（effect）或卸载都会使旧代际失效，
  // 在飞行中的 loadMore 响应不得再写状态或拼进新列表。
  const generationRef = useRef(0);

  const queryPage = (page: number): SkillLibraryQuery => ({
    ...DEFAULT_MEMBER_QUERY,
    filters: { ...DEFAULT_MEMBER_QUERY.filters, tags: tag ? [tag] : [] },
    page,
    text: debouncedText,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedText(text), 250);
    return () => window.clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    const generation = ++generationRef.current;
    setLoading(true);
    setUnavailable(false);
    facade
      .listSkills(queryPage(1))
      .then((result) => {
        if (generationRef.current !== generation) return;
        setItems(result.items);
        setTags(result.facets.tags);
        setTotal(result.total);
        setLoadedPages(1);
        reportCandidates.current(result.items);
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setUnavailable(true);
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
    // text 经 250ms 防抖后触发重查；onCandidates 经 ref 转发，
    // 避免把每次合并结果当作重查依赖。
  }, [facade, debouncedText, tag]);

  // 卸载后所有在飞行响应一律失效，不再写任何状态。
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  const loadMore = () => {
    const next = loadedPages + 1;
    if (loading || next > CANDIDATE_MAX_PAGES) return;
    const generation = generationRef.current;
    setLoading(true);
    setUnavailable(false);
    facade
      .listSkills(queryPage(next))
      .then((result) => {
        if (generationRef.current !== generation) return;
        setItems((current) => [...current, ...result.items]);
        setTotal(result.total);
        setLoadedPages(next);
        reportCandidates.current(result.items);
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setUnavailable(true);
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
  };

  return (
    <div className="sh-combination-panel__picker">
      <div className="sh-combination-panel__picker-filters">
        <label>
          {t("skillLibrary.combinations.memberFilterLabel")}
          <Input
            onChange={(event) => setText(event.currentTarget.value)}
            type="search"
            value={text}
          />
        </label>
        <label>
          {t("skillLibrary.combinations.tagFilterLabel")}
          <Select
            onChange={(event) => setTag(event.currentTarget.value)}
            value={tag}
          >
            <option value="">{t("skillLibrary.combinations.tagFilterAll")}</option>
            {tags.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {unavailable ? (
        <p role="alert">{t("skillLibrary.combinations.candidatesUnavailable")}</p>
      ) : null}
      {!unavailable && !loading && items.length === 0 ? (
        <p>{t("skillLibrary.combinations.candidatesEmpty")}</p>
      ) : null}
      <div className="sh-combination-panel__candidates">
        {items.map((item) => (
          <label key={item.id}>
            <input
              checked={selected.includes(item.id)}
              onChange={(event) => onToggle(item.id, event.currentTarget.checked)}
              type="checkbox"
            />
            {item.name}
          </label>
        ))}
      </div>
      {items.length < total ? (
        <Button disabled={loading} onClick={loadMore} size="sm" variant="secondary">
          {t("skillLibrary.combinations.loadMore")}
        </Button>
      ) : null}
    </div>
  );
}

interface CombinationFormProps {
  facade: SkillLibraryFacade;
  initialMembers: string[];
  initialName: string;
  mode: "create" | "edit";
  names: Record<string, string>;
  onCancel: () => void;
  onCandidates: (items: SkillTableRow[]) => void;
  onSubmit: (name: string, members: string[]) => void;
}

/** 创建/编辑成员共用表单：编辑模式锁定名称（改名走独立重命名入口）。 */
function CombinationForm({
  facade,
  initialMembers,
  initialName,
  mode,
  names,
  onCancel,
  onCandidates,
  onSubmit,
}: CombinationFormProps): JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [members, setMembers] = useState<string[]>(initialMembers);

  const toggle = (skillId: string, checked: boolean) =>
    setMembers((current) =>
      checked ? [...current, skillId] : current.filter((id) => id !== skillId),
    );

  const resolveName = (skillId: string) => names[skillId] ?? skillId.slice(0, 8);

  return (
    <form
      aria-label={t(
        mode === "create"
          ? "skillLibrary.combinations.create"
          : "skillLibrary.combinations.editFormLabel",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name, members);
      }}
    >
      {mode === "create" ? (
        <label>
          {t("skillLibrary.combinations.nameLabel")}
          <Input
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={t("skillLibrary.combinations.namePlaceholder")}
            value={name}
          />
        </label>
      ) : (
        <p>
          <strong>{t("skillLibrary.combinations.nameLockedLabel", { name: initialName })}</strong>
        </p>
      )}
      <fieldset>
        <legend>{t("skillLibrary.combinations.membersLabel")}</legend>
        <p>{t("skillLibrary.combinations.selectedLabel", { count: members.length })}</p>
        <ul className="sh-combination-panel__selected">
          {members.map((id) => (
            <li key={id}>
              {resolveName(id)}
              <Button
                aria-label={t("skillLibrary.combinations.removeMember", {
                  name: resolveName(id),
                })}
                onClick={() => toggle(id, false)}
                size="sm"
                variant="ghost"
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
        <MemberPicker
          facade={facade}
          onCandidates={onCandidates}
          onToggle={toggle}
          selected={members}
        />
      </fieldset>
      <div className="sh-combination-panel__actions">
        <Button disabled={!name.trim() || members.length === 0} size="sm" type="submit">
          {t(
            mode === "create"
              ? "skillLibrary.combinations.save"
              : "skillLibrary.combinations.saveEdit",
          )}
        </Button>
        <Button onClick={onCancel} size="sm" variant="secondary">
          {t("skillLibrary.combinations.cancel")}
        </Button>
      </div>
    </form>
  );
}

interface CombinationPanelProps {
  facade: SkillLibraryFacade;
  skillNames: Record<string, string>;
}

/**
 * FE-04 + P1-09 组合视图：组合列表（逐成员徽章 + 数量）、创建、编辑成员
 * （可选 facade 方法守卫）、重命名（可选方法守卫，成功文案本地化）、
 * 删除（ConfirmDialog 展示成员数与影响面：只删组合记录，不动 Skill/部署/文件）、
 * 标准导出与 /deploy?skill= 预选入口。
 */
export function CombinationPanel({ facade, skillNames }: CombinationPanelProps): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [exportResult, setExportResult] = useState<string>();
  const [renamedStatus, setRenamedStatus] = useState<string>();
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editingFor, setEditingFor] = useState<CombinationResult>();
  const [renamingFor, setRenamingFor] = useState<CombinationResult>();
  const [renameTo, setRenameTo] = useState("");
  const [extraNames, setExtraNames] = useState<Record<string, string>>({});

  const combinationsQuery = useQuery({
    queryKey: ["skill-combinations"],
    queryFn: () => facade.listCombinations!(),
  });
  const combinations = combinationsQuery.data ?? [];
  const names = { ...skillNames, ...extraNames };

  const memberLabel = (skillId: string) => names[skillId] ?? skillId.slice(0, 8);
  const describeError = (reason: unknown) =>
    describeCombinationError(reason, (key, options) =>
      String(t(key as never, options as never)),
    );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skill-combinations"] });
  };

  const run = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason: unknown) {
      setError(describeError(reason));
    }
  };

  const absorbCandidates = (items: SkillTableRow[]) => {
    if (items.length === 0) return;
    setExtraNames((current) => {
      const merged = { ...current };
      for (const item of items) merged[item.id] = item.name;
      return merged;
    });
  };

  const closeOverlays = () => {
    setCreatorOpen(false);
    setEditingFor(undefined);
    setRenamingFor(undefined);
    setRenameTo("");
  };

  const clearFeedback = () => {
    setError(undefined);
    setExportResult(undefined);
    setRenamedStatus(undefined);
  };

  const submitCreation = (name: string, members: string[]) =>
    run(async () => {
      const trimmed = name.trim();
      // 前端重名防护：后端 TargetExists 之前就地拦截，避免把同名重复写进仓储。
      if (combinations.some((combination) => combination.name === trimmed)) {
        setError(
          t("skillLibrary.combinations.errors.targetExists", { name: trimmed }),
        );
        return;
      }
      await facade.createCombination!(trimmed, members);
      closeOverlays();
      await refresh();
    });

  const submitMemberEdit = (name: string, members: string[]) =>
    run(async () => {
      await facade.updateCombination!(name, members);
      closeOverlays();
      await refresh();
    });

  const submitRename = () =>
    run(async () => {
      const source = renamingFor;
      if (!source || !facade.renameCombination) return;
      const target = renameTo.trim();
      if (!target || target === source.name) return;
      if (combinations.some((combination) => combination.name === target)) {
        setError(t("skillLibrary.combinations.errors.targetExists", { name: target }));
        return;
      }
      const updated = await facade.renameCombination(source.name, target);
      closeOverlays();
      // rename 成功结果是视图而非 operation_summary，无 message_code，
      // 成功反馈由本地文案承担（诚实缺省，不假借后端码）。
      setRenamedStatus(t("skillLibrary.combinations.renamedStatus", { name: updated.name }));
      await refresh();
    });

  const exportCombination = (combination: CombinationResult) =>
    run(async () => {
      setExportResult(undefined);
      const result = await facade.exportCombination!(combination.name);
      setExportResult(result.path);
    });

  // 整体部署：复用既有批量部署页（/deploy?skill=…），组合成员预选进入；
  // 不新增写语义——预检、目标选择与提交仍在批量部署页显式完成。
  const deployCombination = (combination: CombinationResult) => {
    clearFeedback();
    const params = new URLSearchParams();
    for (const member of combination.members) params.append("skill", member);
    navigate(`/deploy?${params.toString()}`);
  };

  const confirmDelete = (combination: CombinationResult) =>
    run(async () => {
      await facade.deleteCombination!(combination.name);
      await refresh();
    });

  return (
    <section className="sh-combination-panel" aria-label={t("skillLibrary.combinations.heading")}>
      <div className="sh-combination-panel__header">
        <h3>{t("skillLibrary.combinations.heading")}</h3>
        <Button
          size="sm"
          onClick={() => {
            clearFeedback();
            setEditingFor(undefined);
            setRenamingFor(undefined);
            setRenameTo("");
            setCreatorOpen(true);
          }}
        >
          {t("skillLibrary.combinations.create")}
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {renamedStatus ? <p role="status">{renamedStatus}</p> : null}
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
              <p className="sh-combination-panel__members-heading">
                {t("skillLibrary.combinations.membersHeading", {
                  count: combination.members.length,
                })}
              </p>
              <ul className="sh-combination-panel__members">
                {combination.members.length === 0 ? (
                  <li>{t("skillLibrary.combinations.noMembers")}</li>
                ) : (
                  combination.members.map((member) => (
                    <li key={member}>{memberLabel(member)}</li>
                  ))
                )}
              </ul>
            </div>
            <div className="sh-combination-panel__actions">
              {facade.updateCombination ? (
                <Button
                  size="sm"
                  onClick={() => {
                    clearFeedback();
                    setCreatorOpen(false);
                    setRenamingFor(undefined);
                    setRenameTo("");
                    setEditingFor(combination);
                  }}
                >
                  {t("skillLibrary.combinations.edit", { name: combination.name })}
                </Button>
              ) : null}
              {facade.renameCombination ? (
                <Button
                  size="sm"
                  onClick={() => {
                    clearFeedback();
                    setCreatorOpen(false);
                    setEditingFor(undefined);
                    setRenamingFor(combination);
                    setRenameTo(combination.name);
                  }}
                >
                  {t("skillLibrary.combinations.rename", { name: combination.name })}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => void exportCombination(combination)}>
                {t("skillLibrary.combinations.export", { name: combination.name })}
              </Button>
              <Button
                size="sm"
                title={t("skillLibrary.combinations.deployHint")}
                onClick={() => deployCombination(combination)}
              >
                {t("skillLibrary.combinations.deploy", { name: combination.name })}
              </Button>
              <ConfirmDialog
                cancelLabel={t("skillLibrary.combinations.cancel")}
                confirmLabel={t("skillLibrary.combinations.confirmDelete")}
                description={t("skillLibrary.combinations.deleteBody", {
                  count: combination.members.length,
                  name: combination.name,
                })}
                onConfirm={() => void confirmDelete(combination)}
                title={t("skillLibrary.combinations.deleteTitle", { name: combination.name })}
                trigger={
                  <Button size="sm">
                    {t("skillLibrary.combinations.delete", { name: combination.name })}
                  </Button>
                }
                variant="danger"
              />
            </div>
          </li>
        ))}
        {!combinationsQuery.isLoading && combinations.length === 0 ? (
          <li>{t("skillLibrary.combinations.empty")}</li>
        ) : null}
      </ul>
      {creatorOpen ? (
        <CombinationForm
          facade={facade}
          initialMembers={[]}
          initialName=""
          mode="create"
          names={names}
          onCancel={() => closeOverlays()}
          onCandidates={absorbCandidates}
          onSubmit={submitCreation}
        />
      ) : null}
      {editingFor ? (
        <CombinationForm
          facade={facade}
          initialMembers={editingFor.members}
          initialName={editingFor.name}
          mode="edit"
          names={names}
          onCancel={() => closeOverlays()}
          onCandidates={absorbCandidates}
          onSubmit={submitMemberEdit}
        />
      ) : null}
      {renamingFor ? (
        <form
          aria-label={t("skillLibrary.combinations.renameFormLabel")}
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <label>
            {t("skillLibrary.combinations.renameLabel")}
            <Input
              onChange={(event) => setRenameTo(event.currentTarget.value)}
              value={renameTo}
            />
          </label>
          <div className="sh-combination-panel__actions">
            <Button
              disabled={!renameTo.trim() || renameTo.trim() === renamingFor.name}
              size="sm"
              type="submit"
            >
              {t("skillLibrary.combinations.saveName")}
            </Button>
            <Button onClick={() => closeOverlays()} size="sm" variant="secondary">
              {t("skillLibrary.combinations.cancel")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
