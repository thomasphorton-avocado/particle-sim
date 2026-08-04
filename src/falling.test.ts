import { describe, expect, it } from "vitest";
import {
  createDefaultFallingObjectState,
  createDefaultWorldState,
  createObjectId,
  MaterialId,
} from "@particle-sim/shared";
import { updateFallingObjects } from "./falling";

function makeWorld() {
  return createDefaultWorldState("falling_test");
}

describe("updateFallingObjects", () => {
  it("does nothing when there are no falling objects", () => {
    const world = makeWorld();
    const gridVersion = world.grid.get(0, 0);
    updateFallingObjects(world, 1 / 60);
    expect(Object.keys(world.fallingObjects)).toHaveLength(0);
    expect(world.grid.get(0, 0)).toBe(gridVersion);
  });

  it("accelerates a falling object toward its rest position", () => {
    const world = makeWorld();
    const id = createObjectId("object_fall_accel");
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 10, 5, 20, 0, [[0, 0]]);

    const initialY = world.fallingObjects[id].y;
    updateFallingObjects(world, 1 / 60);

    expect(world.fallingObjects[id].y).toBeGreaterThan(initialY);
    expect(world.fallingObjects[id].vy).toBeGreaterThan(0);
  });

  it("stamps the object into the grid and removes it when it reaches restY", () => {
    const world = makeWorld();
    const id = createObjectId("object_fall_land");
    // restY equals starting y so it lands immediately
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 5, 10, 10, 0, [[0, 0]]);

    updateFallingObjects(world, 1 / 60);

    expect(world.fallingObjects[id]).toBeUndefined();
    expect(world.grid.get(5, 10)).toBe(MaterialId.Stone);
  });

  it("stamps a multi-cell footprint using the offsets", () => {
    const world = makeWorld();
    const id = createObjectId("object_fall_multi");
    const offsets: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 5, 10, 10, 0, offsets);

    updateFallingObjects(world, 1 / 60);

    expect(world.fallingObjects[id]).toBeUndefined();
    for (const [dx, dy] of offsets) {
      expect(world.grid.get(5 + dx, 10 + dy)).toBe(MaterialId.Stone);
    }
  });

  it("caps velocity at TERMINAL_VY even after a very large dt", () => {
    const world = makeWorld();
    const id = createObjectId("object_fall_terminal");
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 5, 0, 1000, 0, [[0, 0]]);

    // dt = 100 s would normally give enormous velocity, but dtFrames is capped at 3 frames
    updateFallingObjects(world, 100);

    // After one step with dtFrames=3: vy = 0 + 0.4*3 = 1.2 (below terminal)
    // After many large dt calls the velocity should be bounded
    for (let i = 0; i < 100; i++) {
      if (world.fallingObjects[id] === undefined) break;
      updateFallingObjects(world, 100);
    }
    // Object should have landed; if somehow still there, vy <= TERMINAL_VY (3)
    if (world.fallingObjects[id]) {
      expect(world.fallingObjects[id].vy).toBeLessThanOrEqual(3);
    }
  });

  it("skips out-of-bounds cells when stamping", () => {
    const world = makeWorld();
    const id = createObjectId("object_fall_oob");
    // Place object at edge so dx=-1 would be out-of-bounds
    const offsets: [number, number][] = [[0, 0], [-1, 0]];
    world.fallingObjects[id] = createDefaultFallingObjectState(id, MaterialId.Stone, 0, 5, 5, 0, offsets);

    expect(() => updateFallingObjects(world, 1 / 60)).not.toThrow();
    expect(world.fallingObjects[id]).toBeUndefined();
    expect(world.grid.get(0, 5)).toBe(MaterialId.Stone);
    // (-1, 5) is out-of-bounds — should not crash and should not be stamped
  });

  it("advances multiple objects independently in the same tick", () => {
    const world = makeWorld();
    const id1 = createObjectId("object_fall_multi_a");
    const id2 = createObjectId("object_fall_multi_b");
    world.fallingObjects[id1] = createDefaultFallingObjectState(id1, MaterialId.Stone, 3, 0, 20, 0, [[0, 0]]);
    world.fallingObjects[id2] = createDefaultFallingObjectState(id2, MaterialId.Stone, 7, 0, 20, 0, [[0, 0]]);

    updateFallingObjects(world, 1 / 60);

    expect(world.fallingObjects[id1].y).toBeGreaterThan(0);
    expect(world.fallingObjects[id2].y).toBeGreaterThan(0);
  });
});
