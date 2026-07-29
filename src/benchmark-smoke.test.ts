import { describe, expect, it } from "vitest";

// @ts-expect-error - the benchmark script is ESM and intentionally typed via a declaration file.
const benchmarkModule = await import("../scripts/benchmark-shared.mjs");
const { runBenchmark: typedRunBenchmark } = benchmarkModule as { runBenchmark: (options?: { warmupTicks?: number; totalTicks?: number; gc?: () => void }) => Array<{ scenario: string; hz: number; digest: string }> };

describe("benchmark self-verification", () => {
  it("keeps 60Hz, 30Hz, and 20Hz publication cadences canonically identical", () => {
    const results = typedRunBenchmark({ warmupTicks: 2, totalTicks: 6, gc: () => undefined });
    expect(results).toHaveLength(6);

    const byScenario = new Map<string, { hz: number; digest: string }>();
    for (const result of results) {
      const key = `${result.scenario}:${result.hz}`;
      byScenario.set(key, { hz: result.hz, digest: result.digest });
    }

    for (const scenario of ["representative", "heavy"]) {
      const sixty = byScenario.get(`${scenario}:60`);
      const thirty = byScenario.get(`${scenario}:30`);
      const twenty = byScenario.get(`${scenario}:20`);
      expect(sixty).toBeDefined();
      expect(thirty).toBeDefined();
      expect(twenty).toBeDefined();
      expect(sixty?.digest).toBe(thirty?.digest);
      expect(sixty?.digest).toBe(twenty?.digest);
    }
  });
});
