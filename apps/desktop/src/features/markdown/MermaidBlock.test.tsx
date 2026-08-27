import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubI18n } from "../../i18n";
import { MermaidBlock } from "./MermaidBlock";

const runtime = vi.hoisted(() => ({ renderMermaidSvg: vi.fn() }));
vi.mock("./mermaidRuntime", () => runtime);

async function renderBlock(code = "graph TD; A-->B") {
  const i18n = await createSkillHubI18n(["en-US"]);
  const onExternalTarget = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <MermaidBlock code={code} onExternalTarget={onExternalTarget} />
    </I18nextProvider>,
  );
  return onExternalTarget;
}

describe("MermaidBlock", () => {
  it("shows source without invoking the renderer after the user selects source", async () => {
    runtime.renderMermaidSvg.mockReturnValue(new Promise(() => undefined));
    await renderBlock();

    fireEvent.click(screen.getByRole("tab", { name: "Source" }));

    expect(screen.getByText("graph TD; A-->B", { exact: false })).toBeVisible();
  });

  it("falls back to source without discarding code when strict rendering fails", async () => {
    runtime.renderMermaidSvg.mockRejectedValueOnce(new Error("invalid graph"));
    await renderBlock("graph TD; broken[");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Diagram unavailable; showing Mermaid source.",
    );
    expect(screen.getByText("graph TD; broken[", { exact: false })).toBeVisible();
  });

  it("intercepts external SVG anchors instead of navigating inside the app", async () => {
    let resolveSvg!: (svg: string) => void;
    runtime.renderMermaidSvg.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveSvg = resolve;
      }),
    );
    const onExternalTarget = await renderBlock();
    await act(async () => {
      resolveSvg('<svg><a href="https://example.com/docs"><text>Docs</text></a></svg>');
    });

    fireEvent.click(screen.getByText("Docs"));

    expect(screen.getByRole("alertdialog", { name: "Open external link?" })).toHaveTextContent(
      "https://example.com/docs",
    );
    expect(onExternalTarget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(onExternalTarget).toHaveBeenCalledWith("https://example.com/docs");
  });
});
