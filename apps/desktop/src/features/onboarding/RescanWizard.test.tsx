import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import onboardingCss from "./onboarding.css?raw";
import { RescanWizard } from "./RescanWizard";

it("shows the active library as read-only and never exposes activation controls", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const activateLibraryRoot = vi.fn();
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{
          completeOnboarding: async () => undefined,
          discoverAgents: async () => ({ targets: [] }),
          activateLibraryRoot,
        }}
        runtime={{
          getBootstrapView: async () => { throw new Error("unused"); },
          runInitializationScan: async () => ({
            kind: "completed",
            result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
          }),
        }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByRole("heading", { name: "重新发现 Agent 与 Skill" })).toBeVisible();
  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存并继续" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  expect(activateLibraryRoot).not.toHaveBeenCalled();
});

it("exposes the rediscovery step rail with named steps and the active step", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{ getBootstrapView: async () => { throw new Error("unused"); }, runInitializationScan: async () => { throw new Error("unused"); } }}
      />
    </I18nextProvider>,
  );

  const rail = screen.getByRole("list", { name: "重新发现步骤" });
  const steps = within(rail).getAllByRole("listitem");
  expect(steps).toHaveLength(3);
  expect(steps[0].textContent).toContain("重新发现 Agent 与 Skill");
  expect(steps[1].textContent).toContain("识别兼容的 Agent");
  expect(steps[2].textContent).toContain("扫描已有技能");
  expect(steps[0]).toHaveAttribute("aria-current", "step");

  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));

  const railAfter = screen.getByRole("list", { name: "重新发现步骤" });
  const stepsAfter = within(railAfter).getAllByRole("listitem");
  expect(stepsAfter[0].textContent).toContain("已完成");
  expect(stepsAfter[1]).toHaveAttribute("aria-current", "step");
});

it("supports cancel and complete callbacks without completing onboarding or activating a library", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const onComplete = vi.fn();
  const completeOnboarding = vi.fn(async () => undefined);
  const activateLibraryRoot = vi.fn(async () => undefined);

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        onCancel={onCancel}
        onComplete={onComplete}
        operations={{
          completeOnboarding,
          discoverAgents: async () => ({ targets: [] }),
          activateLibraryRoot,
        }}
        runtime={{
          getBootstrapView: async () => { throw new Error("unused"); },
          runInitializationScan: async () => ({
            kind: "completed",
            result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
          }),
        }}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("button", { name: "取消并返回设置" }));
  expect(onCancel).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "完成重新扫描" }));

  expect(onComplete).toHaveBeenCalledOnce();
  expect(completeOnboarding).not.toHaveBeenCalled();
  expect(activateLibraryRoot).not.toHaveBeenCalled();
});

it("keeps the rediscovery rescan and completion reachable in the sticky footer while results scroll internally", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const root = "C:\\Users\\Test\\.codex\\skills";

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        onComplete={() => undefined}
        operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{
          getBootstrapView: async () => { throw new Error("unused"); },
          runInitializationScan: async () => ({
            kind: "completed" as const,
            result: {
              generation: { generation: 1, observed_at: 1 },
              roots: [root],
              discovered: Array.from({ length: 60 }, (_, index) => ({
                root,
                relative_path: `preview-skill-${String(index + 1).padStart(2, "0")}`,
                path: `${root}\\preview-skill-${String(index + 1).padStart(2, "0")}`,
                marker: "SKILL.md",
                marker_size: 12,
                marker_modified_at: 1,
                size: 12,
                latest_modified_at: 1,
                fingerprint: `f-${index}`,
                metadata_fingerprint: `m-${index}`,
              })),
              visited_paths: [root],
              reparsed_count: 60,
              unchanged_count: 0,
              errors: [],
            },
          }),
        }}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));
  await user.click(screen.getByRole("button", { name: "继续" }));

  // M-25：扫描动作也在固定底部操作区，不再位于可滚动的扫描列表内部。
  const footer = document.querySelector("footer.sh-onboarding__actions");
  expect(footer).not.toBeNull();
  const footerElement = footer as HTMLElement;
  expect(within(footerElement).getByRole("button", { name: "开始只读扫描" })).toBeVisible();
  expect(within(footerElement).getByRole("button", { name: "完成重新扫描" })).toBeVisible();

  await user.click(within(footerElement).getByRole("button", { name: "开始只读扫描" }));
  expect(await screen.findByText("发现 60 个 Skill")).toBeVisible();

  // 扫描完成后：完成与重新扫描动作都固定在 footer，无需滚动到列表底部。
  expect(within(footerElement).getByRole("button", { name: "重新扫描" })).toBeVisible();
  const complete = within(footerElement).getByRole("button", { name: "完成重新扫描" });
  expect(complete).toBeVisible();

  // 结构性几何契约：完成动作在固定 footer 内、不被列表滚动带走；
  // footer 是 sticky 的；结果列表有独立滚动上限。
  const scrollOwner = document.querySelector(".sh-onboarding__scan-scroll");
  expect(scrollOwner).not.toBeNull();
  expect(scrollOwner!.contains(complete)).toBe(false);
  expect(onboardingCss).toMatch(/\.sh-onboarding \.sh-onboarding__actions\s*\{[^}]*position:\s*sticky/);
  expect(onboardingCss).toMatch(/\.sh-onboarding \.sh-onboarding__scan-scroll\s*\{[^}]*overflow(?:-y)?:\s*auto/);
  expect(onboardingCss).toMatch(/\.sh-onboarding \.sh-onboarding__scan-scroll\s*\{[^}]*max-height:/);
});

it("shows a discovery error and retries without clearing the current library state", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const discoverAgents = vi.fn()
    .mockRejectedValueOnce(new Error("Agent discovery failed"))
    .mockResolvedValueOnce({ targets: [] });

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{ completeOnboarding: async () => undefined, discoverAgents }}
        runtime={{ getBootstrapView: async () => { throw new Error("unused"); }, runInitializationScan: async () => { throw new Error("unused"); } }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));

  expect(await screen.findByText("Agent discovery failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(discoverAgents).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Agent discovery failed")).not.toBeInTheDocument();
  expect(screen.getByText("没有发现可选择的兼容性目标。")).toBeVisible();
});

it("shows a scan error and retries without changing the current library state", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const user = userEvent.setup();
  const runInitializationScan = vi.fn()
    .mockRejectedValueOnce(new Error("Scan failed"))
    .mockResolvedValueOnce({
      kind: "completed" as const,
      result: { generation: { generation: 1, observed_at: 1 }, roots: [], discovered: [], visited_paths: [], reparsed_count: 0, unchanged_count: 0, errors: [] },
    });

  render(
    <I18nextProvider i18n={i18n}>
      <RescanWizard
        libraryPath="C:\SkillHub"
        operations={{ completeOnboarding: async () => undefined, discoverAgents: async () => ({ targets: [] }) }}
        runtime={{ getBootstrapView: async () => { throw new Error("unused"); }, runInitializationScan }}
      />
    </I18nextProvider>,
  );

  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "识别 Agent" }));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await user.click(screen.getByRole("button", { name: "开始只读扫描" }));

  expect(await screen.findByText("Scan failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(runInitializationScan).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Scan failed")).not.toBeInTheDocument();
  expect(screen.getByText("C:\\SkillHub")).toBeVisible();
});
