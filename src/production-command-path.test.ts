import { beforeEach, describe, expect, it } from "vitest";
import { MaterialId, createDefaultWorldState, createPlayerId, normalizePlayerInput } from "@particle-sim/shared";
import { handleHarvestInputAt, placeHotbarMaterialAt } from "./input";
import { state, getLocalPlayer } from "./state";
import { enqueueInputStateCommand, processProductionTick } from "./production-tick";

describe("production command path", () => {
  beforeEach(() => {
    state.world = createDefaultWorldState("test_room");
    state.localPlayerId = createPlayerId("player_1");
    state.toolMode = "play";
    const player = getLocalPlayer();
    player.inventoryRevision = 2;
    player.hotbar[0] = { kind: "material", materialId: MaterialId.Sand, count: 4 };
    player.hotbar[1] = { kind: "empty" };
    state.world.players[state.localPlayerId] = player;
  });

  it("queues play harvest commands without mutating the world", () => {
    state.world.grid.set(1, 1, MaterialId.Flower);
    const beforeCell = state.world.grid.get(1, 1);
    expect(handleHarvestInputAt(state.world, 1, 1)).toBe(true);
    expect(state.world.commandInbox).toHaveLength(1);
    expect(state.world.commandInbox[0]?.command.type).toBe("harvest");
    expect(state.world.grid.get(1, 1)).toBe(beforeCell);
  });

  it("queues play placement commands without mutating the world", () => {
    const beforeCell = state.world.grid.get(2, 2);
    expect(placeHotbarMaterialAt(state.world, 2, 2)).toBe(true);
    expect(state.world.commandInbox).toHaveLength(1);
    expect(state.world.commandInbox[0]?.command.type).toBe("place");
    expect(state.world.grid.get(2, 2)).toBe(beforeCell);
  });

  it("drains queued input commands during the production tick", () => {
    const issuedTick = state.world.tick;
    const movementInput = normalizePlayerInput({ left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: false });
    enqueueInputStateCommand(state.world, state.localPlayerId, movementInput, issuedTick);
    expect(state.world.commandInbox).toHaveLength(1);

    const beforeTick = state.world.tick;
    processProductionTick(state.world, { [state.localPlayerId]: movementInput });

    expect(state.world.tick).toBe(beforeTick + 1);
    expect(state.world.commandInbox).toHaveLength(0);
    expect(state.world.players[state.localPlayerId]?.input.left).toBe(true);
  });
});
