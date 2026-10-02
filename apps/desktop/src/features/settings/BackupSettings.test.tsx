import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import type { BackupFacade } from "../backup/api";
import { settingsFixture } from "./api";
import { BackupSettings } from "./BackupSettings";

async function renderBackup(resolveSkillName: (skillId: string) => Promise<string | null>) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = {
    prepareBackup: vi.fn(async () => ({
      scope: "full" as const,
      sensitive_items: [{ skill_id: "private-skill-id", reason: "文件中可能含有凭证" }],
    })),
    createBackup: vi.fn(async () => ({
      path: "C:/SkillHub/backups/latest.zip",
      manifest: { format_version: 1, entries: [], contains_sensitive_skill_content: false },
    })),
  } as unknown as BackupFacade;
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <BackupSettings facade={facade} resolveSkillName={resolveSkillName} settings={settingsFixture()} />
      </I18nextProvider>
    </MemoryRouter>,
  );
  return facade;
}

it("uses a readable skill name for a sensitive backup choice and keeps the ID internal", async () => {
  const user = userEvent.setup();
  const facade = await renderBackup(async () => "PDF helper");

  await user.click(screen.getByRole("button", { name: "检查备份" }));

  const decision = await screen.findByRole("combobox", { name: "敏感内容处理：PDF helper" });
  expect(screen.getByText("PDF helper 含有敏感内容")).toBeVisible();
  expect(document.body).not.toHaveTextContent("private-skill-id");
  expect(decision).toBeVisible();

  await user.selectOptions(decision, "exclude_skill");
  await user.click(screen.getByRole("button", { name: "创建备份" }));
  expect(facade.createBackup).toHaveBeenCalledWith("full", [
    { skill_id: "private-skill-id", decision: "exclude_skill" },
  ]);
});

it("uses an unnamed skill fallback when a readable name cannot be loaded", async () => {
  const user = userEvent.setup();
  await renderBackup(async () => {
    throw new Error("skill lookup failed");
  });

  await user.click(screen.getByRole("button", { name: "检查备份" }));

  expect(await screen.findByRole("combobox", { name: "敏感内容处理：未命名技能" })).toBeVisible();
  expect(document.body).not.toHaveTextContent("private-skill-id");
});
