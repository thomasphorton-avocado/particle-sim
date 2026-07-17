import { beforeEach, describe, expect, it } from "vitest";
import { Grid, createDefaultFallingObjectState, createObjectId, harvestFlowerCluster, MaterialId } from "@particle-sim/shared";
import { updateFallingObjects } from "./falling";
import { getLocalPlayer, state } from "./state";

describe("game logic", () => {
  beforeEach(() => {
    const player = getLocalPlayer();
    state.world.fallingObjects = {};
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
    const grid = new Grid(10, 10);
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
    const grid = new Grid(10, 10);
    const id = createObjectId("object_test_1");
    state.world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 3, 1, 4, 0, [
      [0, 0],
      [1, 0],
      [0, 1],
    ]);

    updateFallingObjects(grid, 0.05);

    expect(Object.keys(state.world.fallingObjects)).toHaveLength(0);
    expect(grid.get(3, 4)).toBe(MaterialId.Stone);
    expect(grid.get(4, 4)).toBe(MaterialId.Stone);
    expect(grid.get(3, 5)).toBe(MaterialId.Stone);
  });

  it("keeps falling objects in the state until they land", () => {
    const grid = new Grid(10, 10);
    const id = createObjectId("object_test_2");
    state.world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Torch, 5, 1, 8, 0, [[0, 0]]);

    updateFallingObjects(grid, 0.01);

    expect(Object.keys(state.world.fallingObjects)).toHaveLength(1);
    expect(grid.get(5, 8)).toBe(MaterialId.Empty);
  });
});
