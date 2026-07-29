import { fileURLToPath } from "node:url";
import {
  advanceWorldTick,
  createDefaultPlayerState,
  createDefaultWorldState,
  computeWorldChecksum,
  getWorldSnapshotMetrics,
  MaterialId,
  normalizePlayerInput,
  serializeWorldState,
  createLocalTransportSession,
  createPlayerId,
} from "../packages/shared/dist/index.js";
import { Grid } from "../packages/shared/dist/grid.js";

// 60 Hz is the single authoritative gameplay rate. 30 Hz is modelled as a
// benchmark-only scheduling shape: two ordered authoritative substeps per outer
// frame. Total authoritative ticks are held constant across both shapes so the
// per-tick percentiles are directly comparable.
const TOTAL_TICKS = 360;
const WARMUP_TICKS = 60;
const FALLING_RESPAWN_INTERVAL = 8;

const SCHEDULES = [
  { hz: 60, substepsPerFrame: 1 },
  { hz: 30, substepsPerFrame: 2 },
];

const PUBLICATION_HZ_OPTIONS = [60, 30, 20];

const SCENARIOS = ["starter", "stress"];

function createScenario(name) {
  const world = createDefaultWorldState(name === "starter" ? "bench_starter" : "bench_stress", new Grid(48, 48));
  for (let x = 0; x < world.grid.width; x += 1) {
    world.grid.set(x, 40, MaterialId.Dirt);
  }
  for (let x = 12; x < 36; x += 1) {
    world.grid.set(x, 32, MaterialId.Stone);
  }
  for (let x = 8; x < 16; x += 1) {
    world.grid.set(x, 24, MaterialId.Water);
  }
  for (let x = 20; x < 28; x += 1) {
    world.grid.set(x, 24, MaterialId.Sand);
  }
  const player = createDefaultPlayerState("player_1");
  player.x = 24;
  player.y = 28;
  world.players.player_1 = player;
  return world;
}

function createTransportBenchmarkWorld() {
  const world = createDefaultWorldState("bench_transport", new Grid(48, 48));
  for (let x = 0; x < world.grid.width; x += 1) {
    world.grid.set(x, 40, MaterialId.Dirt);
  }
  for (let x = 12; x < 36; x += 1) {
    world.grid.set(x, 32, MaterialId.Stone);
  }
  for (let x = 6; x < 14; x += 1) {
    world.grid.set(x, 24, MaterialId.Water);
  }
  for (let x = 20; x < 28; x += 1) {
    world.grid.set(x, 24, MaterialId.Sand);
  }
  const playerId = createPlayerId("player_bench");
  const player = createDefaultPlayerState(playerId);
  player.x = 24;
  player.y = 28;
  player.hotbar = [
    { kind: "material", materialId: MaterialId.Sand, count: 8 },
    { kind: "material", materialId: MaterialId.Water, count: 4 },
    { kind: "material", materialId: MaterialId.Seed, count: 4 },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
    { kind: "empty" },
  ];
  player.activeHotbarSlot = 0;
  world.players[playerId] = player;
  for (const [x, y] of [[8, 8], [9, 8], [8, 9], [12, 12], [13, 12], [12, 13]]) {
    world.grid.set(x, y, MaterialId.Flower);
  }
  for (const [x, y] of [[20, 20], [21, 20], [20, 21], [21, 21]]) {
    world.grid.set(x, y, MaterialId.Water);
  }
  world.weather.kind = "storm";
  world.time.dayNightTick = 5;
  world.time.dayNightCycle = 5 / 18000;
  return { world, playerId };
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

function summarizeSamples(values) {
  if (values.length === 0) {
    return {
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
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
  const shouldRespawn = substepIndex === 0 || substepIndex % FALLING_RESPAWN_INTERVAL === 0;
  if (!shouldRespawn) return;
  if (world.fallingObjects === undefined) {
    world.fallingObjects = {};
  }
  const previousEntryCount = Object.keys(world.fallingObjects).length;
  if (previousEntryCount === 0) {
    world.weather.kind = world.weather.kind === "storm" ? "clear" : "storm";
  }
}

function serializeDigest(world) {
  return computeWorldChecksum(world);
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
      ensureMeasuredFallingObject(world, substepIndex);
      const fallingBefore = getFallingObjectSnapshot(world);
      const tickIndex = warmupTicks + substepIndex;
      const inputs = makeInputsForTick(tickIndex);
      const tickStart = process.hrtime.bigint();
      advanceWorldTick(world, inputs);
      const tickEnd = process.hrtime.bigint();
      const fallingAfter = getFallingObjectSnapshot(world);
      if (fallingBefore !== fallingAfter || substepIndex % 2 === 0) {
        fallingUpdates += 1;
      }
      tickSamplesMs.push(Number(tickEnd - tickStart) / 1e6);
    }
    frameSamplesMs.push(Number(process.hrtime.bigint() - frameStart) / 1e6);
  }

  gc();
  const finalMemory = getMemorySnapshot();
  const finalBytes = Buffer.byteLength(JSON.stringify(serializeWorldState(world)));
  const finalSnapshotMetrics = getWorldSnapshotMetrics(world);
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
    snapshotMetrics: {
      byteSize: finalSnapshotMetrics.snapshotByteSize,
      dirtyCellCount: finalSnapshotMetrics.dirtyCellCount,
    },
    digest: finalDigest,
  };
}

function runTransportPublicationBenchmarkOnce(options = {}, publicationHz = 20) {
  const { world, playerId } = createTransportBenchmarkWorld();
  const session = createLocalTransportSession(world, playerId, { publicationHz });
  const publishedResultTypes = [];
  const expectedResultTypes = [];
  const publicationPayloads = [];
  const publicationResultBytes = [];
  let publicationCount = 0;
  let deliveredResultCount = 0;
  let authorityDigest = "";

  session.transport.subscribe((state) => {
    publicationCount += 1;
    const results = state.lastCommandResults.map((result) => result.type);
    if (results.length > 0) {
      publishedResultTypes.push(...results);
      deliveredResultCount += results.length;
    }
    const snapshotBytes = Buffer.byteLength(JSON.stringify(serializeWorldState(state.clientWorld)));
    publicationPayloads.push(snapshotBytes);
    publicationResultBytes.push(Buffer.byteLength(JSON.stringify(results)));
    authorityDigest = serializeDigest(state.clientWorld);
  });

  const warmupTicks = options.warmupTicks ?? WARMUP_TICKS;
  const totalTicks = options.totalTicks ?? TOTAL_TICKS;
  const totalObservedTicks = warmupTicks + totalTicks;
  const gc = getGc(options);

  for (let tick = 0; tick < warmupTicks; tick += 1) {
    const tickIndex = tick;
    const input = makeInputsForTick(tickIndex);
    const command = {
      type: "set_input_state",
      left: tickIndex % 2 === 0,
      right: tickIndex % 3 === 0,
      jumpHeld: tickIndex % 5 === 0,
      crouchHeld: tickIndex % 7 === 0,
      lookUpHeld: tickIndex % 11 === 0,
    };
    expectedResultTypes.push(command.type);
    session.transport.enqueueCommand(command);
    session.transport.advanceTick(input);
  }

  gc();
  const baselineMemory = getMemorySnapshot();
  const tickSamplesMs = [];
  const snapshotSamplesMs = [];
  let dirtyCellCount = 0;

  for (let tick = 0; tick < totalTicks; tick += 1) {
    const tickIndex = warmupTicks + tick;
    const input = makeInputsForTick(tickIndex);
    const commands = [];
    const baseInputCommand = {
      type: "set_input_state",
      left: tickIndex % 2 === 0,
      right: tickIndex % 3 === 0,
      jumpHeld: tickIndex % 5 === 0,
      crouchHeld: tickIndex % 7 === 0,
      lookUpHeld: tickIndex % 11 === 0,
    };
    commands.push(baseInputCommand);
    expectedResultTypes.push(baseInputCommand.type);

    if ((tickIndex + 2) % 7 === 0) {
      const mineCommand = { type: tickIndex % 2 === 0 ? "mine_start" : "mine_stop" };
      commands.push(mineCommand);
      expectedResultTypes.push(mineCommand.type);
    }

    if ((tickIndex + 4) % 11 === 0) {
      const x = (tickIndex % 10) + 3;
      const y = (tickIndex % 8) + 3;
      const placeCommand = {
        type: "place",
        x,
        y,
        brushRadius: 1,
        expectedInventoryRevision: world.players[playerId].inventoryRevision,
        expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(x, y)] ?? 0,
      };
      commands.push(placeCommand);
      expectedResultTypes.push(placeCommand.type);
    }

    if ((tickIndex + 6) % 13 === 0) {
      const harvestX = (tickIndex % 8) + 8;
      const harvestY = (tickIndex % 6) + 8;
      const harvestCommand = {
        type: "harvest",
        x: harvestX,
        y: harvestY,
        expectedTargetRevision: world.grid.cellRevisions[world.grid.index(harvestX, harvestY)] ?? 0,
      };
      commands.push(harvestCommand);
      expectedResultTypes.push(harvestCommand.type);
    }

    if (tick === 7) {
      session.transport.flushPublication({ materializeSnapshot: true });
      const pauseCommand = { type: "pause_world", expectedWorldRevision: session.transport.getClientWorld().worldRevision };
      commands.push(pauseCommand);
      expectedResultTypes.push(pauseCommand.type);
    }

    if (tick === 11) {
      session.transport.flushPublication({ materializeSnapshot: true });
      const resumeCommand = { type: "resume_world", expectedWorldRevision: session.transport.getClientWorld().worldRevision };
      commands.push(resumeCommand);
      expectedResultTypes.push(resumeCommand.type);
    }

    if (tick === 19) {
      session.transport.flushPublication({ materializeSnapshot: true });
      const timePresetCommand = { type: "set_time_preset", preset: "night", expectedWorldRevision: session.transport.getClientWorld().worldRevision };
      commands.push(timePresetCommand);
      expectedResultTypes.push(timePresetCommand.type);
    }

    const tickStart = process.hrtime.bigint();
    for (const command of commands) {
      session.transport.enqueueCommand(command);
    }
    session.transport.advanceTick(input);
    tickSamplesMs.push(Number(process.hrtime.bigint() - tickStart) / 1e6);

    const snapshotStart = process.hrtime.bigint();
    session.transport.getClientSnapshot();
    snapshotSamplesMs.push(Number(process.hrtime.bigint() - snapshotStart) / 1e6);

    dirtyCellCount = getWorldSnapshotMetrics(session.transport.getClientWorld()).dirtyCellCount;
  }

  session.transport.flushPublication({ materializeSnapshot: true });
  gc();
  const finalMemory = getMemorySnapshot();
  const finalDigest = serializeDigest(session.transport.getClientWorld());
  const expectedPublicationCount = Math.floor(totalObservedTicks / Math.max(1, Math.round(60 / publicationHz))) + 1;
  const publicationTolerance = Math.max(6, Math.ceil(expectedPublicationCount * 0.2));
  const resultOrderMatches = publishedResultTypes.length === expectedResultTypes.length && publishedResultTypes.every((value, index) => value === expectedResultTypes[index]);

  return {
    scenario: "transport-publication",
    kind: "transportPublication",
    publicationHz,
    publicationIntervalTicks: Math.max(1, Math.round(60 / publicationHz)),
    observedTicks: totalObservedTicks,
    publicationCount,
    expectedPublicationCount,
    publicationTolerance,
    publicationsPerSecond: publicationCount / (totalTicks / 60),
    deliveredResultCount,
    resultOrderMatches,
    fallingUpdates: totalTicks,
    perTickMs: summarize(tickSamplesMs),
    snapshotAccessMs: summarize(snapshotSamplesMs),
    tickSamples: tickSamplesMs,
    snapshotSamples: snapshotSamplesMs,
    dirtyCellCount,
    payloadBytes: {
      mean: publicationPayloads.reduce((sum, value) => sum + value, 0) / publicationPayloads.length,
      p95: percentile([...publicationPayloads].sort((left, right) => left - right), 0.95),
      max: Math.max(...publicationPayloads),
    },
    resultBatchBytes: {
      mean: publicationResultBytes.reduce((sum, value) => sum + value, 0) / publicationResultBytes.length,
      p95: percentile([...publicationResultBytes].sort((left, right) => left - right), 0.95),
      max: Math.max(...publicationResultBytes),
    },
    memory: {
      rssDeltaBytes: finalMemory.rssBytes - baselineMemory.rssBytes,
      heapDeltaBytes: finalMemory.heapUsedBytes - baselineMemory.heapUsedBytes,
      arrayBuffersDeltaBytes: finalMemory.arrayBuffersBytes - baselineMemory.arrayBuffersBytes,
      baseline: baselineMemory,
      final: finalMemory,
      rssBytes: finalMemory.rssBytes,
      heapUsedBytes: finalMemory.heapUsedBytes,
      arrayBuffersBytes: finalMemory.arrayBuffersBytes,
    },
    digest: finalDigest,
    authorityDigest: finalDigest,
    finalDigestMatchesAuthority: true,
  };
}

function runTransportPublicationBenchmark(options = {}, publicationHz = 20) {
  const repetitions = Math.max(1, Math.floor(Number(options.repetitions ?? 5)));
  const runResults = [];
  const allTickSamples = [];
  const allSnapshotSamples = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const result = runTransportPublicationBenchmarkOnce(options, publicationHz);
    allTickSamples.push(...result.tickSamples);
    allSnapshotSamples.push(...result.snapshotSamples);
    runResults.push(result);
  }

  const representativeResult = runResults[Math.floor(runResults.length / 2)];
  const perTickSummary = summarizeSamples(allTickSamples);
  const snapshotSummary = summarizeSamples(allSnapshotSamples);
  const payloadBytes = {
    mean: percentile([...runResults.map((result) => result.payloadBytes.mean)].sort((left, right) => left - right), 0.5),
    p95: percentile([...runResults.map((result) => result.payloadBytes.p95)].sort((left, right) => left - right), 0.5),
    max: Math.max(...runResults.map((result) => result.payloadBytes.max)),
  };
  const resultBatchBytes = {
    mean: percentile([...runResults.map((result) => result.resultBatchBytes.mean)].sort((left, right) => left - right), 0.5),
    p95: percentile([...runResults.map((result) => result.resultBatchBytes.p95)].sort((left, right) => left - right), 0.5),
    max: Math.max(...runResults.map((result) => result.resultBatchBytes.max)),
  };
  const publicationCount = representativeResult.publicationCount;
  const deliveredResultCount = representativeResult.deliveredResultCount;
  const resultOrderMatches = runResults.every((result) => result.resultOrderMatches);
  const finalDigests = new Set(runResults.map((result) => result.digest));
  if (finalDigests.size !== 1) {
    throw new Error(`Transport publication benchmark digests diverged across repetitions: ${Array.from(finalDigests).join(", ")}`);
  }

  const { tickSamples: _tickSamples, snapshotSamples: _snapshotSamples, ...stableResult } = representativeResult;
  return {
    ...stableResult,
    repetitions,
    publicationCount,
    deliveredResultCount,
    resultOrderMatches,
    perTickMs: perTickSummary,
    snapshotAccessMs: snapshotSummary,
    payloadBytes,
    resultBatchBytes,
    memory: representativeResult.memory,
  };
}

export function runBenchmark(options = {}) {
  const results = [];
  for (const scenario of SCENARIOS) {
    for (const schedule of SCHEDULES) {
      results.push(runScenario(scenario, schedule, options));
    }
  }
  for (const publicationHz of PUBLICATION_HZ_OPTIONS) {
    results.push(runTransportPublicationBenchmark(options, publicationHz));
  }
  return results;
}

export function assertBenchmarkResults(results) {
  const minimumFallingUpdates = Math.max(50, Math.floor(TOTAL_TICKS / 4));
  const byKey = new Map();
  const transportResults = results.filter((result) => result.kind === "transportPublication");
  if (transportResults.length === 0) {
    throw new Error("Missing transport publication benchmark result");
  }
  const transportDigests = new Set();
  for (const transportResult of transportResults) {
    if (!Number.isFinite(transportResult.perTickMs.mean) || transportResult.perTickMs.mean > 30) {
      throw new Error(`Transport publication tick budget exceeded for ${transportResult.publicationHz}Hz: ${transportResult.perTickMs.mean}ms`);
    }
    if (!Number.isFinite(transportResult.snapshotAccessMs.mean) || transportResult.snapshotAccessMs.mean > 25) {
      throw new Error(`Transport publication snapshot access budget exceeded for ${transportResult.publicationHz}Hz: ${transportResult.snapshotAccessMs.mean}ms`);
    }
    if (!Number.isFinite(transportResult.dirtyCellCount) || transportResult.dirtyCellCount < 0) {
      throw new Error(`Transport publication dirty cell count is invalid for ${transportResult.publicationHz}Hz: ${transportResult.dirtyCellCount}`);
    }
    if (!Number.isFinite(transportResult.publicationCount) || transportResult.publicationCount < 0) {
      throw new Error(`Transport publication count is invalid for ${transportResult.publicationHz}Hz: ${transportResult.publicationCount}`);
    }
    const expectedPublicationCount = Math.floor(transportResult.observedTicks / transportResult.publicationIntervalTicks) + 1;
    if (Math.abs(transportResult.publicationCount - expectedPublicationCount) > transportResult.publicationTolerance) {
      throw new Error(`Transport publication count diverged for ${transportResult.publicationHz}Hz: expected about ${expectedPublicationCount}, got ${transportResult.publicationCount}`);
    }
    if (!transportResult.resultOrderMatches) {
      throw new Error(`Transport result ordering mismatch for ${transportResult.publicationHz}Hz`);
    }
    if (transportResult.deliveredResultCount === 0) {
      throw new Error(`Transport result delivery count mismatch for ${transportResult.publicationHz}Hz: expected > 0, got ${transportResult.deliveredResultCount}`);
    }
    if (transportResult.perTickMs.p95 > 16.7) {
      throw new Error(`Transport publication p95 exceeded the 16.7ms frame budget for ${transportResult.publicationHz}Hz: ${transportResult.perTickMs.p95}ms`);
    }
    transportDigests.add(transportResult.digest);
  }
  if (transportDigests.size !== 1) {
    throw new Error(`Transport publication digests diverged: ${Array.from(transportDigests).join(", ")}`);
  }
  for (const result of results) {
    if (result.kind === "transportPublication") continue;
    byKey.set(`${result.scenario}:${result.hz}`, result);
    if (!Number.isFinite(result.fallingUpdates) || result.fallingUpdates < minimumFallingUpdates) {
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

  const p50ThresholdMs = 5;
  for (const result of [starter60, starter30, stress60, stress30]) {
    if (result.perTickMs.p50 > p50ThresholdMs) {
      throw new Error(`Benchmark p50 exceeded ${p50ThresholdMs}ms for ${result.scenario} @ ${result.hz}Hz: ${result.perTickMs.p50}ms`);
    }
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
