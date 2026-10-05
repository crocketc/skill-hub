import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type {
  DeploymentRecord,
  SaveAsCopyOutcome,
  SaveAsCopyReplacementPreview,
  SaveMarkdownAsCopy,
} from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { ThemeProvider } from "../../styles/ThemeProvider";
import type { MarkdownFacade } from "./api";
import { SaveAsCopyDialog } from "./SaveAsCopyDialog";
import { createMockMarkdownFacade } from "./testFixtures";

/**
 * K5/MS-06：另存副本统一对话框的契约测试。
 *
 * 覆盖/创建两分支：创建分支必须携带来源血缘（origin），继承选择在
 * 「不继承」与「替换继承（真实预览+逐项目标决定）」之间显式二选一；
 * 共享物理目标逐项显式确认；预览过期/漂移撤下提交入口引导重新预览；
 * 保存回执后定位新主体并如实呈现三态结果。
 */

/**
 * K5 后的 MarkdownFacade 形状（GREEN 前生产 facade 尚无这三个方法，
 * 测试用本地 mock 承载目标契约；类型经由本地接口描述，不依赖生产实现）。
 */
interface SaveAsCopyTestFacade {
  listDeployments(skillId: string): Promise<DeploymentRecord[]>;
  saveAsCopyReplacementPreview(
    skillId: string,
    targets: string[],
  ): Promise<SaveAsCopyReplacementPreview>;
  saveMarkdownAsCopy(request: SaveMarkdownAsCopy): Promise<SaveAsCopyOutcome>;
}

type MarkdownFacadeWithSaveAsCopy = MarkdownFacade & SaveAsCopyTestFacade;

const futureExpiry = new Date(Date.now() + 15 * 60_000).toISOString();
const pastExpiry = new Date(Date.now() - 60_000).toISOString();

const previewTargets: SaveAsCopyReplacementPreview["targets"] = [
  {
    blocker: null,
    consumer_deployment_ids: ["dep-1"],
    deployment_id: "dep-1",
    managed: true,
    path: "C:/Agents/Codex/skills/pdf-reader",
    requires_shared_target_confirmation: false,
    runtime_name: "pdf-reader",
    target_id: "tgt-1",
    version_id: "ver-target-1",
  },
  {
    blocker: null,
    consumer_deployment_ids: ["dep-2", "dep-3"],
    deployment_id: "dep-2",
    managed: true,
    path: "C:/Shared/agents/skills/pdf-reader",
    requires_shared_target_confirmation: true,
    runtime_name: "pdf-reader",
    target_id: "tgt-2",
    version_id: "ver-target-2",
  },
];

function makePreview(
  overrides: Partial<SaveAsCopyReplacementPreview> = {},
): SaveAsCopyReplacementPreview {
  return {
    confirmation_fingerprint: "fp-20261004",
    expires_at: futureExpiry,
    preview_id: "preview-1",
    source_skill_id: "pdf-reader",
    source_version_id: "v1",
    targets: previewTargets,
    ...overrides,
  };
}

export const copyOutcome: SaveAsCopyOutcome = {
  content_identity: "sha256:copy-content",
  display_name: "PDF Reader copy",
  inheritance: "NotRequested",
  lineage_registered: true,
  path: "C:/Library/skills/pdf-reader-copy/SKILL.md",
  recovery_operation_id: null,
  skill_id: "skill-copy",
  version_id: "ver-copy-1",
};

function createDialogFacade(
  options: {
    deployments?: DeploymentRecord[];
    preview?: SaveAsCopyReplacementPreview;
    previewError?: unknown;
    saveOutcome?: SaveAsCopyOutcome;
    saveError?: unknown;
  } = {},
): MarkdownFacadeWithSaveAsCopy & {
  copyRequests: SaveMarkdownAsCopy[];
  previewCalls: Array<{ skillId: string; targets: string[] }>;
} {
  const base = createMockMarkdownFacade();
  const copyRequests: SaveMarkdownAsCopy[] = [];
  const previewCalls: Array<{ skillId: string; targets: string[] }> = [];
  const deployments: DeploymentRecord[] = options.deployments ?? [
    {
      expected_hash: "hash-1",
      id: "dep-1",
      managed: true,
      mode: "managed_copy",
      observed_hash: "hash-1",
      runtime_name: "pdf-reader",
      skill_id: "pdf-reader",
      state: "deployed",
      target_id: "tgt-1",
      version_id: "v1",
    },
    {
      expected_hash: "hash-2",
      id: "dep-2",
      managed: true,
      mode: "symbolic_link",
      observed_hash: null,
      runtime_name: "pdf-reader",
      skill_id: "pdf-reader",
      state: "deployed",
      target_id: "tgt-2",
      version_id: "v1",
    },
    {
      expected_hash: "hash-3",
      id: "dep-gone",
      managed: true,
      mode: "managed_copy",
      observed_hash: null,
      runtime_name: "pdf-reader",
      skill_id: "pdf-reader",
      state: "removed",
      target_id: "tgt-gone",
      version_id: "v1",
    },
  ];
  const facade = {
    ...base,
    async listDeployments(skillId: string) {
      return deployments.filter((deployment) => deployment.skill_id === skillId);
    },
    async saveAsCopyReplacementPreview(skillId: string, targets: string[]) {
      previewCalls.push({ skillId, targets });
      if (options.previewError) throw options.previewError;
      return options.preview ?? makePreview();
    },
    async saveMarkdownAsCopy(request: SaveMarkdownAsCopy) {
      copyRequests.push(request);
      if (options.saveError) throw options.saveError;
      return options.saveOutcome ?? copyOutcome;
    },
  };
  return { ...facade, copyRequests, previewCalls };
}

function DialogHarness({
  facade,
  onSaved,
  sourceVersionId = "v1",
}: {
  facade: MarkdownFacadeWithSaveAsCopy;
  onSaved?: (outcome: SaveAsCopyOutcome) => void;
  sourceVersionId?: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <SaveAsCopyDialog
      expectedIdentity="sha256:skill-md-v1"
      facade={facade}
      markdown="# Copy body"
      onOpenChange={setOpen}
      onSaved={onSaved ?? (() => undefined)}
      open={open}
      path="SKILL.md"
      skillId="pdf-reader"
      sourceVersionId={sourceVersionId}
    />
  );
}

async function renderDialog(
  facadeOptions: Parameters<typeof createDialogFacade>[0] = {},
  harness: { onSaved?: (outcome: SaveAsCopyOutcome) => void; sourceVersionId?: string | null } = {},
) {
  const facade = createDialogFacade(facadeOptions);
  const i18n = await createSkillHubI18n(["en-US"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={["/library/pdf-reader"]}>
            <Routes>
              <Route element={<div>new skill detail page</div>} path="/library/:skillId" />
              <Route element={<div>recovery page</div>} path="/recovery" />
              <Route
                element={
                  <DialogHarness
                    facade={facade}
                    onSaved={harness.onSaved}
                    sourceVersionId={harness.sourceVersionId}
                  />
                }
                path="*"
              />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return facade;
}

async function chooseReplaceAndPreview(facade: ReturnType<typeof createDialogFacade>) {
  const user = userEvent.setup();
  const dialog = screen.getByRole("dialog");
  await user.click(
    within(dialog).getByRole("radio", { name: "Take over selected usage locations" }),
  );
  await within(dialog).findByRole("checkbox", {
    name: /C:\/Agents\/Codex\/skills\/pdf-reader/,
  });
  await user.click(within(dialog).getByRole("button", { name: "Preview takeover" }));
  await within(dialog).findByText("C:/Agents/Codex/skills/pdf-reader");
  return { dialog, user };
}

describe("SaveAsCopyDialog", () => {
  it("defaults to no inheritance and saves a copy carrying source lineage, then locates the new skill", async () => {
    const onSaved = vi.fn();
    const facade = await renderDialog({}, { onSaved });
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog");

    // 不继承是默认分支：直接提交也不得静默接管任何使用位置。
    expect(
      within(dialog).getByRole("radio", { name: "Do not inherit usage locations" }),
    ).toBeChecked();

    await user.click(within(dialog).getByRole("button", { name: "Create the new skill" }));

    await waitFor(() => expect(facade.copyRequests).toHaveLength(1));
    expect(facade.copyRequests[0]).toMatchObject({
      expected_identity: "sha256:skill-md-v1",
      inheritance: "None",
      markdown: "# Copy body",
      origin: { source_skill_id: "pdf-reader", source_version_id: "v1" },
      path: "SKILL.md",
      skill_id: "pdf-reader",
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(copyOutcome));

    // 保存回执后定位新主体：结果步明确呈现，再经「打开新 Skill」导航定位。
    expect(await within(dialog).findByText(/PDF Reader copy/)).toBeVisible();
    expect(within(dialog).getByText(/lineage: recorded/i)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Open the new skill" }));
    await screen.findByText("new skill detail page");
    expect(facade.previewCalls).toHaveLength(0);
  });

  it("previews selected deployments and renders per-target facts before submission", async () => {
    const facade = await renderDialog();
    const { dialog } = await chooseReplaceAndPreview(facade);

    expect(facade.previewCalls).toEqual([
      { skillId: "pdf-reader", targets: ["dep-1", "dep-2"] },
    ]);
    // 逐目标事实如实分列：path、runtime 名、受管事实、消费者数、可核验版本。
    expect(within(dialog).getByText("C:/Agents/Codex/skills/pdf-reader")).toBeVisible();
    expect(within(dialog).getByText("C:/Shared/agents/skills/pdf-reader")).toBeVisible();
    expect(within(dialog).getByText("ver-target-1")).toBeVisible();
    expect(within(dialog).getByTestId("copy-target-consumers-dep-2")).toHaveTextContent("2");
  });

  it("requires explicit per-target confirmation for shared physical targets before submit", async () => {
    const facade = await renderDialog();
    const { dialog, user } = await chooseReplaceAndPreview(facade);

    const submit = within(dialog).getByRole("button", { name: "Create the new skill" });
    // 共享物理目标接管必须逐项显式确认；未确认前绝不放行提交。
    expect(submit).toBeDisabled();

    await user.click(
      within(dialog).getByRole("checkbox", { name: /Shared physical target/i }),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(facade.copyRequests).toHaveLength(1));
    expect(facade.copyRequests[0].inheritance).toEqual({
      ReplaceTargets: {
        preview_id: "preview-1",
        targets: [
          { confirm_shared_target_removal: false, deployment_id: "dep-1" },
          { confirm_shared_target_removal: true, deployment_id: "dep-2" },
        ],
      },
    });
  });

  it("presents unverifiable targets honestly and never fabricates a version", async () => {
    const blockedPreview = makePreview({
      targets: [
        {
          ...previewTargets[0],
        },
        {
          blocker: "target_owner_mismatch",
          consumer_deployment_ids: ["dep-2"],
          deployment_id: "dep-2",
          managed: false,
          path: "C:/Other/skills/pdf-reader",
          requires_shared_target_confirmation: false,
          runtime_name: "pdf-reader",
          target_id: "tgt-2",
          version_id: null,
        },
      ],
    });
    const facade = await renderDialog({ preview: blockedPreview });
    const { dialog, user } = await chooseReplaceAndPreview(facade);

    // blocker 如实分列；version_id 为 null 时绝不伪造版本号。
    const blockedRow = within(dialog).getByTestId("copy-target-dep-2");
    expect(blockedRow).toHaveTextContent(/owned by another skill/i);
    expect(blockedRow).not.toHaveTextContent("ver-target");
    // 不可核验目标不得进入提交。
    expect(
      within(blockedRow).getByRole("checkbox", { name: /C:\/Other\/skills\/pdf-reader/ }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Create the new skill" }));
    await waitFor(() => expect(facade.copyRequests).toHaveLength(1));
    expect(facade.copyRequests[0].inheritance).toEqual({
      ReplaceTargets: {
        preview_id: "preview-1",
        targets: [{ confirm_shared_target_removal: false, deployment_id: "dep-1" }],
      },
    });
  });

  it("withdraws submission and guides a fresh preview after the preview expires", async () => {
    const facade = await renderDialog({ preview: makePreview({ expires_at: pastExpiry }) });
    await chooseReplaceAndPreview(facade);
    const dialog = screen.getByRole("dialog");

    // 预览过期：提交入口撤下，唯一出路是重新预览。
    expect(
      screen.queryByRole("button", { name: "Create the new skill" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText(/preview has expired/i)).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose targets again" }));
    await waitFor(() => expect(facade.previewCalls).toHaveLength(2));
  });

  it("returns to a fresh preview when the backend rejects a drifted submission", async () => {
    const facade = await renderDialog({
      saveError: { actions: [], code: "operation.conflict", params: {}, severity: "conflict" },
    });
    const { dialog, user } = await chooseReplaceAndPreview(facade);

    await user.click(within(dialog).getByRole("button", { name: "Create the new skill" }));

    // 指纹/漂移拒绝：撤下提交入口，引导重新预览；旧预览不再可用。
    expect(await within(dialog).findByText(/changed after the preview/i)).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "Create the new skill" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Choose targets again" })).toBeEnabled();
  });

  it("retries the same unconsumed preview when a rejection leaves it valid", async () => {
    const facade = await renderDialog({
      saveError: {
        actions: [],
        code: "deployment.target_changed",
        params: {},
        severity: "conflict",
      },
    });
    const { dialog, user } = await chooseReplaceAndPreview(facade);

    await user.click(within(dialog).getByRole("button", { name: "Create the new skill" }));

    // 预览未被消费：稳定错误码可见，允许补齐确认后用同一 preview_id 重试。
    expect(
      await within(dialog).findByText(/deployment\.target_changed/),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: /Retry with this preview/i })).toBeEnabled();

    await user.click(within(dialog).getByRole("checkbox", { name: /Shared physical target/i }));
    await user.click(within(dialog).getByRole("button", { name: /Retry with this preview/i }));

    await waitFor(() => expect(facade.copyRequests).toHaveLength(2));
    expect(facade.previewCalls).toHaveLength(1);
    expect(facade.copyRequests[1].inheritance).toEqual({
      ReplaceTargets: {
        preview_id: "preview-1",
        targets: [
          { confirm_shared_target_removal: false, deployment_id: "dep-1" },
          { confirm_shared_target_removal: true, deployment_id: "dep-2" },
        ],
      },
    });
  });

  it("presents partial replacement per target with a recovery deep link and no full-success claim", async () => {
    const partialOutcome: SaveAsCopyOutcome = {
      ...copyOutcome,
      inheritance: {
        PartiallyReplaced: {
          items: [
            {
              consumer_deployment_ids: ["dep-1"],
              deployment_id: "dep-1",
              error_code: null,
              path: "C:/Agents/Codex/skills/pdf-reader",
              runtime_name: "pdf-reader",
              status: "applied",
              target_id: "tgt-1",
            },
            {
              consumer_deployment_ids: [],
              deployment_id: "dep-2",
              error_code: "deployment.target_changed",
              path: "C:/Shared/agents/skills/pdf-reader",
              runtime_name: "pdf-reader",
              status: "failed",
              target_id: "tgt-2",
            },
          ],
        },
      },
      recovery_operation_id: "op-recovery-1",
    };
    const facade = await renderDialog({ saveOutcome: partialOutcome });
    const { dialog, user } = await chooseReplaceAndPreview(facade);
    await user.click(within(dialog).getByRole("checkbox", { name: /Shared physical target/i }));
    await user.click(within(dialog).getByRole("button", { name: "Create the new skill" }));

    // 逐项三态：成功项保留、失败项带稳定错误码与恢复依据；绝不宣称全部完成。
    await within(dialog).findByText(/Part of the selected usage locations/i);
    expect(within(dialog).getByTestId("copy-result-dep-1")).toHaveTextContent(/Taken over/);
    const failedRow = within(dialog).getByTestId("copy-result-dep-2");
    expect(failedRow).toHaveTextContent(/Failed/);
    expect(failedRow).toHaveTextContent("deployment.target_changed");
    expect(
      within(dialog).queryByText(/all .*usage locations/i),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /Open recovery options/i }),
    ).toHaveAttribute("href", "/recovery?operationId=op-recovery-1");
  });

  it("reports missing lineage honestly when the source version is unknown", async () => {
    const facade = await renderDialog({}, { sourceVersionId: null });
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Create the new skill" }));

    await waitFor(() => expect(facade.copyRequests).toHaveLength(1));
    // 来源版本身份未知：不登记血缘（缺省=保留旧行为），绝不伪造来源事实。
    expect(facade.copyRequests[0].origin).toBeUndefined();
    expect(await within(dialog).findByText(/lineage: not recorded/i)).toBeVisible();
  });

  it("never frames the copy as an independent branch", async () => {
    await renderDialog();
    const dialog = screen.getByRole("dialog");
    // MS-06：伪独立分支语义被移除；对话框以来源血缘+可选接管呈现。
    expect(dialog.textContent).not.toMatch(/independent|separate copy|独立/i);
    expect(within(dialog).getByText(/reuse-modify source/i)).toBeVisible();
  });
});
