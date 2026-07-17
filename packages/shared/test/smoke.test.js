import test from "node:test";
import assert from "node:assert/strict";
import { Grid, MaterialId, harvestFlowerCluster } from "@particle-sim/shared";

test("shared package runtime exports work", () => {
  const grid = new Grid(6, 6);
  grid.set(1, 1, MaterialId.Flower);
  grid.set(1, 2, MaterialId.Stem);
  grid.set(2, 1, MaterialId.Flower);

  assert.equal(harvestFlowerCluster(grid, 1, 1), 1);
  assert.equal(grid.get(1, 1), MaterialId.Empty);
  assert.equal(grid.get(1, 2), MaterialId.Empty);
  assert.equal(grid.get(2, 1), MaterialId.Empty);
  assert.equal(MaterialId.Water, 2);
});
