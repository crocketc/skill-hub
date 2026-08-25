import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { createSkillHubI18n } from "../../i18n";
import { OnboardingWizard } from "./OnboardingWizard";

const defaultLibraryPath = "C:\\Users\\Test\\SkillHub\\skills";

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

it("allows skipping only after explicitly confirming the visible default library", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        defaultLibraryPath={defaultLibraryPath}
        operations={{ completeOnboarding, discoverAgents: async () => undefined }}
      />
    </I18nextProvider>,
  );

  expect(screen.getByText(defaultLibraryPath)).toBeVisible();
  await click(screen.getByRole("button", { name: "跳过初始化" }));
  expect(completeOnboarding).not.toHaveBeenCalled();
  expect(screen.getByText("将创建空集中库")).toBeVisible();

  await click(screen.getByRole("button", { name: "确认并跳过" }));
  expect(completeOnboarding).toHaveBeenCalledWith({
    libraryPath: defaultLibraryPath,
    skipped: true,
  });
});

it("keeps compatibility discovery opt-in and scan read-only while allowing back navigation", async () => {
  const discoverAgents = vi.fn(async () => undefined);
  const runInitializationScan = vi.fn(async () => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        defaultLibraryPath={defaultLibraryPath}
        operations={{ completeOnboarding: async () => undefined, discoverAgents }}
        runtime={{
          getBootstrapSnapshot: async () => {
            throw new Error("not used");
          },
          runInitializationScan,
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  expect(screen.getByRole("heading", { name: "识别兼容的 Agent" })).toBeVisible();
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(discoverAgents).not.toHaveBeenCalled();

  await click(screen.getByLabelText("我确认此步骤只识别，不会部署技能"));
  await click(screen.getByRole("button", { name: "识别 Agent" }));
  expect(discoverAgents).toHaveBeenCalledOnce();

  await click(screen.getByRole("button", { name: "继续" }));
  expect(screen.getByRole("heading", { name: "扫描已有技能" })).toBeVisible();
  expect(screen.getByText("扫描只生成预览，不会移动、导入或部署技能。"))
    .toBeVisible();
  await click(screen.getByRole("button", { name: "开始只读扫描" }));
  expect(runInitializationScan).toHaveBeenCalledWith([]);

  await click(screen.getByRole("button", { name: "上一步" }));
  expect(screen.getByRole("heading", { name: "识别兼容的 Agent" })).toBeVisible();
});

it("lets users finish without scanning", async () => {
  const completeOnboarding = vi.fn(async () => undefined);
  const runInitializationScan = vi.fn(async () => undefined);
  const i18n = await createSkillHubI18n(["zh-CN"]);

  render(
    <I18nextProvider i18n={i18n}>
      <OnboardingWizard
        defaultLibraryPath={defaultLibraryPath}
        operations={{ completeOnboarding, discoverAgents: async () => undefined }}
        runtime={{
          getBootstrapSnapshot: async () => {
            throw new Error("not used");
          },
          runInitializationScan,
        }}
      />
    </I18nextProvider>,
  );

  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "继续" }));
  await click(screen.getByRole("button", { name: "跳过扫描" }));

  expect(runInitializationScan).not.toHaveBeenCalled();
  expect(completeOnboarding).toHaveBeenCalledWith({
    libraryPath: defaultLibraryPath,
    skipped: false,
  });
});
