import { beforeEach, describe, expect, it } from "vitest";
import { Grid, createDefaultFallingObjectState, createDefaultWorldState, createObjectId, deserializeWorldState, harvestFlowerCluster, MaterialId, serializeWorldState } from "@particle-sim/shared";
import { updateFallingObjects } from "./falling";
import { mineCellAt } from "./character";
import { placeHotbarMaterialAt } from "./input";
import { getLocalPlayer, state } from "./state";

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

    updateFallingObjects(world, 0.05);

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

    updateFallingObjects(world, 0.01);

    expect(Object.keys(world.fallingObjects)).toHaveLength(1);
    expect(grid.get(5, 8)).toBe(MaterialId.Empty);
  });

  it("stamps a stable object identity when placing a hotbar object immediately", () => {
    const world = state.world;
    const grid = world.grid;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Wood, count: 1 },
      ...Array(9).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    player.x = 24;
    player.y = 4;
    state.toolMode = "play";

    const placed = placeHotbarMaterialAt(world, 24, 4);

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
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array(9).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    state.toolMode = "play";

    const placed = placeHotbarMaterialAt(world, 3, 1);
    expect(placed).toBe(true);

    const objectId = Object.keys(world.fallingObjects)[0];
    expect(objectId).toBeDefined();
    const falling = world.fallingObjects[objectId];
    falling.y = 1.75;

    const restored = deserializeWorldState(serializeWorldState(world));
    const restoredFalling = restored.fallingObjects[objectId];
    expect(restoredFalling.y).toBe(1.75);

    state.world = restored;
    restoredFalling.y = restoredFalling.restY;
    updateFallingObjects(restored, 0.05);

    expect(Object.keys(restored.fallingObjects)).toHaveLength(0);
    expect(restored.grid.get(3, restoredFalling.restY)).toBe(MaterialId.Torch);
  });

  it("lets falling objects rest on the actual support even beyond placement range", () => {
    const world = state.world;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array(9).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    player.x = 0;
    player.y = 0;
    state.toolMode = "play";
    world.grid.set(3, 40, MaterialId.Wall);

    const placed = placeHotbarMaterialAt(world, 3, 1);

    expect(placed).toBe(true);
    const objectId = Object.keys(world.fallingObjects)[0];
    expect(objectId).toBeDefined();
    expect(world.fallingObjects[objectId].restY).toBe(38);
  });

  it("stops falling on water instead of traversing through it", () => {
    const world = state.world;
    const player = getLocalPlayer();
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array(9).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    player.x = 0;
    player.y = 0;
    state.toolMode = "play";
    world.grid.set(3, 3, MaterialId.Water);

    const placed = placeHotbarMaterialAt(world, 3, 1);

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
      { kind: "material", materialId: MaterialId.Wood, count: 1 },
      ...Array(9).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    player.x = 24;
    player.y = 4;
    state.toolMode = "play";
    grid.set(24, 4, MaterialId.Wall);
    const beforeOrdinal = world.nextObjectOrdinal;

    const placed = placeHotbarMaterialAt(world, 24, 4);

    expect(placed).toBe(false);
    expect(player.hotbar[0]).toEqual({ kind: "material", materialId: MaterialId.Wood, count: 1 });
    expect(grid.get(24, 4)).toBe(MaterialId.Wall);
    expect(Object.keys(world.fallingObjects)).toHaveLength(0);
    expect(grid.getObjectId(24, 4)).toBeNull();
    expect(world.nextObjectOrdinal).toBe(beforeOrdinal);
  });

  it("clears only the tracked adjacent object when mining", () => {
    const grid = state.world.grid;
    const player = getLocalPlayer();
    const leftId = createObjectId("object_test_left");
    const rightId = createObjectId("object_test_right");
    grid.set(1, 1, MaterialId.Stone, { objectId: leftId });
    grid.set(2, 1, MaterialId.Stone, { objectId: rightId });

    mineCellAt(grid, 1, 1, new Set(), player);

    expect(grid.get(1, 1)).toBe(MaterialId.Empty);
    expect(grid.get(2, 1)).toBe(MaterialId.Stone);
    expect(grid.getObjectId(2, 1)).toBe(rightId);
  });
});
