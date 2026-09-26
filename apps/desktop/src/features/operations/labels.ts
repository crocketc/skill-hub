import { keyedMessage } from "../../api/nativeErrors";
import { formatDateTime, type SupportedLocale } from "../../i18n";

/**
 * DEV-98：操作记录可读标签的共享模块——恢复页、操作时间线等呈现面共用，
 * 保证「本地化操作名：对象名」的口径只有一处。
 */

/*
 * DEV-94：操作 kind 是内部技术名（import_skill 等），按「技术标识不进界面」
 * 约定映射为本地化操作名；不在表内的 kind（后端新增而映射未跟上）回退原文，
 * 由补映射修复，不在渲染层编造文案。
 */
export const KIND_LABEL_KEYS: Record<string, string> = {
  delete_skill: "operations.kinds.delete_skill",
  deploy_skill: "operations.kinds.deploy_skill",
  import_skill: "operations.kinds.import_skill",
  migrate_original: "operations.kinds.migrate_original",
  relink_source_copy: "operations.kinds.relink_source_copy",
  undeploy_skill: "operations.kinds.undeploy_skill",
  uninstall_skill: "operations.kinds.uninstall_skill",
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 本地化操作名；未映射的 kind 回退原文。 */
export function operationKindLabel(kind: string, translate: Translate): string {
  const key = KIND_LABEL_KEYS[kind];
  if (!key) return kind;
  const translated = translate(key);
  return translated === key ? kind : translated;
}

/** 「操作名：对象名」标题；无对象名时只返回操作名，两者皆缺返回空串。 */
export function operationObjectTitle(
  kind: string | undefined | null,
  objectName: string | undefined | null,
  translate: Translate,
): string {
  const label = kind ? operationKindLabel(kind, translate) : "";
  const name = objectName?.trim();
  if (label && name) return translate("operations.list.objectTitle", { label, name });
  return label;
}

/** DEV-99：错误码不独立成值——先按 keyedMessage 映射为既有失败文案；
 *  映射不到时退回「操作失败（码值）」通用说明，码值只作括注。 */
export function localizeErrorCode(code: string, translate: Translate): string {
  const key = keyedMessage(code, undefined);
  if (key) {
    const message = translate(key);
    if (message !== key) return message;
  }
  return translate("operations.list.errorFailure", { code });
}

/** DEV-94：后端 created_at 落库为 epoch 秒字符串（如 1789890340），按 ISO 解析
 *  会得到 Invalid Date 并把原始数字串回显给用户；10 位纯数字按秒转 Date。
 *  彻底解析不了的显示「—」，不回显原始值。 */
export function formatOperationTimes(values: string[], locale: SupportedLocale): string[] {
  return values.map((value) => {
    const epochSeconds = /^\d{10}$/.test(value) ? Number(value) : null;
    const date = epochSeconds !== null ? new Date(epochSeconds * 1000) : new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : formatDateTime(date, locale);
  });
}
