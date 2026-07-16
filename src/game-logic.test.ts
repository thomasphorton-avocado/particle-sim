import { beforeEach, describe, expect, it } from "vitest";
import { Grid } from "./grid";
import { harvestFlowerCluster } from "./harvest";
import { updateFallingObjects } from "./falling";
import { MaterialId } from "./materials";
import { state } from "./state";

describe("game logic", () => {
  beforeEach(() => {
    state.fallingObjects = [];
    state.inventory = { flowers: 0 };
    state.hotbar = [
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
      { kind: "empty" },
    ];
    state.activeSlot = 0;
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
    state.fallingObjects.push({
      materialId: MaterialId.Stone,
      x: 3,
      y: 1,
      restY: 4,
      vy: 0,
      offsets: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    });

    updateFallingObjects(grid, 0.05);

    expect(state.fallingObjects).toHaveLength(0);
    expect(grid.get(3, 4)).toBe(MaterialId.Stone);
    expect(grid.get(4, 4)).toBe(MaterialId.Stone);
    expect(grid.get(3, 5)).toBe(MaterialId.Stone);
  });

  it("keeps falling objects in the state until they land", () => {
    const grid = new Grid(10, 10);
    state.fallingObjects.push({
      materialId: MaterialId.Torch,
      x: 5,
      y: 1,
      restY: 8,
      vy: 0,
      offsets: [[0, 0]],
    });

    updateFallingObjects(grid, 0.01);

    expect(state.fallingObjects).toHaveLength(1);
    expect(grid.get(5, 8)).toBe(MaterialId.Empty);
  });
});
