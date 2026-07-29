import { fileURLToPath } from "node:url";
import {
  advanceWorldTick,
  allocateObjectId,
  computeWorldChecksum,
  createCommandEnvelope,
  createDefaultFallingObjectState,
  createDefaultPlayerState,
  createDefaultWorldState,
  createLocalTransportSession,
  createPlayerId,
  getWorldSnapshotMetrics,
  MaterialId,
  normalizePlayerInput,
  processCommand,
  serializeWorldState,
} from "../packages/shared/dist/index.js";
import { Grid } from "../packages/shared/dist/grid.js";

const TOTAL_TICKS = 360;
const WARMUP_TICKS = 60;
const TIMING_WINDOW_TICKS = 6;
const PUBLICATION_HZ_OPTIONS = [60, 30, 20];

const SCENARIOS = [
  {
    name: "representative",
    width: 48,
    height: 48,
    seed: 0x5eed_1001,
    initialFallingObjects: 4,
    waterWidth: 10,
    payloadBudgetBytes: 192 * 1024,
  },
  {
    name: "heavy",
    width: 64,
    height: 64,
    seed: 0x5eed_2002,
    initialFallingObjects: 12,
    waterWidth: 24,
    payloadBudgetBytes: 320 * 1024,
  },
];

function percentile(sortedAsc, q) {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const mean = sorted.length === 0
    ? 0
    : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  };
}

function summarizeWindowedTicks(samples) {
  const windowedSamples = [];
  for (let start = 0; start < samples.length; start += TIMING_WINDOW_TICKS) {
    const window = samples.slice(start, start + TIMING_WINDOW_TICKS);
    windowedSamples.push(window.reduce((sum, value) => sum + value, 0) / window.length);
  }
  return summarize(windowedSamples);
}

function getMemorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    arrayBuffersBytes: usage.arrayBuffers ?? 0,
  };
}

function getGc(options = {}) {
  if (typeof options.gc === "function") return options.gc;
  if (typeof global.gc === "function") return global.gc;
  throw new Error("Benchmark requires node --expose-gc. Re-run with: node --expose-gc ./scripts/benchmark-shared.mjs");
}

function createScenarioWorld(config) {
  const world = createDefaultWorldState(`bench_${config.name}`, new Grid(config.width, config.height));
  world.random.seed = config.seed;
  world.random.state = config.seed;
  world.weather.kind = "storm";
  world.weather.episodeElapsed = 0;
  world.weather.episodeDuration = 180;
  world.weather.wind = config.name === "heavy" ? -1 : 1;
  world.weather.rainAccumulator = 0.5;
  world.time.dayNightTick = 4_500;
  world.time.dayNightCycle = world.time.dayNightTick / 18_000;

  const groundY = config.height - 6;
  for (let x = 0; x < config.width; x += 1) {
    world.grid.set(x, groundY, MaterialId.Dirt);
  }
  const waterStart = Math.floor((config.width - config.waterWidth) / 2);
  for (let x = waterStart; x < waterStart + config.waterWidth; x += 1) {
    world.grid.set(x, groundY - 1, MaterialId.Water);
    if (config.name === "heavy") {
      world.grid.set(x, groundY - 2, MaterialId.Water);
    }
  }
  for (let x = 4; x < config.width - 4; x += 6) {
    world.grid.set(x, groundY - 1, MaterialId.Sand);
  }
  const protectedStart = Math.floor(config.width / 2) - 16;
  const protectedEnd = Math.floor(config.width / 2) + 16;
  for (let x = protectedStart; x <= protectedEnd; x += 1) {
    world.grid.set(x, groundY - 12, MaterialId.Dirt);
  }

  const playerId = createPlayerId(`player_bench_${config.name}`);
  const player = createDefaultPlayerState(playerId);
  player.x = Math.floor(config.width / 2) - 1;
  player.y = groundY - player.height;
  player.grounded = true;
  player.hotbar = [
    { kind: "material", materialId: MaterialId.Torch, count: 32 },
    { kind: "material", materialId: MaterialId.Water, count: 32 },
    ...Array.from({ length: 8 }, () => ({ kind: "empty" })),
  ];
  player.activeHotbarSlot = 0;
  world.players[playerId] = player;
  world.ownerPlayerId = playerId;

  for (let index = 0; index < config.initialFallingObjects; index += 1) {
    const objectId = allocateObjectId(world);
    const x = 4 + (index * 5) % (config.width - 8);
    const restY = groundY - 1;
    world.fallingObjects[objectId] = createDefaultFallingObjectState(
      objectId,
      MaterialId.Torch,
      x,
      2 + (index % 3),
      restY,
      0,
      [[0, 0]],
    );
  }

  world.grid.dirtyCells.clear();
  return { world, playerId, groundY };
}

function createInput(tick) {
  return normalizePlayerInput({
    left: tick % 20 < 4,
    right: tick % 20 >= 10 && tick % 20 < 14,
    jumpHeld: tick % 31 === 0,
    crouchHeld: tick % 37 === 0,
    lookUpHeld: tick % 41 === 0,
    mineHeld: tick % 17 === 0,
  });
}

function resultKey(result) {
  return `${result.actorSequence}:${result.type}:${result.kind}:${result.code}`;
}

function createCommandsForTick(transport, config, tickIndex, input) {
  const commands = [{
    type: "set_input_state",
    left: input.left,
    right: input.right,
    jumpHeld: input.jumpHeld,
    crouchHeld: input.crouchHeld,
    lookUpHeld: input.lookUpHeld,
  }];

  if (tickIndex % 36 === 0) {
    transport.flushPublication({ materializeSnapshot: false });
    const publishedWorld = transport.getClientWorld();
    const placementOrdinal = Math.floor(tickIndex / 36);
    const x = Math.floor(config.width / 2) - 12 + (placementOrdinal % 7) * 4;
    const y = config.height - 14;
    commands.push({
      type: "place",
      x,
      y,
      brushRadius: 1,
      expectedInventoryRevision: publishedWorld.players[Object.keys(publishedWorld.players)[0]].inventoryRevision,
      expectedAnchorRevision: publishedWorld.grid.cellRevisions[publishedWorld.grid.index(x, y)] ?? 0,
    });
  }

  return commands;
}

function runScenarioOnce(config, publicationHz, options = {}) {
  const transportFixture = createScenarioWorld(config);
  const referenceFixture = createScenarioWorld(config);
  const session = createLocalTransportSession(transportFixture.world, transportFixture.playerId, { publicationHz });
  const expectedResults = [];
  const deliveredResults = [];
  const payloadSamples = [];
  const resultPayloadSamples = [];
  const tickSamples = [];
  let publicationCount = 0;
  let fallingUpdates = 0;
  let waterCellUpdates = 0;
  let weatherUpdates = 0;
  let placementAttempts = 0;
  let acceptedPlacements = 0;
  const placementResultCodes = [];
  let actorSequence = 1;

  session.transport.subscribe((state) => {
    publicationCount += 1;
    const results = state.lastCommandResults;
    deliveredResults.push(...results.map(resultKey));
    const payload = state.snapshot !== null
      ? { snapshot: state.snapshot, commandResults: results }
      : { delta: state.delta, commandResults: results };
    payloadSamples.push(Buffer.byteLength(JSON.stringify(payload)));
    resultPayloadSamples.push(Buffer.byteLength(JSON.stringify(results)));
    if (state.delta) {
      fallingUpdates += state.delta.fallingObjects.length;
      waterCellUpdates += state.delta.cells.filter((cell) => cell.materialId === MaterialId.Water || cell.materialId === MaterialId.Empty).length;
      weatherUpdates += state.delta.metadata.filter((entry) => entry.field === "weather").length;
    }
  });

  const warmupTicks = options.warmupTicks ?? WARMUP_TICKS;
  const totalTicks = options.totalTicks ?? TOTAL_TICKS;
  const totalObservedTicks = warmupTicks + totalTicks;
  const gc = getGc(options);

  gc();
  const baselineMemory = getMemorySnapshot();
  const startedAt = process.hrtime.bigint();

  for (let tickIndex = 0; tickIndex < totalObservedTicks; tickIndex += 1) {
    const input = createInput(tickIndex);
    const tickStart = process.hrtime.bigint();
    const commands = createCommandsForTick(session.transport, config, tickIndex, input);
    for (const command of commands) {
      session.transport.enqueueCommand(command);
      const envelope = createCommandEnvelope(referenceFixture.playerId, actorSequence, referenceFixture.world.tick, command);
      const referenceResult = processCommand(referenceFixture.world, envelope);
      expectedResults.push(resultKey(referenceResult));
      if (command.type === "place") {
        placementAttempts += 1;
        placementResultCodes.push(referenceResult.code);
        if (referenceResult.kind === "accepted") acceptedPlacements += 1;
      }
      actorSequence += 1;
    }
    session.transport.advanceTick(input);
    advanceWorldTick(referenceFixture.world, { [referenceFixture.playerId]: input });
    if (tickIndex >= warmupTicks) {
      tickSamples.push(Number(process.hrtime.bigint() - tickStart) / 1e6);
    }
  }

  session.transport.flushPublication({ materializeSnapshot: true });
  const runtimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  gc();
  const finalMemory = getMemorySnapshot();
  const clientWorld = session.transport.getClientWorld();
  const authorityDigest = computeWorldChecksum(referenceFixture.world);
  const clientDigest = computeWorldChecksum(clientWorld);
  const snapshotMetrics = getWorldSnapshotMetrics(clientWorld);
  const payloadSummary = summarize(payloadSamples);
  const resultPayloadSummary = summarize(resultPayloadSamples);
  const perTickMs = summarizeWindowedTicks(tickSamples);

  return {
    scenario: config.name,
    kind: "publicationCadence",
    hz: publicationHz,
    publicationHz,
    publicationIntervalTicks: Math.max(1, Math.round(60 / publicationHz)),
    observedTicks: totalObservedTicks,
    measuredTicks: totalTicks,
    timingWindowTicks: TIMING_WINDOW_TICKS,
    runtimeMs,
    publicationCount,
    deliveredResultCount: deliveredResults.length,
    expectedResultCount: expectedResults.length,
    resultOrderMatches: deliveredResults.length === expectedResults.length
      && deliveredResults.every((value, index) => value === expectedResults[index]),
    placementAttempts,
    acceptedPlacements,
    placementResultCodes,
    fallingUpdates,
    waterCellUpdates,
    weatherUpdates,
    perTickMs,
    rawTickMaxMs: Math.max(...tickSamples, 0),
    frameBudgetUtilization: perTickMs.mean / (1000 / 60),
    payloadBytes: payloadSummary,
    payloadBudgetBytes: config.payloadBudgetBytes,
    resultBatchBytes: resultPayloadSummary,
    actorHighWater: clientWorld.commandLedger.actorHighWater[transportFixture.playerId] ?? 0,
    recentReceiptCount: clientWorld.commandLedger.recent.length,
    memory: {
      rssDeltaBytes: finalMemory.rssBytes - baselineMemory.rssBytes,
      heapDeltaBytes: finalMemory.heapUsedBytes - baselineMemory.heapUsedBytes,
      arrayBuffersDeltaBytes: finalMemory.arrayBuffersBytes - baselineMemory.arrayBuffersBytes,
      baseline: baselineMemory,
      final: finalMemory,
      rssBytes: finalMemory.rssBytes,
      heapUsedBytes: finalMemory.heapUsedBytes,
      arrayBuffersBytes: finalMemory.arrayBuffersBytes,
      serializedStateBytes: Buffer.byteLength(JSON.stringify(serializeWorldState(clientWorld))),
    },
    snapshotMetrics: {
      byteSize: snapshotMetrics.snapshotByteSize,
      dirtyCellCount: snapshotMetrics.dirtyCellCount,
    },
    digest: clientDigest,
    clientDigest,
    authorityDigest,
    finalDigestMatchesAuthority: clientDigest === authorityDigest,
  };
}

function medianMetric(results, selector) {
  const values = results.map(selector).sort((left, right) => left - right);
  return percentile(values, 0.5);
}

function runScenario(config, publicationHz, options = {}) {
  const repetitions = Math.max(1, Math.floor(Number(options.repetitions ?? 3)));
  const runs = Array.from({ length: repetitions }, () => runScenarioOnce(config, publicationHz, options));
  const digests = new Set(runs.map((result) => result.digest));
  const authorityDigests = new Set(runs.map((result) => result.authorityDigest));
  if (digests.size !== 1 || authorityDigests.size !== 1) {
    throw new Error(`Publication benchmark digests diverged across repetitions for ${config.name} @ ${publicationHz}Hz`);
  }
  const representative = [...runs].sort((left, right) => left.perTickMs.p95 - right.perTickMs.p95)[Math.floor(runs.length / 2)];
  return {
    ...representative,
    repetitions,
    runtimeMs: medianMetric(runs, (result) => result.runtimeMs),
    totalRuntimeMs: runs.reduce((sum, result) => sum + result.runtimeMs, 0),
    resultOrderMatches: runs.every((result) => result.resultOrderMatches),
    finalDigestMatchesAuthority: runs.every((result) => result.finalDigestMatchesAuthority),
    perTickMs: {
      mean: medianMetric(runs, (result) => result.perTickMs.mean),
      p50: medianMetric(runs, (result) => result.perTickMs.p50),
      p95: medianMetric(runs, (result) => result.perTickMs.p95),
      p99: medianMetric(runs, (result) => result.perTickMs.p99),
      max: Math.max(...runs.map((result) => result.perTickMs.max)),
    },
    rawTickMaxMs: Math.max(...runs.map((result) => result.rawTickMaxMs)),
    payloadBytes: {
      mean: medianMetric(runs, (result) => result.payloadBytes.mean),
      p50: medianMetric(runs, (result) => result.payloadBytes.p50),
      p95: medianMetric(runs, (result) => result.payloadBytes.p95),
      p99: medianMetric(runs, (result) => result.payloadBytes.p99),
      max: Math.max(...runs.map((result) => result.payloadBytes.max)),
    },
    resultBatchBytes: {
      mean: medianMetric(runs, (result) => result.resultBatchBytes.mean),
      p50: medianMetric(runs, (result) => result.resultBatchBytes.p50),
      p95: medianMetric(runs, (result) => result.resultBatchBytes.p95),
      p99: medianMetric(runs, (result) => result.resultBatchBytes.p99),
      max: Math.max(...runs.map((result) => result.resultBatchBytes.max)),
    },
    frameBudgetUtilization: medianMetric(runs, (result) => result.perTickMs.mean) / (1000 / 60),
  };
}

export function runBenchmark(options = {}) {
  const results = [];
  for (const config of SCENARIOS) {
    for (const publicationHz of PUBLICATION_HZ_OPTIONS) {
      results.push(runScenario(config, publicationHz, options));
    }
  }
  return results;
}

export function assertBenchmarkResults(results) {
  if (results.length !== SCENARIOS.length * PUBLICATION_HZ_OPTIONS.length) {
    throw new Error(`Expected ${SCENARIOS.length * PUBLICATION_HZ_OPTIONS.length} benchmark results, received ${results.length}`);
  }

  const byScenario = new Map();
  for (const result of results) {
    if (!result.finalDigestMatchesAuthority || result.clientDigest !== result.authorityDigest) {
      throw new Error(`Authority/client digest mismatch for ${result.scenario} @ ${result.hz}Hz`);
    }
    if (!result.resultOrderMatches || result.deliveredResultCount !== result.expectedResultCount) {
      throw new Error(`Ordered exactly-once command delivery failed for ${result.scenario} @ ${result.hz}Hz`);
    }
    if (result.actorHighWater !== result.expectedResultCount) {
      throw new Error(`Actor high-water mismatch for ${result.scenario} @ ${result.hz}Hz: ${result.actorHighWater} !== ${result.expectedResultCount}`);
    }
    if (result.recentReceiptCount > 256) {
      throw new Error(`Command ledger exceeded 256 receipts for ${result.scenario} @ ${result.hz}Hz`);
    }
    if (result.placementAttempts === 0 || result.acceptedPlacements !== result.placementAttempts) {
      throw new Error(`Placement activity was not fully accepted for ${result.scenario} @ ${result.hz}Hz: ${result.acceptedPlacements}/${result.placementAttempts}`);
    }
    if (result.fallingUpdates <= 0 || result.waterCellUpdates <= 0 || result.weatherUpdates <= 0) {
      throw new Error(`Scenario activity missing for ${result.scenario} @ ${result.hz}Hz: falling=${result.fallingUpdates}, water=${result.waterCellUpdates}, weather=${result.weatherUpdates}`);
    }
    if (!Number.isFinite(result.perTickMs.p95) || result.perTickMs.p95 >= 16.7) {
      throw new Error(`Publication benchmark p95 exceeded 16.7ms for ${result.scenario} @ ${result.hz}Hz: ${result.perTickMs.p95}ms`);
    }
    if (!Number.isFinite(result.payloadBytes.p95) || result.payloadBytes.p95 > result.payloadBudgetBytes) {
      throw new Error(`Publication payload p95 exceeded ${result.payloadBudgetBytes} bytes for ${result.scenario} @ ${result.hz}Hz: ${result.payloadBytes.p95}`);
    }
    const scenarioDigests = byScenario.get(result.scenario) ?? new Set();
    scenarioDigests.add(result.digest);
    byScenario.set(result.scenario, scenarioDigests);
  }

  for (const [scenario, digests] of byScenario) {
    if (digests.size !== 1) {
      throw new Error(`Publication cadence digests diverged for ${scenario}: ${Array.from(digests).join(", ")}`);
    }
  }
}

function main() {
  if (typeof global.gc !== "function") {
    throw new Error("Benchmark requires node --expose-gc. Re-run with: node --expose-gc ./scripts/benchmark-shared.mjs");
  }
  const results = runBenchmark();
  assertBenchmarkResults(results);

  for (const result of results) {
    console.log(JSON.stringify(result));
  }

  const toMs = (value) => value.toFixed(4);
  const toKb = (bytes) => (bytes / 1024).toFixed(1);
  console.error("\nBenchmark summary (6-tick windowed per-tick latency):");
  console.error(
    ["scenario", "pubHz", "p50ms", "p95ms", "meanms", "payloadP95KB", "falling", "placements", "runtimeMs", "digest"]
      .map((header) => header.padStart(13))
      .join(" "),
  );
  for (const result of results) {
    console.error(
      [
        result.scenario,
        String(result.hz),
        toMs(result.perTickMs.p50),
        toMs(result.perTickMs.p95),
        toMs(result.perTickMs.mean),
        toKb(result.payloadBytes.p95),
        String(result.fallingUpdates),
        `${result.acceptedPlacements}/${result.placementAttempts}`,
        result.runtimeMs.toFixed(0),
        result.digest.slice(0, 12),
      ].map((cell) => cell.padStart(13)).join(" "),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file://"))) {
  main();
}
