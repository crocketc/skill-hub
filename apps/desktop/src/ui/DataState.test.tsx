import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { DataState } from "./DataState";

it("exposes an error and lets the user retry the failed read", () => {
  const onRetry = vi.fn();
  render(
    <DataState
      actionLabel="重新读取"
      message="无法读取技能库"
      onAction={onRetry}
      state="error"
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent("无法读取技能库");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

it("announces loading without presenting it as an error", () => {
  render(<DataState message="正在读取本地数据" state="loading" />);

  expect(screen.getByRole("status")).toHaveTextContent("正在读取本地数据");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("announces unavailable data without treating it as an application error", () => {
  render(<DataState message="Catalog contract is unavailable" state="unavailable" />);

  expect(screen.getByRole("status")).toHaveTextContent(
    "Catalog contract is unavailable",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
