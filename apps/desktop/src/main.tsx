import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App bootstrap={{ phase: "loading_local", locale: "zh-CN" }} />
  </StrictMode>,
);
