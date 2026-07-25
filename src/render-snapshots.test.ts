import { describe, expect, it } from "vitest";
import { createDefaultPlayerState, createDefaultWorldState, createPlayerId, MaterialId } from "@particle-sim/shared";
import { createPresentationSnapshot, interpolatePresentationSnapshot, resolvePresentationRenderState } from "./render-snapshots";

describe("presentation snapshots", () => {
  it("interpolates midpoint values and keeps snapshots immutable", () => {
    const world = createDefaultWorldState("snapshot_test");
    const previous = createPresentationSnapshot(world);
    const current = createPresentationSnapshot(world);

    previous.players.set("player_1", { x: 0, y: 0, vy: 0 });
    previous.fallingObjects.set("object_1", { x: 2, y: 4, vy: 0.5, materialId: MaterialId.Stone, offsets: [[0, 0], [1, 0]] });

    current.players.set("player_1", { x: 10, y: 20, vy: 2 });
    current.fallingObjects.set("object_1", { x: 8, y: 16, vy: 1.5, materialId: MaterialId.Stone, offsets: [[0, 0], [1, 0]] });

    const interpolated = interpolatePresentationSnapshot(previous, current, 0.5);

    expect(interpolated.players.get("player_1")).toEqual({ x: 5, y: 10, vy: 1 });
    expect(interpolated.fallingObjects.get("object_1")).toEqual({
      x: 5,
      y: 10,
      vy: 1,
      materialId: MaterialId.Stone,
      offsets: [[0, 0], [1, 0]],
    });
    expect(previous.players.get("player_1")).toEqual({ x: 0, y: 0, vy: 0 });
    expect(previous.fallingObjects.get("object_1")?.x).toBe(2);
  });

  it("drops despawned objects at the current endpoint and preserves spawned objects", () => {
    const previous = createPresentationSnapshot(createDefaultWorldState("snapshot_despawn"));
    const current = createPresentationSnapshot(createDefaultWorldState("snapshot_despawn"));

    previous.fallingObjects.set("object_1", { x: 2, y: 4, vy: 0.5, materialId: MaterialId.Stone, offsets: [[0, 0]] });
    current.fallingObjects.set("object_2", { x: 4, y: 6, vy: 0.7, materialId: MaterialId.Stone, offsets: [[0, 0]] });

    const atMidpoint = interpolatePresentationSnapshot(previous, current, 0.5);
    expect(atMidpoint.fallingObjects.get("object_1")).toEqual({
      x: 2,
      y: 4,
      vy: 0.5,
      materialId: MaterialId.Stone,
      offsets: [[0, 0]],
    });
    expect(atMidpoint.fallingObjects.get("object_2")).toEqual({
      x: 4,
      y: 6,
      vy: 0.7,
      materialId: MaterialId.Stone,
      offsets: [[0, 0]],
    });

    const atCurrent = interpolatePresentationSnapshot(previous, current, 1);
    expect(atCurrent.fallingObjects.get("object_1")).toBeUndefined();
    expect(atCurrent.fallingObjects.get("object_2")).toEqual({
      x: 4,
      y: 6,
      vy: 0.7,
      materialId: MaterialId.Stone,
      offsets: [[0, 0]],
    });
  });

  it("uses the latest published world for render presentation without re-restoring from transport", () => {
    const previousWorld = createDefaultWorldState("snapshot_latest_previous");
    const latestWorld = createDefaultWorldState("snapshot_latest_current");
    const playerId = createPlayerId("player_1");
    const localPlayer = createDefaultPlayerState(playerId);
    localPlayer.x = 9;
    localPlayer.y = 7;
    localPlayer.vy = 1.5;
    latestWorld.players[playerId] = localPlayer;
    latestWorld.grid.set(3, 4, MaterialId.Sand);

    const previousSnapshot = createPresentationSnapshot(previousWorld);
    const currentSnapshot = createPresentationSnapshot(latestWorld);
    const renderState = resolvePresentationRenderState(latestWorld, previousSnapshot, currentSnapshot, playerId, 0.37, false);

    expect(renderState.grid).toBe(latestWorld.grid);
    expect(renderState.interpolatedPresentationSnapshot).toBeDefined();
    expect(renderState.interpolatedPlayerSnapshot).toEqual({ x: 9, y: 7, vy: 1.5 });
    expect(renderState.interpolatedPresentationSnapshot.players.get("player_1")).toEqual({ x: 9, y: 7, vy: 1.5 });
  });
});
