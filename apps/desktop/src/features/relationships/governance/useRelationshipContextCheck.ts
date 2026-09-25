import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RelationshipCheckLevel } from "../../../api/bindings";
import { relationshipsKeys } from "../api";
import type { RelationGovernanceFacade } from "./api";

/**
 * 任务 11.6/12.7：进入治理页或对象详情时的上下文自动校验。
 *
 * 契约（计划 11.6/12.7）：
 * 1. 持久化清单先渲染，绝不为自动校验阻塞首屏；
 * 2. 首屏就绪后异步执行当前 scope 的 Light check（只探测范围内活动关系，不全量 hash）；
 * 3. 同一浏览器会话内同一 scope（+ 去重 token：关系修订/检查代次）只自动检查一次；
 * 4. 失败不标记完成——同会话重挂载或修订推进后会重试；
 * 5. 用户主动的重新检查（行按钮/批量）不走此入口，不受该限制。
 */
const STORAGE_PREFIX = "skillhub:governance:context-check:";

export interface RelationshipContextCheckOptions {
  facade: RelationGovernanceFacade;
  /** 当前 scope：治理页的 all/source_copy/deployment，或对象详情的 skill:<id> 等。 */
  scope: string;
  /** 去重键的修订成分（关系修订号/检查代次）；缺省时仅按 scope 记忆。 */
  dedupeToken?: string;
  /** 参与检查的关系 id（当前清单可见行）；为空时不触发。 */
  relationIds: readonly string[];
  /** 首屏清单已渲染后才置 true，保证“先渲染、后检查”。 */
  enabled: boolean;
}

export function governanceContextCheckStorageKey(scope: string, dedupeToken?: string): string {
  return dedupeToken
    ? `${STORAGE_PREFIX}${scope}@${dedupeToken}`
    : `${STORAGE_PREFIX}${scope}`;
}

export function useRelationshipContextCheck({
  facade,
  scope,
  dedupeToken,
  relationIds,
  enabled,
}: RelationshipContextCheckOptions): void {
  const queryClient = useQueryClient();
  // 同一会话键（scope+修订）只在本挂载实例发起一次；失败后不写会话记忆，
  // 重挂载或修订推进（新键）可重试。
  const firedKeyRef = useRef<string | null>(null);

  const runOnce = useCallback(
    async (level: RelationshipCheckLevel, ids: readonly string[]): Promise<boolean> => {
      if (ids.length === 0) return false;
      try {
        await facade.revalidate([...ids], level);
      } catch {
        // 自动上下文检查失败保持安静：失效后的清单仍是可信事实源，
        // 用户可随时用行级重新检查补一次主动校验；但本次不标记完成。
        await queryClient.invalidateQueries({ queryKey: relationshipsKeys.root });
        return false;
      }
      // 无论结论如何都失效清单：Light check 可能推进 revision/归档事实。
      await queryClient.invalidateQueries({ queryKey: relationshipsKeys.root });
      return true;
    },
    [facade, queryClient],
  );

  useEffect(() => {
    if (!enabled) return;
    if (relationIds.length === 0) return;
    const key = governanceContextCheckStorageKey(scope, dedupeToken);
    if (sessionStorage.getItem(key)) return;
    if (firedKeyRef.current === key) return;
    firedKeyRef.current = key;
    void runOnce("light", relationIds).then((succeeded) => {
      if (succeeded) sessionStorage.setItem(key, "1");
    });
    // relationIds 逐字进依赖会让检查随筛选重放；契约是“每个 scope+修订一次”。
  }, [enabled, scope, dedupeToken]);
}
