import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { MetadataPanel } from "./MetadataPanel";
import { createMockSkillDetailFacade, detailFixture } from "./testFixtures";

async function renderMetadata({
  facade = createMockSkillDetailFacade(),
  metadata = detailFixture().metadata,
} = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MetadataPanel facade={facade} metadata={metadata} skillId="skill-pdf" />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { client, facade };
}

describe("MetadataPanel", () => {
  it("keeps original description, saved translation and user purpose distinct", async () => {
    await renderMetadata();
    expect(screen.getByText("Original description")).toBeVisible();
    expect(screen.getByText("模型译文")).toBeVisible();
    expect(screen.getByLabelText("我的用途说明")).toHaveTextContent("用于 PDF 表格提取");
  });

  it("keeps a failed purpose draft without putting unrelated sections in edit mode", async () => {
    const facade = createMockSkillDetailFacade({ failMetadataSave: true });
    await renderMetadata({ facade });
    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "新的本地用途" } });
    fireEvent.click(screen.getByRole("button", { name: "保存我的用途说明" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未能保存");
    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("新的本地用途");
    expect(screen.queryByRole("textbox", { name: "我的备注" })).not.toBeInTheDocument();
  });

  it("saves one section without rewriting the others", async () => {
    const { facade } = await renderMetadata();
    fireEvent.click(screen.getByRole("button", { name: "编辑别名" }));
    const field = screen.getByRole("textbox", { name: "别名" });
    fireEvent.change(field, { target: { value: "PDF 助手" } });
    fireEvent.click(screen.getByRole("button", { name: "保存别名" }));
    await waitFor(() => {
      expect(facade.calls.metadataPatches).toEqual([
        { patch: { alias: "PDF 助手" }, skillId: "skill-pdf" },
      ]);
      expect(screen.getByLabelText("别名")).toHaveTextContent("PDF 助手");
    });
  });

  it("explains comma-separated tags while editing", async () => {
    await renderMetadata();
    fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));

    expect(screen.getByText("多个标签请用逗号分隔")).toBeVisible();
  });

  it("requires confirmation before replacing a user-revised translation", async () => {
    const facade = createMockSkillDetailFacade();
    await renderMetadata({
      facade,
      metadata: detailFixture({ userRevisedTranslation: true }).metadata,
    });
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    expect(screen.getByText(/现有用户修订译文将被替换/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(facade.calls.intents).toEqual([]);
    expect(screen.getByText("模型译文")).toBeVisible();
  });
});
