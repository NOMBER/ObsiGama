import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "packages/sdk/test/**/*.test.ts"], environment: "node" },
});
