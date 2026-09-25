import { render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoverySnapshot } from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { onDiscoveryFactsChanged } from "../../platform/discoveryEvents";
import { AgentDiscoveryRefreshBridge } from "./AgentDiscoveryRefreshBridge";
import type { NotifyFunction } from "./backgroundScan";

function snapshotWith(instances: Array<{ profile_id: string; client_id: string; kind: string }>): DiscoverySnapshot {
  return {
    generation: "gen",
    observed_at: "2026-09-26T00:00:00Z",
    instances: instances.map((instance) => ({
      ...instance,
      supported_os: ["windows"],
      client_presence: "Unknown",
    })) as DiscoverySnapshot["instances"],
    logical_targets: [],
    physical_targets: [],
  };
}

async function renderBridge(props: {
  notify: NotifyFunction;
  enabled: boolean;
  readSnapshot?: () => Promise<DiscoverySnapshot>;
  runDiscovery?: () => Promise<DiscoverySnapshot>;
}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  return render(
    <I18nextProvider i18n={i18n}>
      <AgentDiscoveryRefreshBridge {...props} />
    </I18nextProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentDiscoveryRefreshBridge", () => {
  it("notifies with the new brands when startup discovery finds new clients", async () => {
    const notify = vi.fn();
    const factListener = vi.fn();
    const unsubscribe = onDiscoveryFactsChanged(factListener);

    await renderBridge({
      notify,
      enabled: true,
      readSnapshot: async () => snapshotWith([{ profile_id: "openai", client_id: "codex-cli", kind: "cli" }]),
      runDiscovery: async () => snapshotWith([
        { profile_id: "openai", client_id: "codex-cli", kind: "cli" },
        { profile_id: "pi", client_id: "pi.coding-agent", kind: "cli" },
      ]),
    });

    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const notice = notify.mock.calls[0][0];
    expect(notice.tone).toBe("info");
    expect(notice.title).toContain("新的 Agent");
    expect(notice.detail).toContain("Pi");
    expect(notice.action?.to).toBe("/agents");
    // 通知与广播同步发出：notify 一到，广播监听者必然已被触发。
    expect(factListener).toHaveBeenCalled();
    unsubscribe();
  });

  it("stays silent when the snapshot did not grow new clients", async () => {
    const notify = vi.fn();
    const same = snapshotWith([{ profile_id: "openai", client_id: "codex-cli", kind: "cli" }]);

    await renderBridge({
      notify,
      enabled: true,
      readSnapshot: async () => same,
      runDiscovery: async () => same,
    });

    await waitFor(() => expect(screen.queryByText(/新的 Agent/)).toBeNull());
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps startup quiet when the background discovery fails", async () => {
    const notify = vi.fn();

    await renderBridge({
      notify,
      enabled: true,
      readSnapshot: async () => snapshotWith([]),
      runDiscovery: async () => { throw new Error("native unavailable"); },
    });

    // 失败只静默：Agent 页随时可以手动重扫，启动期告警会变成固定噪音。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not run before initialization completes", async () => {
    const runDiscovery = vi.fn(async () => snapshotWith([]));

    await renderBridge({ notify: vi.fn(), enabled: false, runDiscovery });

    expect(runDiscovery).not.toHaveBeenCalled();
  });
});
