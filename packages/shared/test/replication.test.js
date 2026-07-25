import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceWorldTick,
  allocateObjectId,
  createCommandEnvelope,
  createDefaultFallingObjectState,
  createDefaultPlayerState,
  createDefaultWorldState,
  createWorldSnapshot,
  restoreWorldState,
  decodeWorldDelta,
  applyWorldDeltaToSnapshot,
  applyWorldDeltaStream,
  computeWorldChecksum,
  createPlayerId,
  deserializeWorldState,
  Grid,
  MaterialId,
  normalizePlayerInput,
  processCommand,
  serializeWorldState,
  createObjectId,
} from "@particle-sim/shared";

function createWeatherDeltaState() {
  return {
    kind: "storm",
    episodeElapsed: 12,
    episodeDuration: 30,
    wind: 1.25,
    visualTime: 9.5,
    rainAccumulator: 1.5,
    lightningFlash: 4,
    lightningCooldown: 3,
    boltX: 2,
    boltY: 7,
    boltSeed: 99,
  };
}

test("dirty tracking is independent from simulation updated flags", () => {
  const world = createDefaultWorldState("room_dirty");
  assert.equal(world.grid.dirtyCells.size, 0);
  world.grid.set(1, 1, MaterialId.Stone);
  assert.equal(world.grid.dirtyCells.size, 1);
  assert.equal(world.grid.wasUpdated(1, 1), false);
  world.grid.markUpdated(1, 1);
  assert.equal(world.grid.wasUpdated(1, 1), true);
  assert.equal(world.grid.dirtyCells.size, 1);
});

test("repeated writes coalesce into a single dirty journal entry", () => {
  const world = createDefaultWorldState("room_coalesce");
  world.grid.set(0, 0, MaterialId.Water);
  world.grid.set(0, 0, MaterialId.Stone);
  world.grid.set(0, 0, MaterialId.Stone, { shade: 5 });
  assert.equal(world.grid.dirtyCells.size, 1);
  const flushed = world.grid.dirtyCells.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].index, 0);
  assert.equal(flushed[0].materialId, MaterialId.Stone);
  assert.equal(flushed[0].shade, 5);
  assert.equal(flushed[0].revision, 3);
  assert.deepEqual(world.grid.dirtyCells.readPending(), []);
});

test("full snapshots round-trip to an identical checksum", () => {
  const world = createDefaultWorldState("room_snapshot");
  const playerId = createPlayerId("player_1");
  world.players[playerId] = {
    id: playerId,
    x: 3,
    y: 4,
    vx: 1,
    vy: 0,
    width: 3,
    height: 5,
    grounded: true,
    facing: 1,
    airTime: 2,
    airTicks: 2,
    previousJumpHeld: false,
    swingElapsedTicks: null,
    faucetCooldownUntilTick: 0,
    crouching: false,
    lookingUp: true,
    swimming: false,
    input: { left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: false },
    inventory: { flowers: 2, stone: 4 },
    hotbar: [{ kind: "material", materialId: MaterialId.Stone, count: 2 }, ...Array(9).fill({ kind: "empty" })],
    activeHotbarSlot: 0,
    inventoryRevision: 2,
    pendingRefunds: {},
  };
  world.grid.set(1, 1, MaterialId.Water);
  world.grid.set(2, 2, MaterialId.Flower, { shade: 7 });
  world.weather = { ...world.weather, ...createWeatherDeltaState() };
  const snapshot = createWorldSnapshot(world);
  const restored = restoreWorldState(snapshot);
  const roundTripSnapshot = createWorldSnapshot(restored);
  assert.equal(roundTripSnapshot.checksum, snapshot.checksum);
  assert.equal(restored.grid.get(1, 1), MaterialId.Water);
  assert.equal(restored.players[playerId].inventory.stone, 4);
  assert.equal(restored.weather.kind, "storm");
});

test("tampered snapshots are rejected without mutating the caller-owned payload", () => {
  const world = createDefaultWorldState("room_tampered_snapshot");
  const snapshot = createWorldSnapshot(world);
  const originalSnapshot = JSON.parse(JSON.stringify(snapshot));

  const checksumTampered = JSON.parse(JSON.stringify(snapshot));
  checksumTampered.checksum = "not-the-real-checksum";
  const checksumTamperedBeforeRestore = JSON.parse(JSON.stringify(checksumTampered));
  assert.throws(() => restoreWorldState(checksumTampered), /checksum/i);
  assert.deepEqual(checksumTampered, checksumTamperedBeforeRestore);

  const revisionTampered = JSON.parse(JSON.stringify(snapshot));
  revisionTampered.worldRevision += 1;
  const revisionTamperedBeforeRestore = JSON.parse(JSON.stringify(revisionTampered));
  assert.throws(() => restoreWorldState(revisionTampered), /worldRevision/i);
  assert.deepEqual(revisionTampered, revisionTamperedBeforeRestore);

  const schemaTampered = JSON.parse(JSON.stringify(snapshot));
  schemaTampered.worldState.schemaVersion += 1;
  const schemaTamperedBeforeRestore = JSON.parse(JSON.stringify(schemaTampered));
  assert.throws(() => restoreWorldState(schemaTampered), /schemaVersion/i);
  assert.deepEqual(schemaTampered, schemaTamperedBeforeRestore);

  const invalidDeltaSnapshot = JSON.parse(JSON.stringify(snapshot));
  const invalidDelta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [{ index: 0, materialId: MaterialId.Stone, shade: 0, auxiliary: 0, objectId: null, revision: 1 }],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  const invalidDeltaSnapshotBeforeApply = JSON.parse(JSON.stringify(invalidDeltaSnapshot));
  assert.throws(() => applyWorldDeltaToSnapshot(invalidDeltaSnapshot, invalidDelta), /objectId/i);
  assert.deepEqual(invalidDeltaSnapshot, invalidDeltaSnapshotBeforeApply);
});

test("applyWorldDeltaToSnapshot rejects placed-vs-falling object ID collisions", () => {
  const world = createDefaultWorldState("room_object_collision");
  const fallingObjectId = createObjectId("object_falling");
  world.fallingObjects[fallingObjectId] = createDefaultFallingObjectState(fallingObjectId, MaterialId.Stone, 0, 0, 0, 0, []);
  const snapshot = createWorldSnapshot(world);
  const snapshotBeforeApply = JSON.parse(JSON.stringify(snapshot));
  const delta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [{ index: 0, materialId: MaterialId.Stone, shade: 0, auxiliary: 0, objectId: fallingObjectId, revision: 1 }],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => applyWorldDeltaToSnapshot(snapshot, delta), /object/i);
  assert.deepEqual(snapshot, snapshotBeforeApply);
});

test("delta envelope IDs must match inner state IDs and leave the snapshot unchanged", () => {
  const world = createDefaultWorldState("room_id_mismatch");
  const playerId = createPlayerId("player_env");
  world.players[playerId] = {
    id: playerId,
    x: 1,
    y: 2,
    vx: 0,
    vy: 0,
    width: 3,
    height: 5,
    grounded: false,
    facing: 1,
    airTime: 0,
    airTicks: 0,
    previousJumpHeld: false,
    swingElapsedTicks: null,
    faucetCooldownUntilTick: 0,
    crouching: false,
    lookingUp: false,
    swimming: false,
    input: { left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: false },
    inventory: { flowers: 0 },
    hotbar: Array(10).fill({ kind: "empty" }),
    activeHotbarSlot: 0,
    inventoryRevision: 0,
    pendingRefunds: {},
  };
  const fallingObjectId = createObjectId("object_env");
  world.fallingObjects[fallingObjectId] = createDefaultFallingObjectState(fallingObjectId, MaterialId.Stone, 0, 0, 0, 0, []);
  const snapshot = createWorldSnapshot(world);
  const snapshotBeforeApply = JSON.parse(JSON.stringify(snapshot));

  const mismatchedPlayerDelta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [],
    players: [{ playerId, state: { ...world.players[playerId], id: createPlayerId("player_state") } }],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => decodeWorldDelta(mismatchedPlayerDelta), /playerId/i);
  const playerApplySnapshot = JSON.parse(JSON.stringify(snapshot));
  assert.throws(() => applyWorldDeltaToSnapshot(playerApplySnapshot, mismatchedPlayerDelta), /playerId/i);
  assert.deepEqual(playerApplySnapshot, snapshotBeforeApply);

  const mismatchedFallingObjectDelta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [],
    players: [],
    fallingObjects: [{ objectId: fallingObjectId, state: createDefaultFallingObjectState(createObjectId("object_state"), MaterialId.Stone, 0, 0, 0, 0, []) }],
    metadata: [],
  };
  assert.throws(() => decodeWorldDelta(mismatchedFallingObjectDelta), /objectId/i);
  const fallingObjectApplySnapshot = JSON.parse(JSON.stringify(snapshot));
  assert.throws(() => applyWorldDeltaToSnapshot(fallingObjectApplySnapshot, mismatchedFallingObjectDelta), /objectId/i);
  assert.deepEqual(fallingObjectApplySnapshot, snapshotBeforeApply);
});

test("delta decoding rejects brush cells carrying an object ID", () => {
  const delta = {
    version: 1,
    baseRevision: 0,
    targetRevision: 1,
    cells: [{ index: 0, materialId: MaterialId.Water, shade: 0, auxiliary: 0, objectId: createObjectId("object_brush_object"), revision: 1 }],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => decodeWorldDelta(delta), /objectId/i);
});

test("ordered deltas converge from a checkpoint to the authoritative checksum", () => {
  const world = createDefaultWorldState("room_delta");
  const playerId = createPlayerId("player_9");
  world.players[playerId] = {
    id: playerId,
    x: 1,
    y: 2,
    vx: 0,
    vy: 0,
    width: 3,
    height: 5,
    grounded: false,
    facing: -1,
    airTime: 0,
    airTicks: 0,
    previousJumpHeld: false,
    swingElapsedTicks: null,
    faucetCooldownUntilTick: 0,
    crouching: false,
    lookingUp: false,
    swimming: false,
    input: { left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: false },
    inventory: { flowers: 0 },
    hotbar: Array(10).fill({ kind: "empty" }),
    activeHotbarSlot: 0,
    inventoryRevision: 0,
    pendingRefunds: {},
  };
  const checkpointSnapshot = createWorldSnapshot(world);
  const delta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [{ index: 5, materialId: MaterialId.Water, shade: 3, auxiliary: 1, objectId: null, revision: 1 }],
    players: [{ playerId: playerId, state: { ...world.players[playerId], x: 7, y: 8, inventory: { flowers: 1, stone: 2 } } }],
    fallingObjects: [],
    metadata: [{ field: "weather", value: createWeatherDeltaState() }],
  };
  const applied = applyWorldDeltaToSnapshot(checkpointSnapshot, delta);
  const expectedWorld = restoreWorldState(checkpointSnapshot);
  const expectedCellX = 5 % expectedWorld.grid.width;
  const expectedCellY = Math.floor(5 / expectedWorld.grid.width);
  const expectedCellIndex = expectedWorld.grid.index(expectedCellX, expectedCellY);
  expectedWorld.grid.ids[expectedCellIndex] = MaterialId.Water;
  expectedWorld.grid.shade[expectedCellIndex] = 3;
  expectedWorld.grid.auxiliary[expectedCellIndex] = 1;
  expectedWorld.grid.cellRevisions[expectedCellIndex] = 1;
  expectedWorld.players[playerId].x = 7;
  expectedWorld.players[playerId].y = 8;
  expectedWorld.players[playerId].inventory = { flowers: 1, stone: 2 };
  expectedWorld.weather = createWeatherDeltaState();
  expectedWorld.worldRevision = 1;
  const expectedSnapshot = createWorldSnapshot(expectedWorld);
  assert.equal(applied.checksum, expectedSnapshot.checksum);
});

test("duplicate, out-of-order, and late deltas are rejected", () => {
  const world = createDefaultWorldState("room_delta_reject");
  const snapshot = createWorldSnapshot(world);
  const malformedDelta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [
      { index: 0, materialId: MaterialId.Water, shade: 0, auxiliary: 0, objectId: null, revision: 1 },
      { index: 0, materialId: MaterialId.Water, shade: 0, auxiliary: 0, objectId: null, revision: 1 },
    ],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => decodeWorldDelta(malformedDelta), /duplicate/i);
  const staleDelta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    cells: [{ index: 1, materialId: MaterialId.Dirt, shade: 1, auxiliary: 0, objectId: null, revision: 0 }],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => applyWorldDeltaToSnapshot(snapshot, staleDelta), /stale/i);
  const lateDelta = {
    version: 1,
    baseRevision: world.worldRevision + 5,
    targetRevision: world.worldRevision + 6,
    cells: [],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => applyWorldDeltaToSnapshot(snapshot, lateDelta), /checkpoint revision/i);
});

test("invalid dimensions, indices, and revisions are rejected atomically", () => {
  const world = createDefaultWorldState("room_invalid");
  const snapshot = createWorldSnapshot(world);
  const invalidDelta = {
    version: 1,
    baseRevision: world.worldRevision,
    targetRevision: world.worldRevision + 1,
    gridDimensions: { width: 99, height: 99 },
    cells: [{ index: 999_999, materialId: MaterialId.Water, shade: 0, auxiliary: 0, objectId: null, revision: 1 }],
    players: [],
    fallingObjects: [],
    metadata: [],
  };
  assert.throws(() => applyWorldDeltaToSnapshot(snapshot, invalidDelta), /dimensions|bounds|stale/i);
  const unchanged = createWorldSnapshot(restoreWorldState(snapshot));
  assert.equal(unchanged.checksum, snapshot.checksum);
});

test("heavy water/weather mutation and late snapshot delta application converge", () => {
  const world = createDefaultWorldState("room_heavy");
  for (let index = 0; index < 20; index += 1) {
    world.grid.set(index % world.grid.width, Math.floor(index / world.grid.width), MaterialId.Water);
  }
  world.weather = createWeatherDeltaState();
  world.tick += 7;
  const snapshot = createWorldSnapshot(world);
  const delta = {
    version: 1,
    baseRevision: 1,
    targetRevision: 2,
    cells: [{ index: 20, materialId: MaterialId.Water, shade: 0, auxiliary: 2, objectId: null, revision: 1 }],
    players: [],
    fallingObjects: [],
    metadata: [{ field: "weather", value: createWeatherDeltaState() }],
  };
  assert.throws(() => applyWorldDeltaToSnapshot(snapshot, delta), /checkpoint revision/i);
  const mutatedWorld = restoreWorldState(snapshot);
  const mutatedCellIndex = 1 + 1 * mutatedWorld.grid.width;
  mutatedWorld.grid.ids[mutatedCellIndex] = MaterialId.Water;
  mutatedWorld.grid.shade[mutatedCellIndex] = 0;
  mutatedWorld.grid.auxiliary[mutatedCellIndex] = 2;
  mutatedWorld.grid.cellRevisions[mutatedCellIndex] = 2;
  mutatedWorld.weather = createWeatherDeltaState();
  mutatedWorld.worldRevision = 1;
  const expectedSnapshot = createWorldSnapshot(mutatedWorld);
  const deltaFromBase = {
    version: 1,
    baseRevision: 0,
    targetRevision: 1,
    cells: [{ index: mutatedCellIndex, materialId: MaterialId.Water, shade: 0, auxiliary: 2, objectId: null, revision: 2 }],
    players: [],
    fallingObjects: [],
    metadata: [{ field: "weather", value: createWeatherDeltaState() }],
  };
  const baseWorld = createDefaultWorldState("room_heavy_base");
  for (let index = 0; index < 20; index += 1) {
    baseWorld.grid.set(index % baseWorld.grid.width, Math.floor(index / baseWorld.grid.width), MaterialId.Water);
  }
  baseWorld.tick = world.tick;
  baseWorld.roomId = world.roomId;
  baseWorld.worldRevision = 0;
  const applied = applyWorldDeltaToSnapshot(createWorldSnapshot(baseWorld), deltaFromBase);
  assert.equal(applied.worldState.grid.ids[1 + 1 * applied.worldState.grid.width], MaterialId.Water);
  assert.equal(applied.worldState.grid.auxiliary[1 + 1 * applied.worldState.grid.width], 2);
  assert.equal(applied.worldState.weather.kind, "storm");
  assert.equal(expectedSnapshot.checksum, createWorldSnapshot(restoreWorldState(applied)).checksum);
});

test("snapshot restores object membership and allocator correctness", () => {
  const world = createDefaultWorldState("room_objects");
  const firstObjectId = allocateObjectId(world);
  const secondObjectId = allocateObjectId(world);
  world.grid.set(1, 2, MaterialId.Stone, { objectId: firstObjectId });
  world.grid.set(2, 2, MaterialId.Stone, { objectId: firstObjectId });
  world.grid.set(3, 2, MaterialId.Wood, { objectId: secondObjectId });
  const snapshot = createWorldSnapshot(world);
  const restored = restoreWorldState(snapshot);
  assert.equal(restored.grid.getObjectId(1, 2), firstObjectId);
  assert.equal(restored.grid.getObjectId(2, 2), firstObjectId);
  assert.equal(restored.grid.getObjectId(3, 2), secondObjectId);
  const nextObjectId = allocateObjectId(restored);
  assert.notEqual(nextObjectId, firstObjectId);
  assert.notEqual(nextObjectId, secondObjectId);
  const nextSnapshot = createWorldSnapshot(restored);
  const rebuilt = restoreWorldState(nextSnapshot);
  assert.equal(rebuilt.grid.getObjectId(1, 2), firstObjectId);
  assert.equal(rebuilt.grid.getObjectId(3, 2), secondObjectId);
});

function buildReplayFixture() {
  const world = createDefaultWorldState("room_deterministic_replay", new Grid(48, 24));
  world.random.seed = 0x5eed_1234;
  world.random.state = world.random.seed;
  const actorId = createPlayerId("player_replay_fixture");
  world.players[actorId] = createDefaultPlayerState(actorId);
  const player = world.players[actorId];
  player.x = 8;
  player.y = 10;
  player.width = 3;
  player.height = 5;
  player.grounded = true;
  player.facing = 1;
  player.hotbar = [
    { kind: "pickaxe" },
    { kind: "material", materialId: MaterialId.Stone, count: 2 },
    { kind: "material", materialId: MaterialId.Flower, count: 2 },
    { kind: "material", materialId: MaterialId.Faucet, count: 1 },
    { kind: "material", materialId: MaterialId.Water, count: 2 },
    ...Array(5).fill({ kind: "empty" }),
  ];
  player.activeHotbarSlot = 1;
  for (let x = 0; x < world.grid.width; x += 1) {
    world.grid.set(x, 16, MaterialId.Dirt);
  }
  for (let x = 8; x < 12; x += 1) {
    world.grid.set(x, 13, MaterialId.Water);
  }
  for (let x = 3; x < 6; x += 1) {
    world.grid.set(x, 13, MaterialId.Stone);
  }
  world.weather.kind = "rain";
  world.weather.episodeDuration = 19;
  world.weather.wind = 1;
  world.weather.visualTime = 0.75;
  world.time.dayNightTick = 3500;
  return { world, actorId };
}

function enqueueReplayCommand(world, actorId, command, issuedTick = world.tick) {
  const actorSequence = (world.commandLedger.actorHighWater[actorId] ?? 0) + 1;
  const envelope = createCommandEnvelope(actorId, actorSequence, issuedTick, command);
  return processCommand(world, envelope);
}

function advanceActorTick(world, actorId, overrides = {}, steps = 1) {
  const baseInput = normalizePlayerInput(world.players[actorId].input);
  const mergedInput = { ...baseInput, ...overrides };
  for (let index = 0; index < steps; index += 1) {
    advanceWorldTick(world, { [actorId]: mergedInput });
  }
}

function runReplayFixture(world, actorId, options = {}) {
  const stopAfterCheckpoint = options.stopAfterCheckpoint ?? Number.POSITIVE_INFINITY;
  const startAtCheckpoint = options.startAtCheckpoint ?? 0;
  const checkpoints = [];
  const captureCheckpoint = () => {
    checkpoints.push({ tick: world.tick, checksum: computeWorldChecksum(world) });
    return checkpoints.length >= stopAfterCheckpoint;
  };

  const steps = [
    () => {
      const moveResult = enqueueReplayCommand(world, actorId, { type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });
      assert.equal(moveResult.kind, "accepted");
      advanceActorTick(world, actorId, { left: true }, 4);
    },
    () => {
      const mineStart = enqueueReplayCommand(world, actorId, { type: "mine_start" });
      assert.equal(mineStart.kind, "accepted");
      advanceActorTick(world, actorId, { mineHeld: true, left: true }, 8);
    },
    () => {
      const mineStop = enqueueReplayCommand(world, actorId, { type: "mine_stop" });
      assert.equal(mineStop.kind, "accepted");

      const selectFlowerSlot = enqueueReplayCommand(world, actorId, { type: "select_slot", slot: 2, expectedInventoryRevision: world.players[actorId].inventoryRevision });
      assert.equal(selectFlowerSlot.kind, "accepted");
      const placeFlower = enqueueReplayCommand(world, actorId, { type: "place", x: 20, y: 13, brushRadius: 1, expectedInventoryRevision: world.players[actorId].inventoryRevision, expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(20, 13)] ?? 0 });
      assert.equal(placeFlower.kind, "accepted");
      const harvestTargetX = 20;
      assert.equal(world.grid.get(harvestTargetX, 12), MaterialId.Flower);
      const harvestTargetY = 12;
      const harvestFlower = enqueueReplayCommand(world, actorId, { type: "harvest", x: harvestTargetX, y: harvestTargetY, expectedTargetRevision: world.grid.cellRevisions[world.grid.index(harvestTargetX, harvestTargetY)] ?? 0 });
      assert.equal(harvestFlower.kind, "accepted");
    },
    () => {
      const selectFaucetSlot = enqueueReplayCommand(world, actorId, { type: "select_slot", slot: 3, expectedInventoryRevision: world.players[actorId].inventoryRevision });
      assert.equal(selectFaucetSlot.kind, "accepted");
      const placeFaucet = enqueueReplayCommand(world, actorId, { type: "place", x: 24, y: 10, brushRadius: 1, expectedInventoryRevision: world.players[actorId].inventoryRevision, expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(24, 10)] ?? 0 });
      assert.equal(placeFaucet.kind, "accepted");
      const faucetObjectId = world.grid.getObjectId(24, 10);
      assert.ok(faucetObjectId);
      const cycleFaucet = enqueueReplayCommand(world, actorId, { type: "cycle_faucet", x: 24, y: 10, objectId: faucetObjectId, expectedTargetRevision: world.grid.cellRevisions[world.grid.index(24, 10)] ?? 0 });
      assert.equal(cycleFaucet.kind, "accepted");

      const selectWaterSlot = enqueueReplayCommand(world, actorId, { type: "select_slot", slot: 4, expectedInventoryRevision: world.players[actorId].inventoryRevision });
      assert.equal(selectWaterSlot.kind, "accepted");
      const placeWater = enqueueReplayCommand(world, actorId, { type: "place", x: 18, y: 13, brushRadius: 1, expectedInventoryRevision: world.players[actorId].inventoryRevision, expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(18, 13)] ?? 0 });
      assert.equal(placeWater.kind, "accepted");
      advanceActorTick(world, actorId, { left: true, jumpHeld: true }, 5);
    },
    () => {
      const setNight = enqueueReplayCommand(world, actorId, { type: "set_time_preset", preset: "night", expectedWorldRevision: world.worldRevision });
      assert.equal(setNight.kind, "accepted");
      advanceActorTick(world, actorId, {}, 6);
    },
  ];

  for (let index = startAtCheckpoint; index < steps.length; index += 1) {
    steps[index]();
    if (captureCheckpoint()) {
      return { checkpoints, checksum: computeWorldChecksum(world) };
    }
  }

  return { checkpoints, checksum: computeWorldChecksum(world) };
}

test("deterministic replay fixtures converge across replay and checkpoint restore", () => {
  const first = buildReplayFixture();
  const second = buildReplayFixture();
  const firstRun = runReplayFixture(first.world, first.actorId);
  const secondRun = runReplayFixture(second.world, second.actorId);

  assert.deepEqual(firstRun.checkpoints, secondRun.checkpoints);
  assert.equal(firstRun.checksum, secondRun.checksum);
  assert.equal(typeof firstRun.checkpoints[0].checksum, "string");
  assert.ok(firstRun.checkpoints[0].checksum.length > 0);
  assert.equal(firstRun.checkpoints[0].tick, 4);
  assert.equal(firstRun.checkpoints[1].tick, 12);
  assert.equal(firstRun.checkpoints[2].tick, 12);
  assert.equal(firstRun.checkpoints[3].tick, 17);
  assert.equal(firstRun.checkpoints[4].tick, 23);

  const checkpointWorld = buildReplayFixture();
  const checkpointRun = runReplayFixture(checkpointWorld.world, checkpointWorld.actorId, { stopAfterCheckpoint: 2 });
  assert.equal(checkpointRun.checkpoints.length, 2);
  assert.equal(checkpointRun.checkpoints[1].tick, 12);
  const snapshot = createWorldSnapshot(checkpointWorld.world);
  const restored = restoreWorldState(snapshot);
  const continueFromSnapshot = buildReplayFixture();
  const restoreOnly = runReplayFixture(restored, checkpointWorld.actorId, { startAtCheckpoint: 2 });
  const uninterrupted = runReplayFixture(continueFromSnapshot.world, continueFromSnapshot.actorId);
  assert.equal(restoreOnly.checksum, uninterrupted.checksum);
});
