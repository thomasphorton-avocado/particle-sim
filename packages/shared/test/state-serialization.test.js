import test from "node:test";
import assert from "node:assert/strict";
import { FLOWER_PALETTE, Grid, MaterialId, allocateObjectId, allocatePlayerId, createDefaultWorldState, createObjectId, createPlayerId, createStarterWorld, deserializeWorldState, serializeWorldState } from "@particle-sim/shared";

function createValidWorldDto(overrides = {}) {
  return {
    schemaVersion: 2,
    roomId: "room_test",
    grid: {
      width: 4,
      height: 4,
      ids: Array(16).fill(MaterialId.Empty),
      shade: Array(16).fill(0),
      auxiliary: Array(16).fill(0),
      objectMembership: [],
    },
    players: {},
    fallingObjects: {},
    paused: false,
    time: { dayNightCycle: 0.25 },
    weather: { kind: "clear", episodeElapsed: 0, episodeDuration: 0, wind: 0, visualTime: 0, rainAccumulator: 0, lightningFlash: null, lightningCooldown: null, boltX: null, boltY: null, boltSeed: 0 },
    random: { algorithm: "mulberry32-v1", seed: 0, state: 0 },
    nextPlayerOrdinal: 1,
    nextObjectOrdinal: 1,
    ...overrides,
  };
}

test("inventory and hotbar stay independent across players", () => {
  const world = createDefaultWorldState("room_test");
  const playerA = createPlayerId("player_1");
  const playerB = createPlayerId("player_2");
  const stateA = { id: playerA, x: 0, y: 0, vx: 0, vy: 0, width: 3, height: 5, grounded: false, facing: 1, airTime: 0, crouching: false, lookingUp: false, swimming: false, inventory: { flowers: 0 }, hotbar: [{ kind: "material", materialId: MaterialId.Seed, count: 1 }, ...Array(9).fill({ kind: "empty" })], activeHotbarSlot: 0 };
  const stateB = { id: playerB, x: 0, y: 0, vx: 0, vy: 0, width: 3, height: 5, grounded: false, facing: 1, airTime: 0, crouching: false, lookingUp: false, swimming: false, inventory: { flowers: 0 }, hotbar: [{ kind: "empty" }, ...Array(9).fill({ kind: "empty" })], activeHotbarSlot: 0 };
  world.players[playerA] = stateA;
  world.players[playerB] = stateB;
  stateA.inventory.flowers += 1;
  stateA.hotbar[0] = { kind: "material", materialId: MaterialId.Torch, count: 4 };
  assert.equal(stateA.inventory.flowers, 1);
  assert.equal(stateB.inventory.flowers, 0);
  assert.equal(stateA.hotbar[0].kind, "material");
  assert.equal(stateB.hotbar[0].kind, "empty");
});

test("adjacent same-material objects receive distinct IDs and can be cleared independently", () => {
  const world = createDefaultWorldState("room_test");
  const grid = world.grid;
  const leftId = allocateObjectId(world);
  const rightId = allocateObjectId(world);
  grid.set(1, 1, MaterialId.Stone, { objectId: leftId });
  grid.set(2, 1, MaterialId.Stone, { objectId: rightId });
  assert.equal(grid.getObjectId(1, 1), leftId);
  assert.equal(grid.getObjectId(2, 1), rightId);
  grid.clearObjectById(leftId);
  assert.equal(grid.get(1, 1), MaterialId.Empty);
  assert.equal(grid.get(2, 1), MaterialId.Stone);
});

test("falling-to-placed transition preserves object ID", () => {
  const world = createDefaultWorldState("room_test");
  const objectId = allocateObjectId(world);
  world.fallingObjects[objectId] = { id: objectId, materialId: MaterialId.Torch, x: 3, y: 1, restY: 4, vy: 0, offsets: [[0, 0]] };
  const grid = world.grid;
  grid.set(3, 4, MaterialId.Empty);
  const targetY = 4;
  const landingCell = grid.getCellForObjectId(objectId);
  assert.equal(landingCell, null);
  grid.set(3, 4, MaterialId.Torch, { objectId });
  assert.equal(grid.getObjectId(3, 4), objectId);
});

test("serialize and deserialize preserves world state", () => {
  const world = createDefaultWorldState("room_roundtrip");
  const playerId = allocatePlayerId(world);
  const player = { id: playerId, x: 3, y: 4, vx: 1, vy: 2, width: 3, height: 5, grounded: true, facing: -1, airTime: 2, crouching: false, lookingUp: true, swimming: false, inventory: { flowers: 2, stone: 4 }, hotbar: [{ kind: "material", materialId: MaterialId.Stone, count: 2 }, ...Array(9).fill({ kind: "empty" })], activeHotbarSlot: 0 };
  world.players[player.id] = player;
  const objectId = allocateObjectId(world);
  world.fallingObjects[objectId] = { id: objectId, materialId: MaterialId.Stone, x: 2, y: 1, restY: 5, vy: 0, offsets: [[0, 0], [1, 0]] };
  world.grid.set(1, 1, MaterialId.Dirt);
  world.grid.set(2, 1, MaterialId.Water);
  world.grid.set(1, 1, MaterialId.Stone, { objectId: createObjectId("object_99") });
  const dto = serializeWorldState(world);
  const restored = deserializeWorldState(dto);
  assert.equal(restored.roomId, "room_roundtrip");
  assert.equal(restored.grid.width, world.grid.width);
  assert.equal(restored.grid.get(1, 1), MaterialId.Stone);
  assert.equal(restored.players[playerId].inventory.stone, 4);
  assert.equal(restored.fallingObjects[objectId].materialId, MaterialId.Stone);
  assert.equal(restored.weather.kind, "clear");
  assert.equal(restored.nextPlayerOrdinal, world.nextPlayerOrdinal);
  assert.equal(restored.nextObjectOrdinal, world.nextObjectOrdinal);
});

test("allocation after restore never reuses an ID", () => {
  const dto = {
    schemaVersion: 1,
    roomId: "room_restore",
    grid: { width: 4, height: 4, ids: Array(16).fill(0), shade: Array(16).fill(0), auxiliary: Array(16).fill(0), objectMembership: [] },
    players: {},
    fallingObjects: {},
    paused: false,
    time: { dayNightCycle: 0.25 },
    weather: { kind: "clear", episodeElapsed: 0, episodeDuration: 0, wind: 0, visualTime: 0, rainAccumulator: 0, lightningFlash: null, lightningCooldown: null, boltX: null, boltY: null, boltSeed: 0 },
    random: { algorithm: "mulberry32-v1", seed: 0, state: 0 },
    nextPlayerOrdinal: 3,
    nextObjectOrdinal: 3,
  };
  const restored = deserializeWorldState(dto);
  const first = allocatePlayerId(restored);
  const second = allocateObjectId(restored);
  assert.equal(first, "player_3");
  assert.equal(second, "object_3");
});

test("multi-cell object identities survive a round-trip", () => {
  const world = createDefaultWorldState("room_multi");
  const stoneId = allocateObjectId(world);
  const woodId = allocateObjectId(world);
  const faucetId = allocateObjectId(world);
  const drainId = allocateObjectId(world);
  world.grid.set(1, 1, MaterialId.Stone, { objectId: stoneId });
  world.grid.set(2, 1, MaterialId.Stone, { objectId: stoneId });
  world.grid.set(3, 1, MaterialId.Wood, { objectId: woodId });
  world.grid.set(1, 2, MaterialId.Faucet, { objectId: faucetId });
  world.grid.set(2, 2, MaterialId.Drain, { objectId: drainId });
  const restored = deserializeWorldState(serializeWorldState(world));
  assert.equal(restored.grid.getObjectId(1, 1), stoneId);
  assert.equal(restored.grid.getObjectId(2, 1), stoneId);
  assert.equal(restored.grid.getObjectId(3, 1), woodId);
  assert.equal(restored.grid.getObjectId(1, 2), faucetId);
  assert.equal(restored.grid.getObjectId(2, 2), drainId);
});

test("fractional falling y round-trips and non-object falling materials are rejected", () => {
  const world = createDefaultWorldState("room_falling");
  const objectId = allocateObjectId(world);
  world.fallingObjects[objectId] = { id: objectId, materialId: MaterialId.Stone, x: 4, y: 1.75, restY: 6, vy: 0.25, offsets: [[0, 0], [1, 0]] };
  const restored = deserializeWorldState(serializeWorldState(world));
  assert.equal(restored.fallingObjects[objectId].y, 1.75);
  assert.throws(() => deserializeWorldState(createValidWorldDto({
    fallingObjects: {
      object_1: { id: "object_1", materialId: MaterialId.Water, x: 0, y: 0, restY: 0, vy: 0, offsets: [[0, 0]] },
    },
  })), /object material/i);
});

test("semantic auxiliary values are validated during deserialization", () => {
  assert.throws(() => deserializeWorldState(createValidWorldDto({
    grid: { width: 1, height: 1, ids: [MaterialId.Water], shade: [0], auxiliary: [127], objectMembership: [] },
  })), /water/i);
  assert.throws(() => deserializeWorldState(createValidWorldDto({
    grid: { width: 1, height: 1, ids: [MaterialId.Flower], shade: [0], auxiliary: [FLOWER_PALETTE.length], objectMembership: [] },
  })), /flower/i);
  assert.throws(() => deserializeWorldState(createValidWorldDto({
    grid: { width: 1, height: 1, ids: [MaterialId.Stone], shade: [0], auxiliary: [1], objectMembership: [] },
  })), /auxiliary/i);
});

test("serialization DTO mutations do not mutate world state", () => {
  const world = createDefaultWorldState("room_mutation");
  const playerId = allocatePlayerId(world);
  world.players[playerId] = { id: playerId, x: 0, y: 0, vx: 0, vy: 0, width: 3, height: 5, grounded: false, facing: 1, airTime: 0, crouching: false, lookingUp: false, swimming: false, inventory: { flowers: 0 }, hotbar: [{ kind: "material", materialId: MaterialId.Stone, count: 2 }, ...Array(9).fill({ kind: "empty" })], activeHotbarSlot: 0 };
  const objectId = allocateObjectId(world);
  world.fallingObjects[objectId] = { id: objectId, materialId: MaterialId.Stone, x: 1, y: 2.5, restY: 4, vy: 0.5, offsets: [[0, 0]] };
  const dto = serializeWorldState(world);
  dto.players[playerId].inventory.flowers += 1;
  dto.players[playerId].hotbar[0] = { kind: "empty" };
  dto.fallingObjects[objectId].offsets[0][0] += 1;
  dto.fallingObjects[objectId].y += 1;
  dto.grid.auxiliary[0] = 1;
  dto.random.state += 1;
  assert.equal(world.players[playerId].inventory.flowers, 0);
  assert.equal(world.players[playerId].hotbar[0].kind, "material");
  assert.equal(world.fallingObjects[objectId].offsets[0][0], 0);
  assert.equal(world.fallingObjects[objectId].y, 2.5);
  assert.equal(world.grid.auxiliary[0], 0);
  assert.equal(world.random.state, 0);
});

test("serialization uses deterministic code-unit ordering for canonical JSON", () => {
  const world = createDefaultWorldState("room_canonical");
  const playerIds = ["player_i", "player_I", "player_1", "player_a", "player_A"];
  for (const id of playerIds) {
    world.players[id] = { id, x: 0, y: 0, vx: 0, vy: 0, width: 3, height: 5, grounded: false, facing: 1, airTime: 0, crouching: false, lookingUp: false, swimming: false, inventory: { flowers: 0, zeta: 1, Alpha: 2, beta: 3 }, hotbar: [{ kind: "empty" }, ...Array(9).fill({ kind: "empty" })], activeHotbarSlot: 0 };
  }
  const objectId = allocateObjectId(world);
  world.fallingObjects[objectId] = { id: objectId, materialId: MaterialId.Stone, x: 0, y: 0, restY: 0, vy: 0, offsets: [[0, 0]] };
  const dto = serializeWorldState(world);
  const expectedPlayerOrder = [...playerIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(Object.keys(dto.players), expectedPlayerOrder);
  assert.deepEqual(Object.keys(dto.players.player_I.inventory), ["Alpha", "beta", "flowers", "zeta"]);
  assert.deepEqual(Object.keys(dto.fallingObjects), [objectId]);
});

test("deserialization rejects malformed v2 random payloads", () => {
  for (const random of [
    { algorithm: "mulberry32-v1", seed: -1, state: 0 },
    { algorithm: "mulberry32-v1", seed: 0, state: 0x1_0000_0000 },
    { algorithm: "v2", seed: 0, state: 0 },
    { algorithm: "mulberry32-v1", seed: 0 },
  ]) {
    assert.throws(() => deserializeWorldState(createValidWorldDto({ random })), /random/i);
  }
});

test("schema-v1 migration defaults the RNG state and serializes as v2", () => {
  const dto = {
    schemaVersion: 1,
    roomId: "room_v1_migration",
    grid: { width: 1, height: 1, ids: [0], shade: [0], auxiliary: [0], objectMembership: [] },
    players: {},
    fallingObjects: {},
    paused: false,
    time: { dayNightCycle: 0.25 },
    weather: { kind: "clear", episodeElapsed: 0, episodeDuration: 0, wind: 0, visualTime: 0, rainAccumulator: 0, lightningFlash: null, lightningCooldown: null, boltX: null, boltY: null, boltSeed: 0 },
    nextPlayerOrdinal: 1,
    nextObjectOrdinal: 1,
  };
  const restored = deserializeWorldState(dto);
  assert.deepEqual(restored.random, { algorithm: "mulberry32-v1", seed: 0, state: 0 });
  assert.equal(serializeWorldState(restored).schemaVersion, 2);
  assert.deepEqual(serializeWorldState(restored).random, { algorithm: "mulberry32-v1", seed: 0, state: 0 });
});

test("starter worlds expose a fixed topology fixture while differing only by shades and RNG metadata", () => {
  const first = createStarterWorld({ roomId: "starter_fixture", seed: 12345 });
  const second = createStarterWorld({ roomId: "starter_fixture", seed: 12346 });

  const firstDto = serializeWorldState(first);
  const secondDto = serializeWorldState(second);

  assert.equal(first.grid.width, 320);
  assert.equal(first.grid.height, 200);
  assert.equal(first.grid.get(18, 2), MaterialId.Faucet);
  assert.equal(first.grid.get(95, 82), MaterialId.Stone);
  assert.equal(first.grid.get(200, 105), MaterialId.Wood);
  assert.equal(first.grid.get(80, 171), MaterialId.Drain);
  assert.equal(first.grid.get(20, 185), MaterialId.Sand);
  assert.equal(first.grid.get(265, 110), MaterialId.Stone);
  assert.equal(first.grid.get(18, 2), first.grid.get(18, 2));
  assert.equal(first.grid.getFaucetFlow(18, 2), 2);
  assert.equal(first.grid.getFaucetFlow(27, 7), 2);
  assert.equal(first.grid.get(80, 171), MaterialId.Drain);
  assert.equal(first.grid.get(0, 0), MaterialId.Empty);

  assert.deepEqual(firstDto.grid.ids, secondDto.grid.ids);
  assert.deepEqual(firstDto.grid.auxiliary, secondDto.grid.auxiliary);
  assert.deepEqual(firstDto.grid.objectMembership, secondDto.grid.objectMembership);
  assert.deepEqual(first.players, second.players);
  assert.deepEqual(first.fallingObjects, second.fallingObjects);
  assert.notDeepEqual(firstDto.grid.shade, secondDto.grid.shade);
  assert.notEqual(firstDto.random.seed, secondDto.random.seed);
  assert.notEqual(firstDto.random.state, secondDto.random.state);

  const objectIds = [first.grid.getObjectId(95, 82), first.grid.getObjectId(200, 105), first.grid.getObjectId(18, 2), first.grid.getObjectId(80, 171)];
  assert.deepEqual(objectIds, ["object_1", "object_2", "object_3", "object_4"]);

  const dirtCount = first.grid.ids.filter((id) => id === MaterialId.Dirt).length;
  const stoneCount = first.grid.ids.filter((id) => id === MaterialId.Stone).length;
  const woodCount = first.grid.ids.filter((id) => id === MaterialId.Wood).length;
  const sandCount = first.grid.ids.filter((id) => id === MaterialId.Sand).length;
  assert.equal(dirtCount, 12328);
  assert.equal(stoneCount, 2656);
  assert.equal(woodCount, 288);
  assert.equal(sandCount, 600);
});

test("restored allocation skips IDs already in players, falling objects, and membership", () => {
  const dto = createValidWorldDto({
    players: {
      player_1: { id: "player_1", x: 0, y: 0, vx: 0, vy: 0, width: 3, height: 5, grounded: false, facing: 1, airTime: 0, crouching: false, lookingUp: false, swimming: false, inventory: { flowers: 0 }, hotbar: [{ kind: "empty" }, ...Array(9).fill({ kind: "empty" })], activeHotbarSlot: 0 },
    },
    fallingObjects: {
      object_1: { id: "object_1", materialId: MaterialId.Stone, x: 0, y: 0, restY: 0, vy: 0, offsets: [[0, 0]] },
    },
    grid: {
      width: 4,
      height: 4,
      ids: [MaterialId.Stone, ...Array(15).fill(MaterialId.Empty)],
      shade: Array(16).fill(0),
      auxiliary: Array(16).fill(0),
      objectMembership: [{ x: 0, y: 0, objectId: "object_2" }],
    },
    nextPlayerOrdinal: 1,
    nextObjectOrdinal: 1,
  });
  const restored = deserializeWorldState(dto);
  assert.equal(allocatePlayerId(restored), "player_2");
  assert.equal(allocateObjectId(restored), "object_3");
});

test("rejects malformed schema and dangling object identities", () => {
  assert.throws(() => deserializeWorldState({ schemaVersion: 3, roomId: "room_bad", grid: { width: 2, height: 2, ids: [0, 0, 0, 0], shade: [0, 0, 0, 0], auxiliary: [0, 0, 0, 0], objectMembership: [] }, players: {}, fallingObjects: {}, paused: false, time: { dayNightCycle: 0.5 }, weather: { kind: "clear", episodeElapsed: 0, episodeDuration: 0, wind: 0, visualTime: 0, rainAccumulator: 0, lightningFlash: null, lightningCooldown: null, boltX: null, boltY: null, boltSeed: 0 }, random: { algorithm: "mulberry32-v1", seed: 0, state: 0 }, nextPlayerOrdinal: 1, nextObjectOrdinal: 1 }), /unsupported/);
  assert.throws(() => deserializeWorldState({ schemaVersion: 1, roomId: "room_bad", grid: { width: 2, height: 2, ids: [0, 0, 0, 0], shade: [0, 0, 0, 0], auxiliary: [0, 0, 0, 0], objectMembership: [{ x: 0, y: 0, objectId: "bad_id" }] }, players: {}, fallingObjects: {}, paused: false, time: { dayNightCycle: 0.5 }, weather: { kind: "clear", episodeElapsed: 0, episodeDuration: 0, wind: 0, visualTime: 0, rainAccumulator: 0, lightningFlash: null, lightningCooldown: null, boltX: null, boltY: null, boltSeed: 0 }, nextPlayerOrdinal: 1, nextObjectOrdinal: 1 }), /object/i);
});
