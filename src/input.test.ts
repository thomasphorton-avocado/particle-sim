/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaterialId, createDefaultPlayerState, createDefaultWorldState, createLocalTransportSession, createObjectId, createPlayerId } from "@particle-sim/shared";
import { attachInput } from "./input";
import { state } from "./state";

function dispatchCanvasPress(canvas: HTMLCanvasElement, x: number, y: number, cellSize: number): void {
  canvas.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x * cellSize + cellSize / 2,
    clientY: y * cellSize + cellSize / 2,
  }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
}

describe("production input routing", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("routes placement, harvest, and faucet presses through the asynchronously installed transport world", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom");
    const world = createDefaultWorldState("room_input_dom");
    const player = createDefaultPlayerState(playerId);
    player.x = 12;
    player.y = 12;
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Sand, count: 1 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    world.grid.set(15, 12, MaterialId.Flower);
    const faucetObjectId = createObjectId("object_input_dom_faucet");
    world.grid.set(18, 12, MaterialId.Faucet, { objectId: faucetObjectId });
    world.grid.setFaucetFlow(18, 12, 1);

    const session = createLocalTransportSession(world, playerId);
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();
    expect(state.world.roomId).toBe(world.roomId);
    expect(state.world).not.toBe(world);

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    dispatchCanvasPress(canvas, 12, 12, cellSize);
    session.transport.advanceTick();
    expect(session.transport.getLastCommandResults().map((result) => [result.type, result.kind])).toEqual([["place", "accepted"]]);
    expect(Array.from(session.transport.getClientWorld().grid.ids).filter((materialId) => materialId === MaterialId.Sand)).toHaveLength(1);

    dispatchCanvasPress(canvas, 15, 12, cellSize);
    session.transport.advanceTick();
    expect(session.transport.getLastCommandResults().map((result) => [result.type, result.kind])).toEqual([["harvest", "accepted"]]);
    expect(session.transport.getClientWorld().grid.get(15, 12)).toBe(MaterialId.Empty);

    dispatchCanvasPress(canvas, 18, 12, cellSize);
    session.transport.advanceTick();
    expect(session.transport.getLastCommandResults().map((result) => [result.type, result.kind])).toEqual([["cycle_faucet", "accepted"]]);
    expect(session.transport.getClientWorld().grid.getFaucetFlow(18, 12)).toBe(2);
  });

  it("routes play-mode object placement through the production command path for falling objects", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_object_play");
    const world = createDefaultWorldState("room_input_dom_object_play");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId);
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    dispatchCanvasPress(canvas, 3, 3, cellSize);
    session.transport.advanceTick();
    const clientWorld = session.transport.getClientWorld();
    expect(session.transport.getLastCommandResults().at(-1)?.type).toBe("place");
    expect(session.transport.getLastCommandResults().at(-1)?.kind).toBe("accepted");
    expect(Object.keys(clientWorld.fallingObjects)).toHaveLength(1);
    expect(clientWorld.grid.get(3, 3)).toBe(MaterialId.Empty);
  });

  it("routes edit-mode object placement through editor mutation for static objects", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_object_editor");
    const world = createDefaultWorldState("room_input_dom_object_editor");
    const player = createDefaultPlayerState(playerId);
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId);
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "editor";
    state.selectedMaterial = MaterialId.Clock;
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    dispatchCanvasPress(canvas, 5, 5, cellSize);
    const clientWorld = session.transport.getClientWorld();
    expect(clientWorld.grid.get(5, 5)).toBe(MaterialId.Clock);
    expect(clientWorld.grid.getObjectId(5, 5)).not.toBeNull();
  });

  it("uses fresh player revisions for follow-up play-mode object placement commands", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_object_revisions");
    const world = createDefaultWorldState("room_input_dom_object_revisions");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 2 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    dispatchCanvasPress(canvas, 1, 1, cellSize);
    session.transport.advanceTick();
    expect(session.transport.getLastCommandResults().at(-1)?.kind).toBe("accepted");

    dispatchCanvasPress(canvas, 2, 2, cellSize);
    session.transport.advanceTick();
    const result = session.transport.getLastCommandResults().at(-1);
    expect(result?.kind).toBe("accepted");
    expect(result?.type).toBe("place");
  });

  it("does not publish or notify on an up-to-date placement click", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_no_publish");
    const world = createDefaultWorldState("room_input_dom_no_publish");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    const notifications: number[] = [];
    const unsubscribe = session.transport.subscribe((stateSnapshot) => {
      notifications.push(stateSnapshot.revision);
    });
    await Promise.resolve();
    notifications.length = 0;

    const flushSpy = vi.spyOn(session.transport, "flushPublication");
    dispatchCanvasPress(canvas, 3, 3, cellSize);
    await Promise.resolve();

    expect(flushSpy).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
    expect(session.transport.getClientWorld().grid.get(3, 3)).toBe(MaterialId.Empty);
    unsubscribe();
  });

  it("uses the transport composition API once per placement click", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_one_sync");
    const world = createDefaultWorldState("room_input_dom_one_sync");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    const compositionSpy = vi.spyOn(session.transport, "getCommandCompositionState");
    dispatchCanvasPress(canvas, 4, 4, cellSize);

    expect(compositionSpy).toHaveBeenCalledTimes(1);
    expect(compositionSpy).toHaveBeenLastCalledWith(playerId);
  });

  it("avoids cloning the client world for non-faucet play-mode clicks", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_no_client_clone");
    const world = createDefaultWorldState("room_input_dom_no_client_clone");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Torch, count: 1 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    const getClientWorldSpy = vi.spyOn(session.transport, "getClientWorld");
    dispatchCanvasPress(canvas, 3, 3, cellSize);

    expect(getClientWorldSpy).not.toHaveBeenCalled();
  });

  it("uses the published world for faucet detection and composes a faucet command", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_faucet_cycle");
    const world = createDefaultWorldState("room_input_dom_faucet_cycle");
    const player = createDefaultPlayerState(playerId);
    world.players[playerId] = player;
    const faucetObjectId = createObjectId("object_input_dom_faucet_cycle");
    world.grid.set(5, 5, MaterialId.Faucet, { objectId: faucetObjectId });
    world.grid.setFaucetFlow(5, 5, 1);
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    const compositionSpy = vi.spyOn(session.transport, "getCommandCompositionState");
    dispatchCanvasPress(canvas, 5, 5, cellSize);
    session.transport.advanceTick();
    session.transport.flushPublication({ materializeSnapshot: true });

    expect(compositionSpy).toHaveBeenCalledTimes(1);
    expect(session.transport.getLastCommandResults().at(-1)?.type).toBe("cycle_faucet");
    expect(session.transport.getLastCommandResults().at(-1)?.kind).toBe("accepted");
    expect(session.transport.getClientWorld().grid.getFaucetFlow(5, 5)).toBe(2);
  });

  it("batches two valid static placement presses before the next tick", async () => {
    const cellSize = 10;
    const playerId = createPlayerId("player_input_dom_static_batch");
    const world = createDefaultWorldState("room_input_dom_static_batch");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Clock, count: 2 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 320,
        width: 320,
        height: 320,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(canvas);
    attachInput(canvas, cellSize, session.editor);

    dispatchCanvasPress(canvas, 1, 1, cellSize);
    dispatchCanvasPress(canvas, 2, 2, cellSize);
    session.transport.advanceTick();
    session.transport.flushPublication({ materializeSnapshot: true });

    const results = session.transport.getLastCommandResults();
    expect(results.map((result) => [result.type, result.kind])).toEqual([
      ["place", "accepted"],
      ["place", "accepted"],
    ]);
    const clientWorld = session.transport.getClientWorld();
    expect(clientWorld.grid.get(1, 1)).toBe(MaterialId.Clock);
    expect(clientWorld.grid.get(2, 2)).toBe(MaterialId.Clock);
    expect(clientWorld.players[playerId].inventoryRevision).toBe(2);
  });

  it("reconciles a rejected placement command before a later valid placement", async () => {
    const playerId = createPlayerId("player_input_dom_rejected_batch");
    const world = createDefaultWorldState("room_input_dom_rejected_batch");
    const player = createDefaultPlayerState(playerId);
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Clock, count: 2 },
      ...Array.from({ length: 9 }, () => ({ kind: "empty" as const })),
    ];
    player.activeHotbarSlot = 0;
    world.players[playerId] = player;
    const session = createLocalTransportSession(world, playerId, { publicationHz: 1 });
    state.transport = session.transport;
    state.localPlayerId = playerId;
    state.toolMode = "play";
    state.brushSize = 1;
    await Promise.resolve();

    session.transport.enqueueCommand({
      type: "place",
      x: 1,
      y: 1,
      brushRadius: 1,
      expectedInventoryRevision: 999,
      expectedAnchorRevision: 999,
    });
    session.transport.enqueueCommand({
      type: "place",
      x: 2,
      y: 2,
      brushRadius: 1,
      expectedInventoryRevision: 0,
      expectedAnchorRevision: 0,
    });
    session.transport.advanceTick();
    session.transport.flushPublication({ materializeSnapshot: true });

    const results = session.transport.getLastCommandResults();
    expect(results.map((result) => result.kind)).toEqual(["rejected", "accepted"]);
    const clientWorld = session.transport.getClientWorld();
    expect(clientWorld.grid.get(2, 2)).toBe(MaterialId.Clock);
    expect(clientWorld.players[playerId].inventoryRevision).toBe(1);
  });
});
