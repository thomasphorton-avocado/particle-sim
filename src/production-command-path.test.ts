import { beforeEach, describe, expect, it } from "vitest";
import { MaterialId, computeWorldChecksum, createDefaultPlayerState, createDefaultWorldState, createLocalTransportSession, createPlayerId, normalizePlayerInput, type LocalTransportEditorCapability, type WorldState } from "@particle-sim/shared";
import { handleHarvestInputAt, placeHotbarMaterialAt } from "./input";
import { state, getLocalPlayer, setDayNightPreset, setPauseWorld } from "./state";
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

  it("uses a fresh published revision for pause, resume, and time preset commands at 20 Hz", () => {
    for (const unpublishedTicks of [1, 2, 4, 5]) {
      const loopWorld = createDefaultWorldState(`test_room_${unpublishedTicks}`);
      const loopPlayerId = createPlayerId(`player_${unpublishedTicks}`);
      loopWorld.players[loopPlayerId] = createDefaultPlayerState(loopPlayerId);
      const loopSession = createLocalTransportSession(loopWorld, loopPlayerId, { publicationHz: 20 });
      const loopPublishedBatches: string[][] = [];
      loopSession.transport.subscribe((view) => {
        loopPublishedBatches.push(view.lastCommandResults.map((result) => result.type));
      });
      state.transport = loopSession.transport;
      state.localPlayerId = loopPlayerId;
      state.toolMode = "play";

      loopSession.transport.flushPublication({ materializeSnapshot: true });
      loopPublishedBatches.length = 0;

      for (let tick = 0; tick < unpublishedTicks; tick += 1) {
        loopSession.transport.advanceTick();
      }

      setPauseWorld(true);
      loopSession.transport.advanceTick();
      const pauseResults = loopSession.transport.getLastCommandResults();
      expect(pauseResults.at(-1)?.kind).toBe("accepted");
      expect(pauseResults.at(-1)?.type).toBe("pause_world");
      expect(loopPublishedBatches.some((batch) => batch.includes("pause_world"))).toBe(true);
      expect(loopSession.transport.getClientWorld().paused).toBe(true);

      loopSession.transport.flushPublication({ materializeSnapshot: true });
      expect(computeWorldChecksum(state.world)).toBe(computeWorldChecksum(loopSession.transport.getClientWorld()));

      setPauseWorld(false);
      loopSession.transport.advanceTick();
      const resumeResults = loopSession.transport.getLastCommandResults();
      expect(resumeResults.at(-1)?.kind).toBe("accepted");
      expect(resumeResults.at(-1)?.type).toBe("resume_world");
      expect(loopPublishedBatches.some((batch) => batch.includes("resume_world"))).toBe(true);
      expect(loopSession.transport.getClientWorld().paused).toBe(false);

      setDayNightPreset("day");
      loopSession.transport.advanceTick();
      const timePresetResults = loopSession.transport.getLastCommandResults();
      expect(timePresetResults.at(-1)?.kind).toBe("accepted");
      expect(timePresetResults.at(-1)?.type).toBe("set_time_preset");
      expect(loopPublishedBatches.some((batch) => batch.includes("set_time_preset"))).toBe(true);

      loopSession.transport.flushPublication({ materializeSnapshot: true });
      expect(computeWorldChecksum(state.world)).toBe(computeWorldChecksum(loopSession.transport.getClientWorld()));
    }
  });
});
