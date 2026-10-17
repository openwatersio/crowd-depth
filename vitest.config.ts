import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15000,
    // packages/grid is Python; its virtualenv holds stray test files.
    projects: ["packages/*", "!packages/grid"],
  },
});
