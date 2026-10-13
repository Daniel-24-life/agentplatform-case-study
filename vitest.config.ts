import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    maxWorkers: 1,
    minWorkers: 1,
    include: ["tests/**/*.test.ts"]
  }
});
