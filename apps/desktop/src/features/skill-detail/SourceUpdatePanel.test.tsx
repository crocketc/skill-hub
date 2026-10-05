import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import type {
  SourceUpdatePreview,
  SourceUpdateStatus,
  UpstreamCheckResult,
} from "../../api/bindings";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import { skillDetailKeys } from "./api";
import { SourceUpdatePanel, type SourceUpdateFacade } from "./SourceUpdatePanel";

const checkResult: UpstreamCheckResult = {
  skill_id: "s1",
  state: "update_available",
  local_version: "v3",
  upstream_version: "v4",
  upstream_label: "v4.0",
  candidate_identity: "sha256:cand123456789",
};

const preview: SourceUpdatePreview = {
  skill_id: "s1",
  preview_id: "preview-1",
  expires_at: "2026-10-04T12:00:00Z",
  confirmation_fingerprint: "fp-1",
  current_version_id: "sha256:v3",
  candidate_identity: "sha256:cand123456789",
  upstream_label: "v4.0",
  files: [
    { path: "SKILL.md", change: "modified" },
    { path: "references/advanced.md", change: "added" },
    { path: "scripts/legacy.py", change: "removed" },
    { path: "references/basics.md", change: "modified" },
  ],
};

const statusNeverChecked: SourceUpdateStatus = {
  skill_id: "s1",
  state: null,
  checked_at: null,
  upstream_label: null,
  candidate_identity: null,
  ignored_candidates: [],
  candidate_ignored: false,
};

const statusIgnored: SourceUpdateStatus = {
  skill_id: "s1",
  state: "update_available",
  checked_at: "2026-10-04T08:00:00Z",
  upstream_label: "v4.0",
  candidate_identity: "sha256:cand123456789",
  ignored_candidates: ["sha256:cand123456789"],
  candidate_ignored: true,
};

const appliedTake: Awaited<ReturnType<SourceUpdateFacade["commitSourceUpdate"]>> = {
  skill_id: "s1",
  decision: "take_upstream",
  new_version: "v4",
  deployments_need_reconciliation: false,
};

function makeFacade(overrides: Partial<SourceUpdateFacade> = {}): SourceUpdateFacade {
  return {
    checkSourceUpdate: async () => checkResult,
    prepareSourceUpdate: async () => preview,
    commitSourceUpdate: async () => appliedTake,
    ignoreSourceUpdate: async () => undefined,
    getSourceUpdateStatus: async () => statusNeverChecked,
    ...overrides,
  };
}

async function renderPanel(
  facade: SourceUpdateFacade,
  buildClient?: () => QueryClient,
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = buildClient?.() ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <SourceUpdatePanel facade={facade} skillId="s1" />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

async function renderPanelWithBridge(
  facade: SourceUpdateFacade,
  tracker: OperationTracker = createOperationTracker(),
) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <AppNotificationsProvider>
            <SourceUpdatePanel facade={facade} skillId="s1" tracker={tracker} />
          </AppNotificationsProvider>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, tracker };
}

async function checkForUpdates(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "检查来源更新" }));
}

it("reports an up-to-date source honestly", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    checkSourceUpdate: async () => ({ ...checkResult, state: "up_to_date" }),
  }));

  await checkForUpdates(user);
  expect(await screen.findByText(/已是最新/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
});

it("offers the preview flow when an update is available", async () => {
  const user = userEvent.setup();
  const prepareSourceUpdate = vi.fn(async () => preview);
  const commitSourceUpdate = vi.fn(async () => appliedTake);
  await renderPanel(makeFacade({ prepareSourceUpdate, commitSourceUpdate }));

  await checkForUpdates(user);
  expect(await screen.findByText(/本地 v3/)).toBeVisible();
  expect(screen.getByText(/上游 v4\.0/)).toBeVisible();

  // 采纳入口先取得候选预览，让用户在确认前看到文件级变化。
  await user.click(screen.getByRole("button", { name: "采用上游版本" }));
  await waitFor(() => expect(prepareSourceUpdate).toHaveBeenCalledWith("s1"));
  expect(await screen.findByText("更新预览")).toBeVisible();
  // 文件级变更摘要分列呈现：新增 / 删除 / 修改。
  expect(screen.getByText(/新增/)).toHaveTextContent("1");
  expect(screen.getByText(/删除/)).toHaveTextContent("1");
  expect(screen.getByText(/修改/)).toHaveTextContent("2");
  expect(screen.getByText("references/advanced.md")).toBeVisible();
  expect(screen.getByText("scripts/legacy.py")).toBeVisible();
  // 候选身份与上游标签如实呈现（哈希只展示截短形态）。
  expect(screen.getByText(/sha256:cand1/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));
  await waitFor(() => expect(commitSourceUpdate).toHaveBeenCalledWith("preview-1", "take_upstream"));
  expect(await screen.findByText(/已采用上游版本/)).toBeVisible();
});

it("warns about local changes and refuses silent overwrite via take-upstream", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    checkSourceUpdate: async () => ({ ...checkResult, state: "update_available_with_local_changes" }),
  }));

  await checkForUpdates(user);
  expect(await screen.findByText(/本地有修改/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
  expect(screen.getByText(/覆盖这些修改/)).toBeVisible();
});

it("treats an up-to-date prepare rejection as an honest status, not an error", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    prepareSourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "source_up_to_date" },
        actions: [],
      };
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  expect(await screen.findByText(/已是最新/)).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("sends keep_local and cancel as explicit preview decisions", async () => {
  const user = userEvent.setup();
  const commitSourceUpdate = vi.fn(async (decision: "keep_local" | "cancel") => ({
    skill_id: "s1",
    decision,
    new_version: null,
    deployments_need_reconciliation: false,
  }));
  await renderPanel(makeFacade({ commitSourceUpdate }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");

  await user.click(screen.getByRole("button", { name: "保留本地版本" }));
  await waitFor(() => expect(commitSourceUpdate).toHaveBeenCalledWith("preview-1", "keep_local"));
  expect(await screen.findByText(/已保留本地版本/)).toBeVisible();
});

it("settles the preview as decided when the user cancels", async () => {
  const user = userEvent.setup();
  const commitSourceUpdate = vi.fn(async () => ({
    skill_id: "s1",
    decision: "cancel" as const,
    new_version: null,
    deployments_need_reconciliation: false,
  }));
  await renderPanel(makeFacade({ commitSourceUpdate }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");

  await user.click(screen.getByRole("button", { name: "取消本次更新" }));
  await waitFor(() => expect(commitSourceUpdate).toHaveBeenCalledWith("preview-1", "cancel"));
  expect(await screen.findByText(/已取消本次更新/)).toBeVisible();
});

it("offers no ignore and no command-sending dismissal when the candidate has no identity", async () => {
  const user = userEvent.setup();
  const ignoreSourceUpdate = vi.fn(async () => undefined);
  await renderPanel(makeFacade({
    checkSourceUpdate: async () => ({ ...checkResult, candidate_identity: null }),
    ignoreSourceUpdate,
  }));

  await checkForUpdates(user);
  expect(await screen.findByText(/本地 v3/)).toBeVisible();
  // 没有稳定候选身份就没有可持久化的忽略事实：不提供假的忽略入口。
  expect(screen.queryByRole("button", { name: "忽略本次更新" })).not.toBeInTheDocument();
  // 结果视图没有会发命令的“取消/关闭”——忽略是唯一持久化的放下方式。
  expect(screen.queryByRole("button", { name: /取消/ })).not.toBeInTheDocument();
  expect(ignoreSourceUpdate).not.toHaveBeenCalled();
});

it("ignores the current candidate without touching the main decisions", async () => {
  const user = userEvent.setup();
  const ignoreSourceUpdate = vi.fn(async () => undefined);
  let statusCalls = 0;
  await renderPanel(makeFacade({
    ignoreSourceUpdate,
    getSourceUpdateStatus: async () => {
      statusCalls += 1;
      // 首次是挂载读取；忽略成功触发缓存失效后的重读必须看到已忽略事实。
      return statusCalls >= 2 ? statusIgnored : statusNeverChecked;
    },
  }));

  await checkForUpdates(user);
  expect(await screen.findByText(/本地 v3/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "忽略本次更新" }));
  await waitFor(() =>
    expect(ignoreSourceUpdate).toHaveBeenCalledWith("s1", "sha256:cand123456789"),
  );
  // 忽略成功后状态刷新：该候选标记为已忽略，入口收起并如实呈现。
  expect(await screen.findByText(/已被忽略/)).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "忽略本次更新" })).not.toBeInTheDocument(),
  );
});

it("shows the persisted ignored state before any new check", async () => {
  await renderPanel(makeFacade({ getSourceUpdateStatus: async () => statusIgnored }));

  expect(await screen.findByText(/已被忽略/)).toBeVisible();
  expect(screen.queryByText(/发现更新/)).not.toBeInTheDocument();
});

it("keeps silence for a never-checked source instead of inventing a state", async () => {
  await renderPanel(makeFacade());

  await screen.findByRole("button", { name: "检查来源更新" });
  expect(screen.queryByText(/已被忽略/)).not.toBeInTheDocument();
  expect(screen.queryByText(/发现更新/)).not.toBeInTheDocument();
});

it("pulls the commit entries and offers re-preview when the preview expired", async () => {
  const user = userEvent.setup();
  const prepareSourceUpdate = vi.fn(async () => preview);
  await renderPanel(makeFacade({
    prepareSourceUpdate,
    commitSourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "source_update_preview_expired" },
        actions: [],
      };
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));

  // 预览已被结算：提交入口撤下，唯一出路是重新获取预览。
  expect(await screen.findByText(/预览已失效/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "确认采用上游版本" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保留本地版本" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重新获取预览" }));
  await waitFor(() => expect(prepareSourceUpdate).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("更新预览")).toBeVisible();
  expect(screen.getByRole("button", { name: "确认采用上游版本" })).toBeVisible();
});

it("treats changed facts like expiry: settle and re-preview", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    commitSourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "source_update_preview_facts_changed" },
        actions: [],
      };
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));

  expect(await screen.findByText(/预览已失效/)).toBeVisible();
  expect(screen.getByRole("button", { name: "重新获取预览" })).toBeVisible();
});

it("keeps the preview and allows a retry on other commit rejections", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  await renderPanel(makeFacade({
    commitSourceUpdate: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          code: "operation.conflict",
          severity: "error",
          params: { reason: "source_unavailable" },
          actions: [],
        };
      }
      return appliedTake;
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("来源暂不可用");
  // 预览保留：同一个 preview_id 可直接重试。
  expect(screen.getByRole("button", { name: "确认采用上游版本" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));
  expect(await screen.findByText(/已采用上游版本/)).toBeVisible();
});

it("states honestly when a skill has no upstream to check", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    checkSourceUpdate: async () => ({ ...checkResult, state: "no_upstream" }),
  }));

  await checkForUpdates(user);
  expect(await screen.findByText(/没有可检查更新的上游来源/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用上游版本" })).not.toBeInTheDocument();
});

it("renders a structured native error readably instead of [object Object]", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    prepareSourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "no_upstream_source" },
        actions: [],
      };
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("[object Object]");
  expect(alert.textContent).toContain("operation.conflict");
});

it("states unavailability instead of pretending a check succeeded", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    checkSourceUpdate: async () => ({ ...checkResult, state: "source_unavailable" }),
  }));

  await checkForUpdates(user);
  expect(await screen.findByText(/来源暂不可用/)).toBeVisible();
});

it("surfaces the reconciliation note when deployments need it", async () => {
  const user = userEvent.setup();
  await renderPanel(makeFacade({
    commitSourceUpdate: async () => ({
      skill_id: "s1",
      decision: "take_upstream",
      new_version: "v4",
      deployments_need_reconciliation: true,
    }),
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));
  expect(await screen.findByText(/重新同步/)).toBeVisible();
});

it("invalidates versions, summary, insights and source status after taking upstream", async () => {
  const user = userEvent.setup();
  const { client } = await renderPanel(makeFacade());
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));
  await screen.findByText(/已采用上游版本/);

  await waitFor(() => {
    const invalidated = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(skillDetailKeys.versions("s1")));
    expect(invalidated).toContain(JSON.stringify(skillDetailKeys.summary("s1")));
    expect(invalidated).toContain(JSON.stringify(skillDetailKeys.insights("s1")));
    expect(invalidated).toContain(JSON.stringify(skillDetailKeys.sourceUpdateStatus("s1")));
  });
});

it("refreshes only the source status for decisions that do not change content", async () => {
  const user = userEvent.setup();
  const { client } = await renderPanel(makeFacade({
    commitSourceUpdate: async () => ({
      skill_id: "s1",
      decision: "keep_local",
      new_version: null,
      deployments_need_reconciliation: false,
    }),
  }));
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "保留本地版本" }));
  await screen.findByText(/已保留本地版本/);

  await waitFor(() => {
    const invalidated = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(skillDetailKeys.sourceUpdateStatus("s1")));
  });
  const invalidated = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
  expect(invalidated).not.toContain(JSON.stringify(skillDetailKeys.versions("s1")));
});

it("refreshes the persisted status after each check", async () => {
  const user = userEvent.setup();
  const { client } = await renderPanel(makeFacade());
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");

  await checkForUpdates(user);
  await screen.findByText(/本地 v3/);

  await waitFor(() => {
    const invalidated = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidated).toContain(JSON.stringify(skillDetailKeys.sourceUpdateStatus("s1")));
  });
});

it("keeps applying an update in the tracked task list until it finishes", async () => {
  const user = userEvent.setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { tracker } = await renderPanelWithBridge(makeFacade({
    commitSourceUpdate: async () => {
      await gate;
      return appliedTake;
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));

  // 应用上游更新会重写受管副本：属于长流程，必须占用在途顶栏。
  await waitFor(() => expect(tracker.getSnapshot()).toHaveLength(1));
  expect(tracker.getSnapshot()[0]).toMatchObject({
    kind: "apply_source_update",
    label: "应用来源更新",
    status: "running",
  });

  release();
  await waitFor(() => expect(tracker.getSnapshot()[0].status).toBe("success"));
  expect(await screen.findByText(/已采用上游版本/)).toBeVisible();
});

it("reports a commit failure with the same readable reason as the page", async () => {
  const user = userEvent.setup();
  await renderPanelWithBridge(makeFacade({
    commitSourceUpdate: async () => {
      throw {
        code: "operation.conflict",
        severity: "error",
        params: { reason: "no_upstream_source" },
        actions: [],
      };
    },
  }));

  await checkForUpdates(user);
  await user.click(await screen.findByRole("button", { name: "采用上游版本" }));
  await screen.findByText("更新预览");
  await user.click(screen.getByRole("button", { name: "确认采用上游版本" }));

  const notice = await screen.findByTestId("notice-danger");
  expect(notice).toHaveTextContent("来源更新未能应用");
  const detail = notice.querySelector(".sh-notification__detail");
  expect(detail?.textContent).not.toContain("[object Object]");
  expect(detail?.textContent).toContain("没有可采用的 upstream 来源");
  const inlineAlert = (await screen.findAllByRole("alert")).find(
    (node) => node.tagName === "P",
  );
  expect(inlineAlert?.textContent).toContain("没有可采用的 upstream 来源");
});
