import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateObjectId,
  createDefaultWorldState,
  createWorldSnapshot,
  restoreWorldState,
  decodeWorldDelta,
  applyWorldDeltaToSnapshot,
  applyWorldDeltaStream,
  computeWorldChecksum,
  MaterialId,
  createObjectId,
  createPlayerId,
  serializeWorldState,
  deserializeWorldState,
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
      { index: 0, materialId: MaterialId.Stone, shade: 0, auxiliary: 0, objectId: null, revision: 1 },
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
    cells: [{ index: 999_999, materialId: MaterialId.Stone, shade: 0, auxiliary: 0, objectId: null, revision: 1 }],
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
