import { beforeEach, describe, expect, it } from "vitest";
import { MaterialId, createDefaultWorldState, createLocalTransportSession, createPlayerId, normalizePlayerInput, type LocalTransportEditorCapability, type WorldState } from "@particle-sim/shared";
import { handleHarvestInputAt, placeHotbarMaterialAt } from "./input";
import { state, getLocalPlayer } from "./state";
import { enqueueInputStateCommand, processProductionTick } from "./production-tick";

describe("production command path", () => {
  let world: WorldState;
  let editor: LocalTransportEditorCapability;

  beforeEach(() => {
    world = createDefaultWorldState("test_room");
    const session = createLocalTransportSession(world, createPlayerId("player_1"));
    state.transport = session.transport;
    editor = session.editor;
    state.localPlayerId = createPlayerId("player_1");
    state.toolMode = "play";
    const player = world.players[state.localPlayerId] ?? { ...getLocalPlayer() };
    player.inventoryRevision = 2;
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Sand, count: 4 },
      { kind: "empty" },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    world.players[state.localPlayerId] = player;
    editor.replaceWorld(world);
  });

  it("queues play harvest commands without mutating the world", () => {
    const authorityWorld = state.world;
    authorityWorld.grid.set(1, 1, MaterialId.Flower);
    const beforeCell = authorityWorld.grid.get(1, 1);
    expect(handleHarvestInputAt(authorityWorld, 1, 1)).toBe(true);
    expect(state.transport.getLastCommandResults()).toHaveLength(0);
    expect(authorityWorld.grid.get(1, 1)).toBe(beforeCell);
  });

  it("queues play placement commands without mutating the world", () => {
    const authorityWorld = state.world;
    const beforeCell = authorityWorld.grid.get(2, 2);
    expect(placeHotbarMaterialAt(authorityWorld, 2, 2)).toBe(true);
    expect(state.transport.getLastCommandResults()).toHaveLength(0);
    expect(authorityWorld.grid.get(2, 2)).toBe(beforeCell);
  });

  it("drains queued input commands during the production tick", () => {
    const authorityWorld = state.world;
    const issuedTick = authorityWorld.tick;
    const movementInput = normalizePlayerInput({ left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: false });
    enqueueInputStateCommand(state.world, state.localPlayerId, movementInput, issuedTick);

    const beforeTick = state.world.tick;
    processProductionTick(state.world, { [state.localPlayerId]: movementInput });

    expect(state.world.tick).toBe(beforeTick + 1);
    expect(state.transport.getClientWorld().players[state.localPlayerId]?.input.left).toBe(true);
  });
});
