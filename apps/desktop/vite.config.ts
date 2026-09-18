import { defineConfig } from "vitest/config";
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
    // 165 个测试文件各建一次 jsdom 环境（实测冷缓存全量：environment 150s、
    // import 118s，均为各 worker 内累加）。默认 5s 的单项预算在宿主负载下会
    // 让「文件内第一个 render」偶发超时（实际报告为 Test timed out in 5000ms），
    // 换台机器复跑即全绿——是环境争用，不是产品行为。这里把单项预算放宽到
    // 15s，只覆盖环境冷启动与争用；断言强度不变，也不加任何人为延时。
    testTimeout: 15_000,
  },
});
