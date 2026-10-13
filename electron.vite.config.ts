import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    entry: "src/main/index.ts",
    build: {
      rollupOptions: { input: { index: resolve("src/main/index.ts"), "product-preview-server": resolve("src/main/products/product-preview-server.ts") } },
      externalizeDeps: {
        exclude: ["ajv"]
      }
    }
  },
  preload: {
    input: "src/preload/index.ts",
    // Product boundary validators must be bundled for the sandboxed preload.
    build: {
      externalizeDeps: { exclude: ["ajv"] },
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@": resolve("src/renderer/src")
      }
    },
    plugins: [react()]
  }
});
