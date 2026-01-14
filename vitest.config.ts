import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15000,
  },
  optimizeDeps: {
    include: ["tslib", "@aws-sdk/client-s3", "@smithy/uuid"],
  },
  resolve: {
    alias: {
      tslib: "tslib/tslib.js",
    },
  },
});
