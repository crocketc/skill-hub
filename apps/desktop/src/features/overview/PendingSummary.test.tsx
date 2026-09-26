import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { PendingSummary } from "./PendingSummary";

it("counts the unified sources instead of the obsolete bootstrap pending count and refreshes", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = { list: vi.fn().mockResolvedValueOnce([
    { id: "conflict:1", kind: "conflict" }, { id: "governance:2", kind: "governance" },
  ]).mockResolvedValue([]) };
  render(<MemoryRouter><I18nextProvider i18n={i18n}><PendingSummary snapshot={{ pending: { total: 99 } } as never} facade={facade} /></I18nextProvider></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "1 组技能冲突" })).toBeVisible();
  expect(screen.getByRole("link", { name: "1 组技能冲突" })).toHaveAttribute("href", "/pending?kind=conflict");
  expect(screen.getByRole("link", { name: "1 条关系待治理" })).toBeVisible();
  expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  fireEvent(window, new Event("focus"));
  expect(await screen.findByRole("heading", { name: "没有待处理事项" })).toBeVisible();
});

it("shows source failure with retry instead of an empty summary", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const facade = { list: vi.fn().mockRejectedValue(new Error("offline")) };
  render(<MemoryRouter><I18nextProvider i18n={i18n}><PendingSummary snapshot={{} as never} facade={facade} /></I18nextProvider></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("待办来源未能完整读取");
  expect(screen.queryByText("没有待处理事项")).not.toBeInTheDocument();
});
