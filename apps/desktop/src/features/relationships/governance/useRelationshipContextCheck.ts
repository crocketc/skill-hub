import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RelationshipCheckLevel } from "../../../api/bindings";
import { relationshipsKeys } from "../api";
import type { RelationGovernanceFacade } from "./api";

/**
 * 任务 11.6：进入治理页时的上下文自动校验。
 *
 * 契约（计划 11.6）：
 * 1. 持久化清单先渲染，绝不为自动校验阻塞首屏；
 * 2. 首屏就绪后异步执行当前 scope 的 Light check（只探测范围内活动关系，不全量 hash）；
 * 3. 同一浏览器会话内同一 scope 只自动检查一次（sessionStorage 记忆）；
 * 4. 用户主动的重新检查（行按钮/批量）不走此入口，不受该限制。
 */
const STORAGE_PREFIX = "skillhub:governance:context-check:";

export interface RelationshipContextCheckOptions {
  facade: RelationGovernanceFacade;
  /** 当前 scope：all / source_copy / deployment，用作会话记忆键。 */
  scope: string;
  /** 参与检查的关系 id（当前清单可见行）；为空时不触发。 */
  relationIds: readonly string[];
  /** 首屏清单已渲染后才置 true，保证“先渲染、后检查”。 */
  enabled: boolean;
}

export function governanceContextCheckStorageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

export function useRelationshipContextCheck({
  facade,
  scope,
  relationIds,
  enabled,
}: RelationshipContextCheckOptions): void {
  const queryClient = useQueryClient();
  // 检查只在“已渲染且未检查过”的瞬间触发一次；relationIds 变化不重放。
  const firedRef = useRef(false);

  const runOnce = useCallback(async (level: RelationshipCheckLevel, ids: readonly string[]) => {
    if (ids.length === 0) return;
    try {
      await facade.revalidate([...ids], level);
    } catch {
      // 自动上下文检查失败保持安静：失效后的清单仍是可信事实源，
      // 用户可随时用行级重新检查补一次主动校验。
    } finally {
      // 无论结论如何都失效清单：Light check 可能推进 revision/归档事实。
      await queryClient.invalidateQueries({ queryKey: relationshipsKeys.root });
    }
  }, [facade, queryClient]);

  useEffect(() => {
    if (!enabled || firedRef.current) return;
    if (relationIds.length === 0) return;
    const key = governanceContextCheckStorageKey(scope);
    if (sessionStorage.getItem(key)) return;
    firedRef.current = true;
    sessionStorage.setItem(key, "1");
    void runOnce("light", relationIds);
    // relationIds 逐字进依赖会让检查随筛选重放；契约是“每个 scope 一次”。
  }, [enabled, scope]);
}
