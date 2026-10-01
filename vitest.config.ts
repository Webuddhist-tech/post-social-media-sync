import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 20_000,
  },
});
