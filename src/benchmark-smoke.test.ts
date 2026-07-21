import { describe, expect, it } from "vitest";

// @ts-expect-error - the benchmark script is ESM and intentionally typed via a declaration file.
const benchmarkModule = await import("../scripts/benchmark-shared.mjs");
const { runBenchmark: typedRunBenchmark } = benchmarkModule as { runBenchmark: (options?: { warmupTicks?: number; totalTicks?: number; gc?: () => void }) => Array<{ scenario: string; hz: number; digest: string }> };

describe("benchmark self-verification", () => {
  it("keeps 60Hz and 30Hz cadences canonically identical", () => {
    const results = typedRunBenchmark({ warmupTicks: 20, totalTicks: 60, gc: () => undefined });
    expect(results).toHaveLength(4);

    const byScenario = new Map<string, { hz: number; digest: string }>();
    for (const result of results) {
      const key = `${result.scenario}:${result.hz}`;
      byScenario.set(key, { hz: result.hz, digest: result.digest });
    }

    for (const scenario of ["starter", "stress"]) {
      const sixty = byScenario.get(`${scenario}:60`);
      const thirty = byScenario.get(`${scenario}:30`);
      expect(sixty).toBeDefined();
      expect(thirty).toBeDefined();
      expect(sixty?.digest).toBe(thirty?.digest);
    }
  });
});
