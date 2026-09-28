import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const prototypeRoot = fileURLToPath(new URL("./prototypes/welcome-motion/", import.meta.url));

export default defineConfig({
  root: prototypeRoot,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5186,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
