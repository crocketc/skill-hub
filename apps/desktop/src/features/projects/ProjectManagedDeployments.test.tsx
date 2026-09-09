import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
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
    fireEvent.click(screen.getByRole("button", { name: "解除管理" }));
    expect(ops.detach).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认解除管理" }));
    await waitFor(() => expect(ops.detach).toHaveBeenCalledWith("dep-1"));
    expect(await screen.findByText(/已解除管理/)).toBeVisible();
    // The list reloads; the detached copy no longer appears as managed.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "解除管理" })).not.toBeInTheDocument(),
    );
    expect(ops.list).toHaveBeenCalledTimes(2);
  });

  it("surfaces failures with the stable error code instead of faking success", async () => {
    const ops = createOps({
      detach: vi.fn().mockRejectedValue("removal.detach_management_failed"),
    });
    await renderSection(ops);
    await screen.findByText(/skill-pdf/);
    fireEvent.click(screen.getByRole("button", { name: "解除管理" }));
    fireEvent.click(screen.getByRole("button", { name: "确认解除管理" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/removal\.detach_management_failed/);
  });

  it("shows an unavailable state when records cannot be read", async () => {
    const ops = createOps({ list: vi.fn().mockRejectedValue(new Error("boom")) });
    await renderSection(ops);
    expect(await screen.findByText("无法读取部署记录。")).toBeVisible();
  });
});
