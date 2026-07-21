import test from "node:test";
import assert from "node:assert/strict";
import { assertBenchmarkResults, runBenchmark } from "./benchmark-shared.mjs";

test("benchmark harness keeps equal digests and active falling updates", () => {
  const results = runBenchmark({ warmupTicks: 120, totalTicks: 600, gc: () => undefined });
  assertBenchmarkResults(results);
  for (const result of results) {
    assert.ok(result.fallingUpdates > 0, `${result.scenario}@${result.hz}Hz should track falling updates`);
    assert.equal(typeof result.digest, "string");
    assert.match(result.digest, /^[a-f0-9]{64}$/);
  }
});
