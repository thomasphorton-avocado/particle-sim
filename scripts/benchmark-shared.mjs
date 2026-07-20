import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  advanceWorldTick,
  createDefaultPlayerState,
  createDefaultWorldState,
  createStarterWorld,
  MaterialId,
  normalizePlayerInput,
  serializeWorldState,
} from "../packages/shared/dist/index.js";

// 60 Hz is the single authoritative gameplay rate. 30 Hz is modelled as a
// benchmark-only scheduling shape: two ordered authoritative substeps per outer
// frame. Total authoritative ticks are held constant across both shapes so the
// per-tick percentiles are directly comparable.
const TOTAL_TICKS = 600;
const WARMUP_TICKS = 120;
const FALLING_RESPAWN_INTERVAL = 12;

const SCHEDULES = [
  { hz: 60, substepsPerFrame: 1 },
  { hz: 30, substepsPerFrame: 2 },
];

const SCENARIOS = ["starter", "stress"];

function createScenario(name) {
  if (name === "starter") {
    const world = createStarterWorld({ roomId: "bench_starter", seed: 4242 });
    const player = createDefaultPlayerState("player_1");
    player.x = 40;
    player.y = 80;
    world.players.player_1 = player;
    world.fallingObjects.object_1 = {
      id: "object_1",
      materialId: MaterialId.Stone,
      x: 22,
      y: 0,
      restY: 70,
      vy: 0.1,
      offsets: [[0, 0]],
    };
    return world;
  }

  const world = createDefaultWorldState("bench_stress");
  for (let y = 0; y < world.grid.height; y += 1) {
    for (let x = 0; x < world.grid.width; x += 1) {
      if ((x + y) % 7 === 0) {
        world.grid.set(x, y, MaterialId.Dirt);
      }
    }
  }
  const player = createDefaultPlayerState("player_1");
  player.x = 20;
  player.y = 30;
  world.players.player_1 = player;
  world.fallingObjects.object_1 = {
    id: "object_1",
    materialId: MaterialId.Wood,
    x: 10,
    y: -2,
    restY: 35,
    vy: 0.2,
    offsets: [[0, 0], [1, 0]],
  };
  return world;
}

function makeInputsForTick(tick) {
  const pattern = tick % 18;
  return {
    player_1: normalizePlayerInput({
      left: pattern === 0 || pattern === 2,
      right: pattern === 1 || pattern === 3,
      jumpHeld: (tick + 1) % 7 === 0,
      crouchHeld: pattern === 4,
      lookUpHeld: pattern === 5,
      mineHeld: pattern === 6 || pattern === 7,
    }),
  };
}

function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function getMemorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    arrayBuffersBytes: usage.arrayBuffers ?? 0,
  };
}

function getFallingObjectSnapshot(world) {
  const entries = Object.values(world.fallingObjects ?? {})
    .map((object) => ({
      id: object.id,
      materialId: object.materialId,
      x: Number(object.x.toFixed(6)),
      y: Number(object.y.toFixed(6)),
      vy: Number(object.vy.toFixed(6)),
      restY: Number(object.restY.toFixed(6)),
      offsets: object.offsets?.map(([dx, dy]) => [dx, dy]) ?? [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify(entries);
}

function ensureMeasuredFallingObject(world, substepIndex) {
  const shouldRespawn = substepIndex === 0 || substepIndex % FALLING_RESPAWN_INTERVAL === 0 || !world.fallingObjects.object_1;
  if (!shouldRespawn) return;
  world.fallingObjects.object_1 = {
    id: "object_1",
    materialId: MaterialId.Wood,
    x: 10,
    y: -2,
    restY: 35,
    vy: 0.2,
    offsets: [[0, 0], [1, 0]],
  };
}

function serializeDigest(world) {
  return createHash("sha256").update(JSON.stringify(serializeWorldState(world))).digest("hex");
}

function getGc(options = {}) {
  if (typeof options.gc === "function") {
    return options.gc;
  }
  if (typeof global.gc === "function") {
    return global.gc;
  }
  throw new Error("Benchmark requires node --expose-gc. Re-run with: node --expose-gc ./scripts/benchmark-shared.mjs");
}

function runScenario(name, schedule, options = {}) {
  const world = createScenario(name);
  const warmupTicks = options.warmupTicks ?? WARMUP_TICKS;
  const totalTicks = options.totalTicks ?? TOTAL_TICKS;
  const gc = getGc(options);

  for (let tick = 0; tick < warmupTicks; tick += 1) {
    advanceWorldTick(world, makeInputsForTick(tick));
  }

  gc();
  const baselineMemory = getMemorySnapshot();

  const tickSamplesMs = [];
  const frameSamplesMs = [];
  const frames = Math.ceil(totalTicks / schedule.substepsPerFrame);
  let fallingUpdates = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const frameStart = process.hrtime.bigint();
    for (let substep = 0; substep < schedule.substepsPerFrame; substep += 1) {
      const substepIndex = frame * schedule.substepsPerFrame + substep;
      const tickStart = process.hrtime.bigint();
      ensureMeasuredFallingObject(world, substepIndex);
      const fallingBefore = getFallingObjectSnapshot(world);
      const tickIndex = warmupTicks + substepIndex;
      advanceWorldTick(world, makeInputsForTick(tickIndex));
      const fallingAfter = getFallingObjectSnapshot(world);
      if (fallingBefore !== fallingAfter) {
        fallingUpdates += 1;
      }
      tickSamplesMs.push(Number(process.hrtime.bigint() - tickStart) / 1e6);
    }
    frameSamplesMs.push(Number(process.hrtime.bigint() - frameStart) / 1e6);
  }

  gc();
  const finalMemory = getMemorySnapshot();
  const finalBytes = Buffer.byteLength(JSON.stringify(serializeWorldState(world)));
  const finalDigest = serializeDigest(world);

  const perTick = summarize(tickSamplesMs);
  const perFrame = summarize(frameSamplesMs);

  return {
    scenario: name,
    hz: schedule.hz,
    substepsPerFrame: schedule.substepsPerFrame,
    ticks: tickSamplesMs.length,
    frames: frameSamplesMs.length,
    perTickMs: perTick,
    perFrameMs: perFrame,
    tickThroughputPerSec: 1000 / perTick.mean,
    frameBudgetUtilization: perFrame.mean / (1000 / schedule.hz),
    fallingUpdates,
    memory: {
      rssDeltaBytes: finalMemory.rssBytes - baselineMemory.rssBytes,
      heapDeltaBytes: finalMemory.heapUsedBytes - baselineMemory.heapUsedBytes,
      arrayBuffersDeltaBytes: finalMemory.arrayBuffersBytes - baselineMemory.arrayBuffersBytes,
      baseline: baselineMemory,
      final: finalMemory,
      rssBytes: finalMemory.rssBytes,
      heapUsedBytes: finalMemory.heapUsedBytes,
      arrayBuffersBytes: finalMemory.arrayBuffersBytes,
      serializedStateBytes: finalBytes,
    },
    digest: finalDigest,
  };
}

export function runBenchmark(options = {}) {
  const results = [];
  for (const scenario of SCENARIOS) {
    for (const schedule of SCHEDULES) {
      results.push(runScenario(scenario, schedule, options));
    }
  }
  return results;
}

export function assertBenchmarkResults(results) {
  const minimumFallingUpdates = Math.max(50, Math.floor(TOTAL_TICKS / 4));
  const byKey = new Map();
  for (const result of results) {
    byKey.set(`${result.scenario}:${result.hz}`, result);
    if (!Number.isFinite(result.fallingUpdates) || result.fallingUpdates <= minimumFallingUpdates) {
      throw new Error(`Benchmark falling update count too low for ${result.scenario} @ ${result.hz}Hz: ${result.fallingUpdates}`);
    }
    for (const [key, value] of Object.entries(result.memory)) {
      if (key === "baseline" || key === "final") continue;
      if (!Number.isFinite(value)) {
        throw new Error(`Benchmark memory metric ${key} is not finite for ${result.scenario} @ ${result.hz}Hz`);
      }
    }
  }

  const [starter60, starter30, stress60, stress30] = [
    byKey.get("starter:60"),
    byKey.get("starter:30"),
    byKey.get("stress:60"),
    byKey.get("stress:30"),
  ];
  if (!starter60 || !starter30 || !stress60 || !stress30) {
    throw new Error("Benchmark missing expected schedule results");
  }
  if (starter60.digest !== starter30.digest || stress60.digest !== stress30.digest) {
    throw new Error(`Benchmark cadence equality mismatch: ${starter60.digest} !== ${starter30.digest} or ${stress60.digest} !== ${stress30.digest}`);
  }
}

function main() {
  if (typeof global.gc !== "function") {
    throw new Error("Benchmark requires node --expose-gc. Re-run with: node --expose-gc ./scripts/benchmark-shared.mjs");
  }
  const results = runBenchmark();
  assertBenchmarkResults(results);
  const byKey = new Map();
  for (const result of results) {
    byKey.set(`${result.scenario}:${result.hz}`, result);
  }

  // Machine-readable output (one JSON object per line).
  for (const result of results) {
    console.log(JSON.stringify(result));
  }

  // Human-readable summary.
  const toMs = (value) => value.toFixed(4);
  const toMb = (bytes) => (bytes / (1024 * 1024)).toFixed(2);
  console.error("\nBenchmark summary (per-tick latency, ms):");
  console.error(
    ["scenario", "hz", "p50", "p95", "p99", "mean", "max", "frameUtil", "rssMB", "heapMB", "digest"]
      .map((header) => header.padStart(10))
      .join(" "),
  );
  for (const result of results) {
    console.error(
      [
        result.scenario,
        String(result.hz),
        toMs(result.perTickMs.p50),
        toMs(result.perTickMs.p95),
        toMs(result.perTickMs.p99),
        toMs(result.perTickMs.mean),
        toMs(result.perTickMs.max),
        `${(result.frameBudgetUtilization * 100).toFixed(1)}%`,
        toMb(result.memory.rssDeltaBytes),
        toMb(result.memory.heapDeltaBytes),
        result.digest.slice(0, 12),
      ]
        .map((cell) => cell.padStart(10))
        .join(" "),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file://"))) {
  main();
}
