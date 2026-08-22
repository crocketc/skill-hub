import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the local bootstrap state without network access", async () => {
  render(<App bootstrap={{ phase: "loading_local", locale: "zh-CN" }} />);
  expect(screen.getByText("正在读取本地数据")).toBeInTheDocument();
});
