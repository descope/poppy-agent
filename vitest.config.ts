import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      // ponytail: floors just under the coverage of the 0.3 rewrite; raise them as tests grow.
      thresholds: { statements: 82, branches: 72, functions: 90, lines: 87 },
    },
  },
});
