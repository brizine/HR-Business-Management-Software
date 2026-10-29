import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { fileParallelism: false, testTimeout: 20000, env: { NODE_ENV: "test", ALLOW_SIGNUP: "true" } },
});
