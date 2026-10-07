import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { createOperationTracker, type OperationTracker } from "../../platform/operationTracker";
import { AppNotificationsProvider } from "../../ui/notifications";
import type { SkillMetadata } from "./api";
import { MetadataPanel } from "./MetadataPanel";
import { createMockSkillDetailFacade, detailFixture } from "./testFixtures";

async function renderMetadata({
  facade = createMockSkillDetailFacade(),
  metadata = detailFixture().metadata,
  refreshSnapshot,
  reviewPresentation = false,
  skillId = "skill-pdf",
}: {
  facade?: ReturnType<typeof createMockSkillDetailFacade>;
  metadata?: SkillMetadata;
  refreshSnapshot?: () => Promise<void>;
  reviewPresentation?: boolean;
  skillId?: string;
} = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const renderPanel = (currentMetadata: SkillMetadata) => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MetadataPanel
          facade={facade}
          metadata={currentMetadata}
          refreshSnapshot={refreshSnapshot}
          reviewPresentation={reviewPresentation}
          skillId={skillId}
        />
      </I18nextProvider>
    </QueryClientProvider>
  );
  const rendered = render(renderPanel(metadata));
  return {
    client,
    facade,
    rerenderMetadata: (nextMetadata: SkillMetadata, nextSkillId = skillId) => {
      rendered.rerender(
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={i18n}>
            <MetadataPanel
              facade={facade}
              metadata={nextMetadata}
              refreshSnapshot={refreshSnapshot}
              skillId={nextSkillId}
            />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    },
  };
}

async function renderMetadataWithBridge({
  facade = createMockSkillDetailFacade(),
  metadata = detailFixture().metadata,
  tracker = createOperationTracker(),
}: {
  facade?: ReturnType<typeof createMockSkillDetailFacade>;
  metadata?: SkillMetadata;
  tracker?: OperationTracker;
} = {}) {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <AppNotificationsProvider>
          <MetadataPanel
            facade={facade}
            metadata={metadata}
            skillId="skill-pdf"
            tracker={tracker}
          />
        </AppNotificationsProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { client, facade, tracker };
}

async function saveAlias(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "编辑别名" }));
  fireEvent.change(screen.getByRole("textbox", { name: "别名" }), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存别名" }));
}

describe("MetadataPanel", () => {
  it("keeps original description, saved translation and user purpose distinct", async () => {
    await renderMetadata();
    // P1-12：原文与译文收纳为次级展示。
    fireEvent.click(screen.getByText("原始文本与译文"));
    expect(screen.getByText("Original description")).toBeVisible();
    expect(screen.getByText("模型译文")).toBeVisible();
    // DEV-16：身份区必须显示别名与用途的读值，不进入编辑态也要可见
    // （同一份数据在所有视图的投影一致）。
    expect(screen.getByLabelText("别名")).toHaveTextContent("PDF 表格读取器");
    expect(screen.getByLabelText("我的用途说明")).toHaveTextContent("用于 PDF 表格提取");
    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("用于 PDF 表格提取");
  });

  it("shows source identity facts in the complete detail metadata", async () => {
    await renderMetadata();

    expect(screen.getByText("来源")).toBeVisible();
    expect(screen.getByText("github:example/pdf-reader")).toBeVisible();
    expect(screen.getByText("归属")).toBeVisible();
    expect(screen.getByText("managed")).toBeVisible();
    expect(screen.getByText("作者")).toBeVisible();
    expect(screen.getByText("Example Author")).toBeVisible();
    expect(screen.getByText("许可证")).toBeVisible();
    expect(screen.getByText("MIT")).toBeVisible();
    expect(screen.getByText("版权")).toBeVisible();
    expect(screen.getByText("Copyright 2026 Example Author")).toBeVisible();
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

  it("discards an edited field on Escape without writing the draft", async () => {
    const { facade } = await renderMetadata();
    const editButton = screen.getByRole("button", { name: "编辑我的用途说明" });
    fireEvent.click(editButton);
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    field.focus();
    fireEvent.change(field, { target: { value: "尚未保存的用途" } });

    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });

    expect(facade.calls.metadataPatches).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "我的用途说明" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("我的用途说明")).toHaveTextContent("用于 PDF 表格提取");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "编辑我的用途说明" }));
  });

  it("abandons the edit on Escape even when focus rests on the form action buttons", async () => {
    const { facade } = await renderMetadata();
    const editButton = screen.getByRole("button", { name: "编辑我的用途说明" });
    fireEvent.click(editButton);
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "焦点在按钮上的草稿" } });

    // 用户 Tab 到表单动作按钮（或点击后焦点停留在按钮）时按 Esc：
    // 语义仍是放弃本次编辑，不要求焦点必须回到输入框内。
    const cancelButton = screen.getByRole("button", { name: "取消" });
    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);
    fireEvent.keyDown(cancelButton, { key: "Escape", code: "Escape" });

    expect(facade.calls.metadataPatches).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "我的用途说明" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("我的用途说明")).toHaveTextContent("用于 PDF 表格提取");
    // 编辑态卸载重挂了编辑按钮，焦点应回到当前挂载的编辑触发器上。
    const restoredEditButton = screen.getByRole("button", { name: "编辑我的用途说明" });
    expect(document.activeElement).toBe(restoredEditButton);

    // 取消后的第二次 Esc 不得误触发提交或重新进入编辑。
    fireEvent.keyDown(restoredEditButton, { key: "Escape", code: "Escape" });
    expect(facade.calls.metadataPatches).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "我的用途说明" })).not.toBeInTheDocument();
  });

  it("closes the translation overwrite confirmation on Escape before touching the field edit", async () => {
    const facade = createMockSkillDetailFacade();
    await renderMetadata({
      facade,
      metadata: detailFixture({ userRevisedTranslation: true }).metadata,
    });
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "确认框打开时的字段草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();

    // 嵌套浮层在内：Esc 先收确认框，不穿透到字段的放弃编辑。
    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("确认框打开时的字段草稿");
    expect(facade.calls.intents).toEqual([]);
    expect(facade.calls.metadataPatches).toEqual([]);
  });

  it("closes the translation purpose dialog on Escape before touching the field edit", async () => {
    const facade = createMockSkillDetailFacade();
    facade.emitIntent = async () => ({ text: "用于读取 PDF 文本" });
    await renderMetadata({ facade });
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "译文确认框打开时的字段草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    expect(await screen.findByText("用于读取 PDF 文本")).toBeVisible();

    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });

    expect(screen.queryByText("用于读取 PDF 文本")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("译文确认框打开时的字段草稿");
    expect(facade.calls.metadataPatches).toEqual([]);
  });

  // W3-8 #6：评审态"重新翻译"与常规态共用真实 emitIntent 翻译契约；
  // 原型说明框（"此原型未配置 AI 服务"）移除，Esc 先收译文草稿浮层。
  it("runs the real retranslate flow from review presentation and keeps the field draft on Escape", async () => {
    const facade = createMockSkillDetailFacade();
    const original = facade.emitIntent.bind(facade);
    facade.emitIntent = async (intent) => {
      await original(intent);
      return { text: "用于读取 PDF 文本" };
    };
    await renderMetadata({ facade, reviewPresentation: true });
    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "预览浮层打开时的字段草稿" } });
    fireEvent.click(await screen.findByRole("button", { name: "重新翻译描述" }));
    expect(await screen.findByText("用于读取 PDF 文本")).toBeVisible();

    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });

    expect(screen.queryByText("用于读取 PDF 文本")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("预览浮层打开时的字段草稿");
    expect(facade.calls.metadataPatches).toEqual([]);
    expect(facade.calls.intents).toEqual([
      { locale: "zh-CN", overwriteUserRevision: false, skillId: "skill-pdf", type: "translate_description" },
    ]);
  });

  it("confirms overwriting a user-revised translation before retranslating in review presentation", async () => {
    const facade = createMockSkillDetailFacade();
    await renderMetadata({
      facade,
      metadata: detailFixture({ userRevisedTranslation: true }).metadata,
      reviewPresentation: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));

    // 需求 5.35：覆盖用户人工修订必须显式确认；确认前不发翻译命令。
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(screen.getByText("现有用户修订译文将被替换（zh-CN）。")).toBeVisible();
    expect(facade.calls.intents).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "替换译文" }));
    await waitFor(() => expect(facade.calls.intents).toEqual([
      { locale: "zh-CN", overwriteUserRevision: true, skillId: "skill-pdf", type: "translate_description" },
    ]));
  });

  it("keeps the draft on blur and restores the edit trigger after explicit cancel", async () => {
    const { facade } = await renderMetadata();
    const editButton = screen.getByRole("button", { name: "编辑我的用途说明" });
    fireEvent.click(editButton);
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "暂时离开字段" } });

    fireEvent.blur(field);

    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("暂时离开字段");
    expect(facade.calls.metadataPatches).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByLabelText("我的用途说明")).toHaveTextContent("用于 PDF 表格提取");
    expect(facade.calls.metadataPatches).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "编辑我的用途说明" }));
  });

  it("keeps a local draft during refresh and cancels back to the latest persisted value", async () => {
    const { facade, rerenderMetadata } = await renderMetadata();
    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    const field = screen.getByRole("textbox", { name: "我的用途说明" });
    fireEvent.change(field, { target: { value: "本地尚未保存的用途" } });

    rerenderMetadata({
      ...detailFixture().metadata,
      purpose: "另一处保存后的最新用途",
    });

    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("本地尚未保存的用途");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByLabelText("我的用途说明")).toHaveTextContent("另一处保存后的最新用途");
    expect(facade.calls.metadataPatches).toEqual([]);
  });

  it("discards an active field draft when the rendered Skill identity changes", async () => {
    const { facade, rerenderMetadata } = await renderMetadata();
    fireEvent.click(screen.getByRole("button", { name: "编辑别名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "别名" }), {
      target: { value: "主体 A 的未保存别名" },
    });

    rerenderMetadata({ ...detailFixture().metadata, alias: "主体 B 当前别名" }, "skill-docx");

    expect(screen.queryByRole("textbox", { name: "别名" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("别名")).toHaveTextContent("主体 B 当前别名");
    expect(facade.calls.metadataPatches).toEqual([]);
  });

  it("does not let a pending save callback from one Skill overwrite the next Skill panel", async () => {
    const facade = createMockSkillDetailFacade();
    let resolveSave: (() => void) | undefined;
    vi.spyOn(facade, "saveMetadata").mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    const { rerenderMetadata } = await renderMetadata({ facade });

    fireEvent.click(screen.getByRole("button", { name: "编辑别名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "别名" }), {
      target: { value: "主体 A 正在保存的别名" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存别名" }));

    await waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    rerenderMetadata({ ...detailFixture().metadata, alias: "主体 B 当前别名" }, "skill-docx");
    await act(async () => resolveSave?.());

    expect(screen.getByLabelText("别名")).toHaveTextContent("主体 B 当前别名");
    expect(screen.queryByText("主体 A 正在保存的别名")).not.toBeInTheDocument();
  });

  it("clears a translation overwrite confirmation when the Skill identity changes", async () => {
    const { rerenderMetadata } = await renderMetadata({
      metadata: detailFixture({ userRevisedTranslation: true }).metadata,
    });
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();

    rerenderMetadata(detailFixture().metadata, "skill-docx");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not show a late translation result from one Skill in the next Skill panel", async () => {
    const facade = createMockSkillDetailFacade();
    let resolveIntent: ((value: { text: string } | void) => void) | undefined;
    vi.spyOn(facade, "emitIntent").mockImplementation(() => new Promise((resolve) => {
      resolveIntent = resolve;
    }));
    const { rerenderMetadata } = await renderMetadata({ facade });
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    await waitFor(() => expect(resolveIntent).toBeTypeOf("function"));

    rerenderMetadata(detailFixture().metadata, "skill-docx");
    await act(async () => resolveIntent?.({ text: "主体 A 的旧译文" }));

    expect(screen.queryByText("主体 A 的旧译文")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
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
    });
    // DEV-16：保存后回到只读态时，身份区显示保存后的别名读值。
    expect(screen.getByLabelText("别名")).toHaveTextContent("PDF 助手");
    expect(screen.getByRole("button", { name: "编辑别名" })).toBeVisible();
  });

  it("explains comma-separated tags while editing", async () => {
    await renderMetadata();
    fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));

    expect(screen.getByText("多个标签请用逗号分隔")).toBeVisible();
  });

  it("normalizes Chinese and English commas and removes duplicate tags before saving", async () => {
    const { facade } = await renderMetadata();
    fireEvent.click(screen.getByRole("button", { name: "编辑标签" }));
    fireEvent.change(screen.getByRole("textbox", { name: "标签" }), {
      target: { value: "documents，pdf, documents , ,pdf" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));

    await waitFor(() => {
      expect(facade.calls.metadataPatches).toEqual([
        { patch: { tags: ["documents", "pdf"] }, skillId: "skill-pdf" },
      ]);
    });
  });

  it("refreshes the bootstrap snapshot after a successful metadata save", async () => {
    const refreshSnapshot = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await renderMetadata({ refreshSnapshot });

    await saveAlias("PDF 助手");

    await waitFor(() => expect(refreshSnapshot).toHaveBeenCalledTimes(1));
  });

  it("requires confirmation before replacing a user-revised translation", async () => {
    const facade = createMockSkillDetailFacade();
    await renderMetadata({
      facade,
      metadata: detailFixture({ userRevisedTranslation: true }).metadata,
    });
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    expect(screen.getByText(/现有用户修订译文将被替换/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(facade.calls.intents).toEqual([]);
    expect(screen.getByText("模型译文")).toBeVisible();
  });

  it("regenerates the translation only after the user confirms overwriting a revision", async () => {
    const facade = createMockSkillDetailFacade();
    await renderMetadata({
      facade,
      metadata: detailFixture({ userRevisedTranslation: true }).metadata,
    });
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    fireEvent.click(screen.getByRole("button", { name: "替换译文" }));
    await waitFor(() => {
      expect(facade.calls.intents).toEqual([
        {
          locale: "zh-CN",
          overwriteUserRevision: true,
          skillId: "skill-pdf",
          type: "translate_description",
        },
      ]);
    });
  });

  it("retranslates immediately when no user revision exists", async () => {
    const { facade } = await renderMetadata();
    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));
    await waitFor(() => {
      expect(facade.calls.intents).toEqual([
        {
          locale: "zh-CN",
          overwriteUserRevision: false,
          skillId: "skill-pdf",
          type: "translate_description",
        },
      ]);
    });
  });

  it("asks before copying a generated translation into my purpose", async () => {
    const facade = createMockSkillDetailFacade();
    facade.emitIntent = async () => ({ text: "用于读取 PDF 文本" });
    await renderMetadata({ facade });

    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));

    expect(await screen.findByText("用于读取 PDF 文本")).toBeVisible();
    expect(facade.calls.metadataPatches).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "将译文写入我的用途" }));
    await waitFor(() => {
      expect(facade.calls.metadataPatches).toContainEqual({
        patch: { purpose: "用于读取 PDF 文本" },
        skillId: "skill-pdf",
      });
    });
  });
});

describe("MetadataPanel 与统一执行桥", () => {
  it("reports a saved skill information section without opening a tracked task", async () => {
    const { facade, tracker } = await renderMetadataWithBridge();

    await saveAlias("PDF 助手");

    await waitFor(() => expect(facade.calls.metadataPatches).toHaveLength(1));
    // 保存是单次同步写入：只给结果反馈，不占用在途顶栏。
    expect(tracker.getSnapshot()).toEqual([]);
    const notice = await screen.findByTestId("notice-success");
    expect(notice).toHaveTextContent("Skill 信息已保存");
  });

  it("reports a failed save as a danger notice while the draft stays editable", async () => {
    const facade = createMockSkillDetailFacade({ failMetadataSave: true });
    const { tracker } = await renderMetadataWithBridge({ facade });

    fireEvent.click(screen.getByRole("button", { name: "编辑我的用途说明" }));
    fireEvent.change(screen.getByRole("textbox", { name: "我的用途说明" }), {
      target: { value: "新的本地用途" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存我的用途说明" }));

    const notice = await screen.findByTestId("notice-danger");
    expect(notice).toHaveTextContent("Skill 信息未能保存");
    expect(notice).toHaveTextContent("metadata save failed");
    expect(tracker.getSnapshot()).toEqual([]);
    // 失败后草稿不被清空：用户不必重敲一遍。
    expect(screen.getByRole("textbox", { name: "我的用途说明" })).toHaveValue("新的本地用途");
  });

  it("keeps a re-translation in the tracked task list until it finishes", async () => {
    const facade = createMockSkillDetailFacade();
    const translateDescription = facade.emitIntent.bind(facade);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    facade.emitIntent = async (intent) => {
      await gate;
      return translateDescription(intent);
    };
    const tracker = createOperationTracker();
    await renderMetadataWithBridge({ facade, tracker });

    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));

    // 重新翻译是 AI 长流程：这里必须占用在途顶栏，而不是静默地后台运行。
    await waitFor(() => expect(tracker.getSnapshot()).toHaveLength(1));
    expect(tracker.getSnapshot()[0]).toMatchObject({
      kind: "translate_description",
      label: "重新翻译描述",
      status: "running",
    });

    release();
    await waitFor(() => expect(tracker.getSnapshot()[0].status).toBe("success"));
    expect(tracker.getSnapshot()[0].finishedAt).not.toBeNull();
  });

  it("reports a structured translation failure readably instead of [object Object]", async () => {
    const facade = createMockSkillDetailFacade();
    facade.emitIntent = async () => {
      throw { code: "llm.not_configured", severity: "error", params: {}, actions: [] };
    };
    const tracker = createOperationTracker();
    await renderMetadataWithBridge({ facade, tracker });

    fireEvent.click(screen.getByText("原始文本与译文"));
    fireEvent.click(screen.getByRole("button", { name: "重新翻译描述" }));

    const notice = await screen.findByTestId("notice-danger");
    expect(notice).toHaveTextContent("翻译未能完成");
    const detail = notice.querySelector(".sh-notification__detail");
    expect(detail?.textContent).not.toContain("[object Object]");
    expect(detail?.textContent).toContain("尚未配置可用的 LLM 供应商");
    // 页面局部提示与通知的补充说明取自同一段描述，两处不互相矛盾。
    const inlineAlert = (await screen.findAllByRole("alert")).find(
      (node) => node.tagName === "P",
    );
    expect(inlineAlert?.textContent).toContain("尚未配置可用的 LLM 供应商");
    await waitFor(() => expect(tracker.getSnapshot()[0].status).toBe("failed"));
  });
});
