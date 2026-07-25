import { beforeEach, describe, expect, it } from "vitest";
import { MaterialId, createDefaultWorldState, createPlayerId, normalizePlayerInput } from "@particle-sim/shared";
import { handleHarvestInputAt, placeHotbarMaterialAt } from "./input";
import { state, getLocalPlayer, getAuthoritativeWorldForEditor, replaceWorldForEditor } from "./state";
import { enqueueInputStateCommand, processProductionTick } from "./production-tick";

describe("production command path", () => {
  const getAuthoritativeWorld = () => getAuthoritativeWorldForEditor();

  beforeEach(() => {
    replaceWorldForEditor(createDefaultWorldState("test_room"));
    state.localPlayerId = createPlayerId("player_1");
    state.toolMode = "play";
    const authorityWorld = getAuthoritativeWorld();
    const player = authorityWorld.players[state.localPlayerId] ?? { ...getLocalPlayer() };
    player.inventoryRevision = 2;
    player.hotbar = [
      { kind: "material", materialId: MaterialId.Sand, count: 4 },
      { kind: "empty" },
      ...Array(8).fill({ kind: "empty" }),
    ];
    player.activeHotbarSlot = 0;
    authorityWorld.players[state.localPlayerId] = player;
    replaceWorldForEditor(authorityWorld);
  });

  it("queues play harvest commands without mutating the world", () => {
    const authorityWorld = getAuthoritativeWorld();
    authorityWorld.grid.set(1, 1, MaterialId.Flower);
    const beforeCell = authorityWorld.grid.get(1, 1);
    expect(handleHarvestInputAt(authorityWorld, 1, 1)).toBe(true);
    expect(authorityWorld.commandInbox).toHaveLength(1);
    expect(authorityWorld.commandInbox[0]?.command.type).toBe("harvest");
    expect(authorityWorld.grid.get(1, 1)).toBe(beforeCell);
  });

  it("queues play placement commands without mutating the world", () => {
    const authorityWorld = getAuthoritativeWorld();
    const beforeCell = authorityWorld.grid.get(2, 2);
    expect(placeHotbarMaterialAt(authorityWorld, 2, 2)).toBe(true);
    expect(authorityWorld.commandInbox).toHaveLength(1);
    expect(authorityWorld.commandInbox[0]?.command.type).toBe("place");
    expect(authorityWorld.grid.get(2, 2)).toBe(beforeCell);
  });

  it("drains queued input commands during the production tick", () => {
    const authorityWorld = getAuthoritativeWorld();
    const issuedTick = authorityWorld.tick;
    const movementInput = normalizePlayerInput({ left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false, mineHeld: false });
    enqueueInputStateCommand(state.world, state.localPlayerId, movementInput, issuedTick);
    expect(authorityWorld.commandInbox).toHaveLength(1);

    const beforeTick = authorityWorld.tick;
    processProductionTick(authorityWorld, { [state.localPlayerId]: movementInput });

    expect(authorityWorld.tick).toBe(beforeTick + 1);
    expect(authorityWorld.commandInbox).toHaveLength(0);
    expect(authorityWorld.players[state.localPlayerId]?.input.left).toBe(true);
  });
});
