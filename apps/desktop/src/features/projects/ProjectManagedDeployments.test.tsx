import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import type { DeploymentRecord } from "../../api/bindings";
import {
  ProjectManagedDeployments,
  type ProjectManagedDeploymentsOps,
} from "./ProjectManagedDeployments";

const record = (overrides: Partial<DeploymentRecord>): DeploymentRecord => ({
  expected_hash: "sha256:a",
  id: "dep-1",
  managed: true,
  mode: "symbolic_link",
  observed_hash: null,
  runtime_name: "pdf-reader",
  skill_id: "skill-pdf",
  state: "deployed",
  target_id: "demo-project",
  version_id: "ver-1",
  ...overrides,
});

const baseRecords: DeploymentRecord[] = [
  record({}),
  record({ id: "dep-other", skill_id: "skill-notes", target_id: "another-project" }),
  record({ id: "dep-unmanaged", managed: false }),
];

function createOps(overrides: Partial<ProjectManagedDeploymentsOps> = {}) {
  return {
    list: vi.fn().mockResolvedValue(baseRecords),
    detach: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function renderSection(ops: ProjectManagedDeploymentsOps, projectId = "demo-project") {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const result = render(
    <I18nextProvider i18n={i18n}>
      <ProjectManagedDeployments ops={ops} projectId={projectId} />
    </I18nextProvider>,
  );
  return result;
}

describe("ProjectManagedDeployments", () => {
  it("lists only managed deployment records of this project", async () => {
    const ops = createOps();
    await renderSection(ops);
    expect(await screen.findByText(/skill-pdf/)).toBeVisible();
    expect(screen.queryByText(/skill-notes/)).not.toBeInTheDocument();
    expect(ops.list).toHaveBeenCalledTimes(1);
  });

  it("shows an honest empty state when the project has no managed copies", async () => {
    const ops = createOps({ list: vi.fn().mockResolvedValue([record({ managed: false })]) });
    await renderSection(ops);
    expect(await screen.findByText("本项目目录没有受管的 Skill 副本。")).toBeVisible();
  });

  it("detaches management only after an explicit confirmation", async () => {
    // The mock models the real contract: after detach the record reloads as
    // unmanaged, so it disappears from this section.
    let detached = false;
    const ops = createOps({
      list: vi.fn().mockImplementation(() =>
        Promise.resolve(
          detached ? baseRecords.map((entry) => entry.id === "dep-1" ? { ...entry, managed: false } : entry) : baseRecords,
        ),
      ),
      detach: vi.fn().mockImplementation(() => {
        detached = true;
        return Promise.resolve(undefined);
      }),
    });
    await renderSection(ops);
    await screen.findByText(/skill-pdf/);
    fireEvent.click(screen.getByRole("button", { name: "移除部署关系" }));
    expect(ops.detach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认移除部署关系" }));
    await waitFor(() => expect(ops.detach).toHaveBeenCalledWith("dep-1"));
    expect(await screen.findByText(/已移除部署关系/)).toBeVisible();
    // The list reloads; the detached copy no longer appears as managed.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "移除部署关系" })).not.toBeInTheDocument(),
    );
    expect(ops.list).toHaveBeenCalledTimes(2);
  });

  it("surfaces failures with the stable error code instead of faking success", async () => {
    const ops = createOps({
      detach: vi.fn().mockRejectedValue("removal.detach_management_failed"),
    });
    await renderSection(ops);
    await screen.findByText(/skill-pdf/);
    fireEvent.click(screen.getByRole("button", { name: "移除部署关系" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除部署关系" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/removal\.detach_management_failed/);
  });

  it("shows an unavailable state when records cannot be read", async () => {
    const ops = createOps({ list: vi.fn().mockRejectedValue(new Error("boom")) });
    await renderSection(ops);
    expect(await screen.findByText("无法读取受管副本记录。")).toBeVisible();
  });
});

it("offers a governance deep link per managed copy when a builder is provided", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <ProjectManagedDeployments
          governanceHref={(record) =>
            `/relationships/governance?from=project&project=demo-project&skillId=${record.skill_id}`}
          ops={createOps()}
          projectId="demo-project"
        />
      </I18nextProvider>
    </MemoryRouter>,
  );

  await screen.findByText(/skill-pdf/);
  const link = screen.getByTestId("governance-link");
  expect(link.textContent).toBe("管理关系");
  expect(link.getAttribute("href")).toBe(
    "/relationships/governance?from=project&project=demo-project&skillId=skill-pdf",
  );
});

async function renderWithBridge(ops: ProjectManagedDeploymentsOps) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const tracker = createOperationTracker();
  render(
    <I18nextProvider i18n={i18n}>
      <AppNotificationsProvider>
        <ProjectManagedDeployments ops={ops} projectId="demo-project" tracker={tracker} />
      </AppNotificationsProvider>
    </I18nextProvider>,
  );
  await screen.findByText(/skill-pdf/);
  return { tracker };
}

async function confirmDetach() {
  fireEvent.click(screen.getByRole("button", { name: "移除部署关系" }));
  fireEvent.click(screen.getByRole("button", { name: "确认移除部署关系" }));
}

describe("ProjectManagedDeployments 与统一执行桥", () => {
  it("reports a successful detach as one notice and never fakes a top-bar task", async () => {
    const ops = createOps();
    const { tracker } = await renderWithBridge(ops);
    await confirmDetach();

    await waitFor(() => expect(ops.detach).toHaveBeenCalledWith("dep-1"));
    // `detach_management` 是单次同步写入：只给结果反馈，不占用在途顶栏。
    expect(tracker.getSnapshot()).toEqual([]);
    const notice = await screen.findByTestId("notice-success");
    expect(notice).toHaveTextContent("已移除部署关系");
    expect(notice).toHaveTextContent("已移除部署关系：skill-pdf。");
  });

  it("reports a detach failure as a danger notice, not only as inline text", async () => {
    const ops = createOps({
      detach: vi.fn().mockRejectedValue("removal.detach_management_failed"),
    });
    await renderWithBridge(ops);
    await confirmDetach();

    const notice = await screen.findByTestId("notice-danger");
    expect(notice).toHaveTextContent("移除部署关系失败");
    expect(notice).toHaveTextContent("removal.detach_management_failed");
    // 页面局部文案保留，失败原因不被通知替换掉。
    const inlineAlert = (await screen.findAllByRole("alert")).find(
      (node) => node.tagName === "P",
    );
    expect(inlineAlert).toHaveTextContent(/removal\.detach_management_failed/);
  });
});
