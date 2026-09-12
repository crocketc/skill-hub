import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 稳定的 vendor 分包：框架代码独立成块，业务代码更新时仍能命中缓存。
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-i18n": ["i18next", "react-i18next"],
        },
      },
    },
  },
  test: {
    css: true,
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.ts",
  },
});
