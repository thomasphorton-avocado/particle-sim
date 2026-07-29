import test from "node:test";
import assert from "node:assert/strict";
import { assertBenchmarkResults, runBenchmark } from "./benchmark-shared.mjs";

test("benchmark harness keeps authority/client cadence convergence with real activity and payloads", () => {
  const results = runBenchmark({ warmupTicks: 40, totalTicks: 180, repetitions: 3, gc: () => undefined });
  assertBenchmarkResults(results);
  for (const result of results) {
    assert.ok(result.fallingUpdates > 0, `${result.scenario}@${result.hz}Hz should track falling updates`);
    assert.ok(result.waterCellUpdates > 0, `${result.scenario}@${result.hz}Hz should track water updates`);
    assert.ok(result.weatherUpdates > 0, `${result.scenario}@${result.hz}Hz should track weather updates`);
    assert.equal(result.clientDigest, result.authorityDigest);
    assert.equal(result.resultOrderMatches, true);
    assert.ok(result.payloadBytes.p95 > 0);
    assert.ok(result.payloadBytes.p95 <= result.payloadBudgetBytes);
    assert.equal(typeof result.digest, "string");
    assert.match(result.digest, /^[a-f0-9]{64}$/);
  }
});
