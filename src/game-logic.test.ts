import { beforeEach, describe, expect, it } from "vitest";
import { Grid, advanceWorldTick, createDefaultFallingObjectState, createDefaultWorldState, createGameplayRandomState, createObjectId, createStarterWorld, deserializeWorldState, harvestFlowerCluster, MaterialId, placeWorldCell, serializeWorldState } from "@particle-sim/shared";
import { handleHarvestInputAt, placeHotbarMaterialAt } from "./input";
import { getLocalPlayer, state } from "./state";
import { processProductionTick } from "./production-tick";

describe("game logic", () => {
  beforeEach(() => {
    state.world = createDefaultWorldState("room_test");
    state.world.grid = new Grid(80, 80);
    const player = getLocalPlayer();
    player.inventory = { flowers: 0 };
    player.hotbar = [
      { kind: "pickaxe" },
      { kind: "material", materialId: MaterialId.Seed, count: 5 },
      { kind: "material", materialId: MaterialId.Torch, count: 5 },
      { kind: "material", materialId: MaterialId.Clock, count: 1 },
      { kind: "empty" },
      { kind: "empty" },
      { kind: "empty" },
      { kind: "empty" },
      { kind: "empty" },
      { kind: "empty" },
    ];
    player.activeHotbarSlot = 0;
  });

  it("keeps same-seed steps deterministic across serialization", () => {
    const original = createDefaultWorldState();
    original.random = createGameplayRandomState(12345);

    const restored = createDefaultWorldState();
    restored.random = createGameplayRandomState(12345);

    for (let i = 0; i < 20; i += 1) {
      advanceWorldTick(original, {});
      advanceWorldTick(restored, {});
    }

    expect(serializeWorldState(original)).toEqual(serializeWorldState(restored));
    expect(original.random).toEqual(restored.random);
  });

  it("continues an interrupted starter-world simulation restore with identical final bytes and random state", () => {
    const seed = 12345;
    let interrupted = createStarterWorld({ roomId: "interrupted_restore", seed });
    const uninterrupted = createStarterWorld({ roomId: "interrupted_restore", seed });

    for (let i = 0; i < 8; i += 1) {
      advanceWorldTick(interrupted, {});
      advanceWorldTick(uninterrupted, {});
    }

    interrupted = deserializeWorldState(serializeWorldState(interrupted));

    for (let i = 0; i < 8; i += 1) {
      advanceWorldTick(interrupted, {});
      advanceWorldTick(uninterrupted, {});
    }

    const interruptedBytes = new TextEncoder().encode(JSON.stringify(serializeWorldState(interrupted)));
    const uninterruptedBytes = new TextEncoder().encode(JSON.stringify(serializeWorldState(uninterrupted)));

    expect(Array.from(interruptedBytes)).toEqual(Array.from(uninterruptedBytes));
    expect(interrupted.random).toEqual(uninterrupted.random);
  });

  it("continues harvest RNG after restoring a world through the production input helper", () => {
    const worldA = createDefaultWorldState("harvest_rng_restore_a");
    worldA.grid = new Grid(8, 8);
    worldA.random = createGameplayRandomState(4242);

    const worldB = createDefaultWorldState("harvest_rng_restore_b");
    worldB.grid = new Grid(8, 8);
    worldB.random = createGameplayRandomState(4242);

    const setupWorld = (world: typeof worldA) => {
      world.grid.set(2, 2, MaterialId.Flower);
      world.grid.set(2, 3, MaterialId.Stem);
      world.grid.set(3, 2, MaterialId.Flower);

      state.world = world;
      const player = getLocalPlayer();
      player.inventory = { flowers: 0 };
      player.hotbar = [{ kind: "empty" }, ...Array(9).fill({ kind: "empty" })];
      player.activeHotbarSlot = 0;
    };

    setupWorld(worldA);
    setupWorld(worldB);

    const restoredWorldA = deserializeWorldState(serializeWorldState(worldA));

    state.world = restoredWorldA;
    handleHarvestInputAt(restoredWorldA, 2, 2);
    processProductionTick(restoredWorldA, {
      [state.localPlayerId]: restoredWorldA.players[state.localPlayerId].input,
    });

    state.world = worldB;
    handleHarvestInputAt(worldB, 2, 2);
    processProductionTick(worldB, {
      [state.localPlayerId]: worldB.players[state.localPlayerId].input,
    });

    const restoredPlayer = restoredWorldA.players[state.localPlayerId];
    const originalPlayer = worldB.players[state.localPlayerId];

    expect(restoredPlayer.inventory).toEqual(originalPlayer.inventory);
    expect(restoredPlayer.hotbar).toEqual(originalPlayer.hotbar);
    expect(restoredWorldA.grid.ids).toEqual(worldB.grid.ids);
    expect(restoredWorldA.random).toEqual(worldB.random);
    expect(restoredWorldA.grid.get(2, 2)).toBe(MaterialId.Empty);
    expect(restoredWorldA.grid.get(2, 3)).toBe(MaterialId.Empty);
    expect(restoredWorldA.grid.get(3, 2)).toBe(MaterialId.Empty);
  });

  it("harvests a connected flower cluster and clears the cells", () => {
    const grid = state.world.grid;
    grid.set(2, 2, MaterialId.Flower);
    grid.set(2, 3, MaterialId.Stem);
    grid.set(3, 2, MaterialId.Flower);

    const count = harvestFlowerCluster(grid, 2, 2);

    expect(count).toBe(1);
    expect(grid.get(2, 2)).toBe(MaterialId.Empty);
    expect(grid.get(2, 3)).toBe(MaterialId.Empty);
    expect(grid.get(3, 2)).toBe(MaterialId.Empty);
    expect(grid.get(4, 2)).toBe(MaterialId.Empty);
  });

  it("lands falling objects by stamping their footprint into the grid", () => {
    const world = state.world;
    const grid = world.grid;
    const id = createObjectId("object_test_1");
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 3, 1, 4, 0, [
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    world.fallingObjects[id].y = 3.5;

    advanceWorldTick(world, {});
    advanceWorldTick(world, {});

    expect(Object.keys(world.fallingObjects)).toHaveLength(0);
    expect(grid.get(3, 4)).toBe(MaterialId.Stone);
    expect(grid.get(4, 4)).toBe(MaterialId.Stone);
    expect(grid.get(3, 5)).toBe(MaterialId.Stone);
  });

  it("keeps falling objects in the state until they land", () => {
    const world = state.world;
    const grid = world.grid;
    const id = createObjectId("object_test_2");
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Torch, 5, 1, 8, 0, [[0, 0]]);
    world.fallingObjects[id].y = 1;

    advanceWorldTick(world, {});

    expect(Object.keys(world.fallingObjects)).toHaveLength(1);
    expect(grid.get(5, 8)).toBe(MaterialId.Empty);
  });

  it("stamps a stable object identity when placing a hotbar object immediately", () => {
    const world = state.world;
    const grid = world.grid;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "pickaxe" },
      { kind: "material", materialId: MaterialId.Wood, count: 1 },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 1;
    player.x = 24;
    player.y = 4;
    state.toolMode = "play";
    state.brushSize = 1;

    const placed = placeHotbarMaterialAt(world, 24, 4);
    processProductionTick(world, {
      [state.localPlayerId]: world.players[state.localPlayerId].input,
    });

    expect(placed).toBe(true);
    const objectId = grid.getObjectId(24, 4);
    expect(objectId).toBeDefined();
    expect(grid.get(24, 4)).toBe(MaterialId.Wood);
    expect(Object.keys(world.fallingObjects)).toHaveLength(0);
  });

  it("preserves identity through airborne placement, fractional mid-fall serialization, and landing", () => {
    const world = state.world;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "pickaxe" },
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 1;
    state.toolMode = "play";
    state.brushSize = 1;

    const placed = placeHotbarMaterialAt(world, 3, 1);
    processProductionTick(world, {
      [state.localPlayerId]: world.players[state.localPlayerId].input,
    });
    expect(placed).toBe(true);

    const objectId = Object.keys(world.fallingObjects)[0];
    expect(objectId).toBeDefined();
    const falling = world.fallingObjects[objectId];
    falling.y = 1.75;

    const restored = deserializeWorldState(serializeWorldState(world));
    const restoredFalling = restored.fallingObjects[objectId];
    expect(restoredFalling.y).toBe(1.75);

    state.world = restored;
    restoredFalling.y = restoredFalling.restY - 0.2;
    advanceWorldTick(restored, {});
    advanceWorldTick(restored, {});

    expect(Object.keys(restored.fallingObjects)).toHaveLength(0);
    expect(restored.grid.get(3, restoredFalling.restY)).toBe(MaterialId.Torch);
  });

  it("lets falling objects rest on the actual support even beyond placement range", () => {
    const world = state.world;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "pickaxe" },
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 1;
    player.x = 0;
    player.y = 0;
    state.toolMode = "play";
    state.brushSize = 1;
    world.grid.set(3, 40, MaterialId.Wall);

    const placed = placeHotbarMaterialAt(world, 3, 1);
    processProductionTick(world, {
      [state.localPlayerId]: world.players[state.localPlayerId].input,
    });

    expect(placed).toBe(true);
    const objectId = Object.keys(world.fallingObjects)[0];
    expect(objectId).toBeDefined();
    expect(world.fallingObjects[objectId].restY).toBe(38);
  });

  it("stops falling on water instead of traversing through it", () => {
    const world = state.world;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "pickaxe" },
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 1;
    player.x = 0;
    player.y = 0;
    state.toolMode = "play";
    state.brushSize = 1;
    world.grid.set(3, 3, MaterialId.Water);

    const placed = placeHotbarMaterialAt(world, 3, 1);
    processProductionTick(world, {
      [state.localPlayerId]: world.players[state.localPlayerId].input,
    });

    expect(placed).toBe(true);
    expect(Object.keys(world.fallingObjects)).toHaveLength(0);
    expect(world.grid.get(3, 1)).toBe(MaterialId.Torch);
    expect(world.grid.getObjectId(3, 1)).toBeDefined();
  });

  it("rejects a blocked initial footprint without mutating state", () => {
    const world = state.world;
    const grid = world.grid;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "pickaxe" },
      { kind: "material", materialId: MaterialId.Wood, count: 1 },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 1;
    player.x = 24;
    player.y = 4;
    state.toolMode = "play";
    state.brushSize = 1;
    grid.set(24, 4, MaterialId.Wall);
    const beforeOrdinal = world.nextObjectOrdinal;

    const placed = placeHotbarMaterialAt(world, 24, 4);
    processProductionTick(world, {
      [state.localPlayerId]: world.players[state.localPlayerId].input,
    });

    expect(placed).toBe(true);
    expect(player.hotbar[1]).toEqual({ kind: "material", materialId: MaterialId.Wood, count: 1 });
    expect(grid.get(24, 4)).toBe(MaterialId.Wall);
    expect(Object.keys(world.fallingObjects)).toHaveLength(0);
    expect(grid.getObjectId(24, 4)).toBeNull();
    expect(world.nextObjectOrdinal).toBe(beforeOrdinal);
  });

  it("clears only the tracked adjacent object when mining", () => {
    const world = state.world;
    const grid = world.grid;
    const player = getLocalPlayer();
    const leftId = createObjectId("object_test_left");
    const rightId = createObjectId("object_test_right");
    player.hotbar = [{ kind: "pickaxe" }, ...Array(9).fill({ kind: "empty" })];
    player.activeHotbarSlot = 0;
    player.x = 0;
    player.y = 0;
    player.width = 3;
    player.height = 5;
    player.facing = 1;
    grid.set(3, 2, MaterialId.Stone, { objectId: leftId });
    grid.set(4, 2, MaterialId.Stone, { objectId: rightId });

    advanceWorldTick(world, {
      [player.id]: { left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: true },
    });

    expect(grid.get(3, 2)).toBe(MaterialId.Empty);
    expect(grid.get(4, 2)).toBe(MaterialId.Stone);
    expect(grid.getObjectId(4, 2)).toBe(rightId);
  });

  it("uses deterministic shades without consuming extra gameplay RNG for simulation-created cells", () => {
    const findStemBloomSeed = () => {
      for (let seed = 0; seed < 100_000; seed += 1) {
        const world = createDefaultWorldState("stem_shade_test");
        world.grid = new Grid(3, 3);
        world.random = createGameplayRandomState(seed);
        world.grid.set(1, 1, MaterialId.Stem);
        world.grid.setStemBudget(1, 1, 1);
        world.grid.set(1, 2, MaterialId.Dirt);
        world.grid.setDirtMoisture(1, 2, 12);
        advanceWorldTick(world, {});
        if (world.grid.get(1, 1) === MaterialId.Flower) return seed;
      }
      throw new Error("No deterministic stem bloom seed found");
    };

    const findWaterSeed = () => {
      for (let seed = 0; seed < 100_000; seed += 1) {
        const world = createDefaultWorldState("water_shade_test");
        world.grid = new Grid(3, 3);
        world.random = createGameplayRandomState(seed);
        world.grid.set(1, 1, MaterialId.Faucet);
        world.grid.setFaucetFlow(1, 1, 2);
        advanceWorldTick(world, {});
        if (world.grid.get(1, 2) === MaterialId.Water) return seed;
      }
      throw new Error("No deterministic water seed found");
    };

    const findGrassSeed = () => {
      for (let seed = 0; seed < 100_000; seed += 1) {
        const world = createDefaultWorldState("grass_shade_test");
        world.grid = new Grid(3, 3);
        world.random = createGameplayRandomState(seed);
        world.grid.set(1, 1, MaterialId.Dirt);
        world.grid.setDirtMoisture(1, 1, 4);
        advanceWorldTick(world, {});
        if (world.grid.get(1, 1) === MaterialId.Grass) return seed;
      }
      throw new Error("No deterministic grass seed found");
    };

    const stemSeed = findStemBloomSeed();
    const stemWorld = createDefaultWorldState("stem_shade_test");
    stemWorld.grid = new Grid(3, 3);
    stemWorld.random = createGameplayRandomState(stemSeed);
    stemWorld.grid.set(1, 1, MaterialId.Stem);
    stemWorld.grid.setStemBudget(1, 1, 1);
    stemWorld.grid.set(1, 2, MaterialId.Dirt);
    stemWorld.grid.setDirtMoisture(1, 2, 12);

    advanceWorldTick(stemWorld, {});

    expect(stemWorld.grid.get(1, 1)).toBe(MaterialId.Flower);
    expect(stemWorld.grid.shade[stemWorld.grid.index(1, 1)]).toBe(-40);
    expect(stemWorld.grid.shade[stemWorld.grid.index(0, 1)]).toBeGreaterThanOrEqual(-5);
    expect(stemWorld.grid.shade[stemWorld.grid.index(0, 1)]).toBeLessThanOrEqual(4);
    expect(stemWorld.grid.shade[stemWorld.grid.index(0, 2)]).toBeGreaterThanOrEqual(15);
    expect(stemWorld.grid.shade[stemWorld.grid.index(0, 2)]).toBeLessThanOrEqual(24);

    const visualWorld = createDefaultWorldState("visual_shade_test");
    visualWorld.random = createGameplayRandomState(12345);
    const beforeVisualState = visualWorld.random.state;
    placeWorldCell(visualWorld, 1, 1, MaterialId.Flower, { shade: -40 });
    expect(visualWorld.random.state).toBe(beforeVisualState);

    const waterSeed = findWaterSeed();
    const waterWorld = createDefaultWorldState("water_shade_test");
    waterWorld.grid = new Grid(3, 3);
    waterWorld.random = createGameplayRandomState(waterSeed);
    waterWorld.grid.set(1, 1, MaterialId.Faucet);
    waterWorld.grid.setFaucetFlow(1, 1, 2);

    advanceWorldTick(waterWorld, {});

    expect(waterWorld.grid.get(1, 2)).toBe(MaterialId.Water);
    expect(waterWorld.grid.shade[waterWorld.grid.index(1, 2)]).not.toBe(0);

    const grassSeed = findGrassSeed();
    const grassWorld = createDefaultWorldState("grass_shade_test");
    grassWorld.grid = new Grid(3, 3);
    grassWorld.random = createGameplayRandomState(grassSeed);
    grassWorld.grid.set(1, 1, MaterialId.Dirt);
    grassWorld.grid.setDirtMoisture(1, 1, 4);

    advanceWorldTick(grassWorld, {});

    expect(grassWorld.grid.get(1, 1)).toBe(MaterialId.Grass);
    expect(grassWorld.grid.shade[grassWorld.grid.index(1, 1)]).not.toBe(0);
  });
});
