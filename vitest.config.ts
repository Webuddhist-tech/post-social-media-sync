import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workspace packages resolve to their TypeScript sources (see the "post-sync-source" export condition).
    conditions: ["post-sync-source"],
  },
  ssr: {
    resolve: { conditions: ["post-sync-source"], externalConditions: ["post-sync-source"] },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 20_000,
  },
});
