import test from "node:test";
import assert from "node:assert/strict";
import { MaterialId, PublicationCadence, advanceWorldTick, applyWorldDeltaToSnapshot, computeWorldChecksum, createCommandEnvelope, createDefaultPlayerState, createDefaultWorldState, createLocalTransportSession, createObjectId, createPlayerId, processCommand } from "@particle-sim/shared";

function createWorldWithPlayer() {
  const world = createDefaultWorldState("room_transport");
  const actorId = createPlayerId("player_transport");
  world.players[actorId] = createDefaultPlayerState(actorId);
  return { world, actorId };
}

function captureWorldSnapshot(world, actorId) {
  return {
    checksum: computeWorldChecksum(world),
    revision: world.worldRevision,
    tick: world.tick,
    paused: world.paused,
    inputLeft: world.players[actorId].input.left,
    inventoryRevision: world.players[actorId].inventoryRevision,
    timeDayNightTick: world.time.dayNightTick,
    timeDayNightCycle: world.time.dayNightCycle,
    weatherKind: world.weather.kind,
    rngSeed: world.random.seed,
    actorHighWater: world.commandLedger.actorHighWater[actorId] ?? 0,
  };
}

function createFingerprint(envelope) {
  const stableStringify = (value) => {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return stableStringify({
    commandId: envelope.commandId,
    actorId: envelope.actorId,
    actorSequence: envelope.actorSequence,
    issuedTick: envelope.issuedTick,
    command: envelope.command,
  });
}

function createForgedAcceptedPauseReceipt(envelope) {
  return {
    commandId: envelope.commandId,
    actorId: envelope.actorId,
    actorSequence: envelope.actorSequence,
    authorityOrder: 7,
    issuedTick: envelope.issuedTick,
    processedTick: 0,
    commandType: "pause_world",
    code: "accepted",
    accepted: true,
    beforeWorldRevision: 0,
    afterWorldRevision: 1,
    beforeInventoryRevision: 0,
    afterInventoryRevision: 0,
    beforeTargetRevision: 0,
    afterTargetRevision: 0,
    acceptedEffect: "pause",
    fingerprint: createFingerprint(envelope),
  };
}

test("LocalTransport uses queued projections for repeated static placement before the next tick", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.x = 0;
  player.y = 0;
  player.hotbar = [
    { kind: "material", materialId: MaterialId.Clock, count: 2 },
    ...Array.from({ length: 9 }, () => ({ kind: "empty" }))
  ];
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const firstComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 1,
    y: 1,
    brushRadius: 1,
    expectedInventoryRevision: firstComposition.projectedInventoryRevision,
    expectedAnchorRevision: firstComposition.projectedCellRevision(1, 1),
  });
  const secondComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 2,
    y: 1,
    brushRadius: 1,
    expectedInventoryRevision: secondComposition.projectedInventoryRevision,
    expectedAnchorRevision: secondComposition.projectedCellRevision(2, 1),
  });

  transport.advanceTick();
  transport.flushPublication({ materializeSnapshot: true });
  const results = transport.getLastCommandResults();
  assert.deepEqual(results.map((result) => [result.type, result.kind]), [["place", "accepted"], ["place", "accepted"]]);
  assert.equal(transport.getClientWorld().players[actorId].inventoryRevision, 2);
});

test("LocalTransport uses the correct queued revision after a rejected earlier placement", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.x = 0;
  player.y = 0;
  player.hotbar = [
    { kind: "material", materialId: MaterialId.Clock, count: 2 },
    ...Array.from({ length: 9 }, () => ({ kind: "empty" }))
  ];
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const firstComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 1,
    y: 1,
    brushRadius: 1,
    expectedInventoryRevision: firstComposition.projectedInventoryRevision - 1,
    expectedAnchorRevision: firstComposition.projectedCellRevision(1, 1),
  });
  const secondComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 2,
    y: 1,
    brushRadius: 1,
    expectedInventoryRevision: secondComposition.projectedInventoryRevision,
    expectedAnchorRevision: secondComposition.projectedCellRevision(2, 1),
  });

  transport.advanceTick();
  transport.flushPublication({ materializeSnapshot: true });
  const results = transport.getLastCommandResults();
  assert.deepEqual(results.map((result) => [result.type, result.kind]), [["place", "rejected"], ["place", "accepted"]]);
  assert.equal(transport.getClientWorld().players[actorId].inventoryRevision, 1);
});

test("LocalTransport suppresses rejection-only subscriber notifications at low cadence", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.x = 0;
  player.y = 0;
  player.hotbar = [
    { kind: "material", materialId: MaterialId.Clock, count: 2 },
    ...Array.from({ length: 9 }, () => ({ kind: "empty" }))
  ];
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 1 });
  const notifications = [];
  transport.subscribe((state) => {
    if (state.lastCommandResults.length > 0) {
      notifications.push(state.lastCommandResults.map((result) => result.kind));
    }
  });
  await Promise.resolve();

  const firstComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 1,
    y: 1,
    brushRadius: 1,
    expectedInventoryRevision: firstComposition.projectedInventoryRevision - 1,
    expectedAnchorRevision: firstComposition.projectedCellRevision(1, 1),
  });

  transport.advanceTick();
  transport.flushPublication({ materializeSnapshot: true });
  assert.deepEqual(notifications, []);
});

test("LocalTransport accepts repeated faucet cycles across a multi-cell object", () => {
  const { world, actorId } = createWorldWithPlayer();
  const faucetObjectId = createObjectId("object_transport_faucet");
  world.grid.setCellState(world.grid.index(3, 3), MaterialId.Faucet, 0, 0, faucetObjectId);
  world.grid.setCellState(world.grid.index(4, 3), MaterialId.Faucet, 0, 0, faucetObjectId);
  world.grid.setAuxiliaryValue(3, 3, 0);
  world.grid.setAuxiliaryValue(4, 3, 0);

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const firstComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "cycle_faucet",
    x: 3,
    y: 3,
    objectId: faucetObjectId,
    expectedTargetRevision: firstComposition.projectedCellRevision(3, 3),
  });
  const secondComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "cycle_faucet",
    x: 3,
    y: 3,
    objectId: faucetObjectId,
    expectedTargetRevision: secondComposition.projectedCellRevision(3, 3),
  });

  transport.advanceTick();
  transport.flushPublication({ materializeSnapshot: true });
  const results = transport.getLastCommandResults();
  assert.deepEqual(results.map((result) => [result.type, result.kind]), [["cycle_faucet", "accepted"], ["cycle_faucet", "accepted"]]);
  assert.equal(transport.getClientWorld().grid.getAuxiliaryValue(3, 3), 2);
  assert.equal(transport.getClientWorld().grid.getAuxiliaryValue(4, 3), 2);
  assert.equal(transport.getClientWorld().grid.cellRevisions[world.grid.index(3, 3)], 3);
  assert.equal(transport.getClientWorld().grid.cellRevisions[world.grid.index(4, 3)], 3);
});

test("LocalTransport does not project an anchor revision for falling placement", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.x = 0;
  player.y = 0;
  player.hotbar = [
    { kind: "material", materialId: MaterialId.Torch, count: 2 },
    ...Array.from({ length: 9 }, () => ({ kind: "empty" }))
  ];
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const firstComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 4,
    y: 4,
    brushRadius: 1,
    expectedInventoryRevision: firstComposition.projectedInventoryRevision,
    expectedAnchorRevision: firstComposition.projectedCellRevision(4, 4),
  });
  const secondComposition = transport.getCommandCompositionState(actorId);
  transport.enqueueCommand({
    type: "place",
    x: 5,
    y: 4,
    brushRadius: 1,
    expectedInventoryRevision: secondComposition.projectedInventoryRevision,
    expectedAnchorRevision: secondComposition.projectedCellRevision(5, 4),
  });

  transport.advanceTick();
  transport.flushPublication({ materializeSnapshot: true });
  const results = transport.getLastCommandResults();
  assert.deepEqual(results.map((result) => [result.type, result.kind]), [["place", "accepted"], ["place", "accepted"]]);
  assert.equal(transport.getClientWorld().players[actorId].inventoryRevision, 2);
  assert.equal(Object.keys(transport.getClientWorld().fallingObjects).length, 2);
});

test("PublicationCadence schedules 60/30/20 Hz publications from authoritative revisions", () => {
  const cadence60 = new PublicationCadence({ publicationHz: 60 });
  cadence60.reset(0);
  assert.equal(cadence60.observe(1).shouldPublish, true);

  const cadence30 = new PublicationCadence({ publicationHz: 30 });
  cadence30.reset(0);
  assert.equal(cadence30.observe(1).shouldPublish, false);
  assert.equal(cadence30.observe(2).shouldPublish, true);

  const cadence20 = new PublicationCadence({ publicationHz: 20 });
  cadence20.reset(0);
  assert.equal(cadence20.observe(1).shouldPublish, false);
  assert.equal(cadence20.observe(2).shouldPublish, false);
  assert.equal(cadence20.observe(3).shouldPublish, true);
});

test("LocalTransport coalesces delayed publications across ticks while preserving subscriber state", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 30 });
  const revisions = [];
  transport.subscribe((state) => {
    revisions.push(state.revision);
  });

  await Promise.resolve();
  assert.equal(revisions.length, 1);
  transport.advanceTick();
  assert.equal(revisions.length, 1);
  transport.advanceTick();
  assert.equal(revisions.length, 2);
  assert.equal(revisions.at(-1), 2);
});

test("LocalTransport coalesces ordinary input commands at cadence and flushes critical transitions immediately", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const batches = [];

  transport.subscribe((state) => {
    const batch = state.lastCommandResults.map((result) => result.type);
    if (batch.length > 0) {
      batches.push(batch);
    }
  });

  await Promise.resolve();

  for (let index = 0; index < 3; index += 1) {
    transport.enqueueCommand({
      type: "set_input_state",
      left: index % 2 === 0,
      right: index % 3 === 0,
      jumpHeld: index % 5 === 0,
      crouchHeld: false,
      lookUpHeld: false,
    });
    transport.advanceTick();
  }

  assert.deepEqual(batches, [["set_input_state", "set_input_state", "set_input_state"]]);

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();
  assert.deepEqual(batches.at(-1), ["pause_world"]);
  assert.equal(transport.getClientWorld().paused, true);

  transport.enqueueCommand({ type: "resume_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();
  assert.deepEqual(batches.at(-1), ["resume_world"]);
  assert.equal(transport.getClientWorld().paused, false);
});

test("LocalTransport immediately publishes rejected paused commands without duplicating results", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const batches = [];

  transport.subscribe((state) => {
    const batch = state.lastCommandResults.map((result) => result.type);
    if (batch.length > 0) {
      batches.push(batch);
    }
  });

  await Promise.resolve();

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();
  batches.length = 0;

  transport.enqueueCommand({
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  });
  transport.advanceTick();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], ["set_input_state"]);
  assert.equal(transport.getClientWorld().paused, true);
  assert.equal(transport.getLastCommandResults()[0].kind, "rejected");
  assert.equal(transport.getLastCommandResults()[0].code, "paused");
});

test("LocalTransport preserves bounded command-ledger state across incremental ledger deltas", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });

  for (let index = 0; index < 320; index += 1) {
    transport.enqueueCommand({
      type: "set_input_state",
      left: index % 2 === 0,
      right: index % 3 === 0,
      jumpHeld: index % 5 === 0,
      crouchHeld: false,
      lookUpHeld: false,
    });

    transport.advanceTick();
  }

  transport.flushPublication({ materializeSnapshot: true });
  const clientWorld = transport.getClientWorld();
  assert.equal(clientWorld.commandLedger.recent.length, 256);
  assert.equal(clientWorld.commandLedger.actorHighWater[actorId], 320);
  assert.equal(clientWorld.commandLedger.recent[0].actorSequence, 65);
  assert.equal(clientWorld.commandLedger.recent.at(-1).actorSequence, 320);
  assert.deepEqual(clientWorld.commandLedger.recent.slice(-5).map((entry) => entry.actorSequence), [316, 317, 318, 319, 320]);
});

test("LocalTransport publishes ledger-only paused receipts exactly once with deterministic bounded eviction", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const referenceWorld = createDefaultWorldState(world.roomId);
  referenceWorld.ownerPlayerId = actorId;
  referenceWorld.players[actorId] = createDefaultPlayerState(actorId);
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const publishedSequences = [];
  const ledgerOnlySequences = [];

  transport.subscribe((state) => {
    publishedSequences.push(...state.lastCommandResults.map((result) => result.actorSequence));
    if (state.delta?.metadata.some((entry) => entry.field === "commandLedger")
      && state.delta.cells.length === 0
      && state.delta.players.length === 0
      && state.delta.fallingObjects.length === 0
      && state.delta.metadata.every((entry) => entry.field === "commandLedger")) {
      ledgerOnlySequences.push(...state.lastCommandResults.map((result) => result.actorSequence));
    }
  });
  await Promise.resolve();

  const pauseCommand = { type: "pause_world", expectedWorldRevision: 0 };
  transport.enqueueCommand(pauseCommand);
  processCommand(referenceWorld, createCommandEnvelope(actorId, 1, 0, pauseCommand));
  transport.advanceTick();

  for (let index = 0; index < 300; index += 1) {
    const command = {
      type: "set_input_state",
      left: index % 2 === 0,
      right: index % 3 === 0,
      jumpHeld: false,
      crouchHeld: false,
      lookUpHeld: false,
    };
    const actorSequence = index + 2;
    transport.enqueueCommand(command);
    processCommand(referenceWorld, createCommandEnvelope(actorId, actorSequence, 0, command));
    transport.advanceTick();
  }

  transport.flushPublication({ materializeSnapshot: true });
  const clientWorld = transport.getClientWorld();
  assert.deepEqual(publishedSequences, Array.from({ length: 301 }, (_, index) => index + 1));
  assert.deepEqual(ledgerOnlySequences, Array.from({ length: 300 }, (_, index) => index + 2));
  assert.equal(clientWorld.commandLedger.actorHighWater[actorId], 301);
  assert.equal(clientWorld.commandLedger.recent.length, 256);
  assert.equal(clientWorld.commandLedger.recent[0].actorSequence, 46);
  assert.equal(clientWorld.commandLedger.recent.at(-1).actorSequence, 301);
  assert.equal(computeWorldChecksum(clientWorld), computeWorldChecksum(referenceWorld));
  assert.equal(transport.getClientSnapshot().checksum, computeWorldChecksum(referenceWorld));
});

test("LocalTransport exposes an applicable public delta stream across ledger-only and normal updates", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const exposedDeltas = [];
  const resultSequences = [];
  let publicSnapshot = null;

  transport.subscribe((state) => {
    if (publicSnapshot === null && state.snapshot) {
      publicSnapshot = state.snapshot;
    }
    if (state.delta) {
      exposedDeltas.push(state.delta);
      publicSnapshot = applyWorldDeltaToSnapshot(publicSnapshot, state.delta);
    }
    resultSequences.push(...state.lastCommandResults.map((result) => result.actorSequence));
  });
  await Promise.resolve();

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: 0 });
  transport.advanceTick();
  assert.equal(publicSnapshot.worldRevision, 1);

  transport.enqueueCommand({
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  });
  transport.advanceTick();

  const ledgerOnlyDelta = exposedDeltas[1];
  assert.equal(ledgerOnlyDelta.baseRevision, 1);
  assert.equal(ledgerOnlyDelta.targetRevision, 1);
  assert.deepEqual(ledgerOnlyDelta.metadata.map((entry) => entry.field), ["commandLedger"]);
  assert.equal(publicSnapshot.worldRevision, transport.getClientWorld().worldRevision);

  transport.enqueueCommand({ type: "resume_world", expectedWorldRevision: 1 });
  transport.advanceTick();

  const normalDelta = exposedDeltas[2];
  assert.equal(normalDelta.baseRevision, ledgerOnlyDelta.targetRevision);
  assert.ok(normalDelta.targetRevision > normalDelta.baseRevision);
  assert.deepEqual(resultSequences, [1, 2, 3]);
  assert.equal(publicSnapshot.worldRevision, transport.getClientWorld().worldRevision);
  assert.equal(publicSnapshot.checksum, computeWorldChecksum(transport.getClientWorld()));
  assert.equal(publicSnapshot.checksum, transport.getClientSnapshot().checksum);
});

test("LocalTransport rejects stale revision control commands but accepts them after a fresh published boundary", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });

  transport.advanceTick();
  transport.advanceTick();

  const staleRevision = transport.getClientWorld().worldRevision;
  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: staleRevision });
  transport.advanceTick();

  const rejectedResults = transport.getLastCommandResults();
  assert.equal(rejectedResults.at(-1)?.kind, "rejected");
  assert.equal(rejectedResults.at(-1)?.type, "pause_world");

  transport.flushPublication({ materializeSnapshot: true });
  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientWorld().worldRevision });
  transport.advanceTick();

  const acceptedResults = transport.getLastCommandResults();
  assert.equal(acceptedResults.at(-1)?.kind, "accepted");
  assert.equal(acceptedResults.at(-1)?.type, "pause_world");
});

test("LocalTransport rejects gameplay commands while paused and preserves the authority revision", () => {
  const commandCases = [
    {
      name: "set_input_state",
      build: () => ({
        type: "set_input_state",
        left: true,
        right: false,
        jumpHeld: false,
        crouchHeld: false,
        lookUpHeld: false,
      }),
    },
    {
      name: "mine_start",
      build: () => ({ type: "mine_start" }),
    },
    {
      name: "mine_stop",
      build: () => ({ type: "mine_stop" }),
    },
    {
      name: "select_slot",
      build: () => ({ type: "select_slot", slot: 3, expectedInventoryRevision: 0 }),
    },
    {
      name: "place",
      build: () => ({ type: "place", x: 1, y: 1, brushRadius: 1, expectedInventoryRevision: 0, expectedAnchorRevision: 0 }),
    },
    {
      name: "harvest",
      build: () => ({ type: "harvest", x: 1, y: 1, expectedTargetRevision: 0 }),
    },
    {
      name: "cycle_faucet",
      build: () => ({ type: "cycle_faucet", x: 1, y: 1, objectId: createObjectId("object_test"), expectedTargetRevision: 0 }),
    },
    {
      name: "pause_world",
      build: () => ({ type: "pause_world", expectedWorldRevision: 0 }),
    },
    {
      name: "set_time_preset",
      build: () => ({ type: "set_time_preset", preset: "night", expectedWorldRevision: 0 }),
    },
    {
      name: "resume_world",
      build: () => ({ type: "resume_world", expectedWorldRevision: 0 }),
    },
  ];

  for (const commandCase of commandCases) {
    const { world, actorId } = createWorldWithPlayer();
    world.ownerPlayerId = actorId;
    world.paused = true;

    const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
    const before = captureWorldSnapshot(transport.getClientWorld(), actorId);
    transport.enqueueCommand(commandCase.build());
    transport.advanceTick();

    const result = transport.getLastCommandResults().at(-1);
    if (commandCase.name === "resume_world") {
      assert.equal(result?.kind, "accepted");
      assert.equal(result?.type, "resume_world");
      assert.equal(transport.getClientWorld().paused, false);
      assert.ok(transport.getClientWorld().worldRevision >= before.revision + 1);
      assert.equal(transport.getClientWorld().players[actorId].inventoryRevision, before.inventoryRevision);
      assert.ok(transport.getClientWorld().time.dayNightTick >= before.timeDayNightTick);
      assert.ok(transport.getClientWorld().time.dayNightCycle >= before.timeDayNightCycle);
      assert.equal(transport.getClientWorld().weather.kind, before.weatherKind);
      assert.equal(transport.getClientWorld().random.seed, before.rngSeed);
      assert.notEqual(computeWorldChecksum(transport.getClientWorld()), before.checksum);
    } else {
      assert.equal(result?.kind, "rejected");
      assert.equal(result?.code, "paused");
      assert.equal(transport.getClientWorld().worldRevision, before.revision);
      assert.equal(transport.getClientWorld().paused, true);
      assert.equal(transport.getClientWorld().players[actorId].input.left, false);
      assert.equal(transport.getClientWorld().players[actorId].inventoryRevision, before.inventoryRevision);
      assert.equal(transport.getClientWorld().time.dayNightTick, before.timeDayNightTick);
      assert.equal(transport.getClientWorld().time.dayNightCycle, before.timeDayNightCycle);
      assert.equal(transport.getClientWorld().weather.kind, before.weatherKind);
      assert.equal(transport.getClientWorld().random.seed, before.rngSeed);
      assert.notEqual(computeWorldChecksum(transport.getClientWorld()), before.checksum);
      assert.equal(transport.getClientWorld().commandLedger.actorHighWater[actorId], 1);
    }
  }
});

test("LocalTransport rejects paused gameplay commands for a non-owner and preserves authority state", () => {
  const ownerActorId = createPlayerId("player_transport_owner");
  const actorId = createPlayerId("player_transport_bound");
  const world = createDefaultWorldState("room_transport_non_owner_paused");
  world.ownerPlayerId = ownerActorId;
  world.players[ownerActorId] = createDefaultPlayerState(ownerActorId);
  world.players[actorId] = createDefaultPlayerState(actorId);
  world.paused = true;

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const allowedCommands = [
    {
      name: "set_input_state",
      build: () => ({
        type: "set_input_state",
        left: true,
        right: false,
        jumpHeld: false,
        crouchHeld: false,
        lookUpHeld: false,
      }),
    },
    {
      name: "mine_start",
      build: () => ({ type: "mine_start" }),
    },
    {
      name: "mine_stop",
      build: () => ({ type: "mine_stop" }),
    },
    {
      name: "select_slot",
      build: () => ({ type: "select_slot", slot: 3, expectedInventoryRevision: 0 }),
    },
    {
      name: "place",
      build: () => ({ type: "place", x: 1, y: 1, brushRadius: 1, expectedInventoryRevision: 0, expectedAnchorRevision: 0 }),
    },
    {
      name: "harvest",
      build: () => ({ type: "harvest", x: 1, y: 1, expectedTargetRevision: 0 }),
    },
    {
      name: "cycle_faucet",
      build: () => ({ type: "cycle_faucet", x: 1, y: 1, objectId: createObjectId("object_test_2"), expectedTargetRevision: 0 }),
    },
    {
      name: "pause_world",
      build: () => ({ type: "pause_world", expectedWorldRevision: 0 }),
    },
    {
      name: "set_time_preset",
      build: () => ({ type: "set_time_preset", preset: "night", expectedWorldRevision: 0 }),
    },
    {
      name: "resume_world",
      build: () => ({ type: "resume_world", expectedWorldRevision: 0 }),
    },
  ];

  for (const commandCase of allowedCommands) {
    const before = captureWorldSnapshot(transport.getClientWorld(), actorId);
    transport.enqueueCommand(commandCase.build());
    transport.advanceTick();

    const result = transport.getLastCommandResults().at(-1);
    if (commandCase.name === "resume_world") {
      assert.equal(result?.kind, "rejected");
      assert.equal(result?.code, "not_owner");
    } else {
      assert.equal(result?.kind, "rejected");
      assert.equal(result?.code, "paused");
    }
    assert.equal(transport.getClientWorld().worldRevision, before.revision);
    assert.equal(transport.getClientWorld().paused, true);
    assert.equal(transport.getClientWorld().players[actorId].input.left, false);
    assert.equal(transport.getClientWorld().players[actorId].inventoryRevision, before.inventoryRevision);
    assert.equal(transport.getClientWorld().time.dayNightTick, before.timeDayNightTick);
    assert.equal(transport.getClientWorld().time.dayNightCycle, before.timeDayNightCycle);
    assert.equal(transport.getClientWorld().weather.kind, before.weatherKind);
    assert.equal(transport.getClientWorld().random.seed, before.rngSeed);
    assert.notEqual(computeWorldChecksum(transport.getClientWorld()), before.checksum);
    assert.equal(transport.getClientWorld().commandLedger.actorHighWater[actorId], (before.actorHighWater ?? 0) + 1);
  }
});

test("LocalTransport flushPublication publishes the latest authority state at arbitrary tick counts", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 20 });
  const batches = [];

  transport.subscribe((state) => {
    const batch = state.lastCommandResults.map((result) => result.type);
    if (batch.length > 0) {
      batches.push(batch);
    }
  });

  await Promise.resolve();

  for (let index = 0; index < 5; index += 1) {
    transport.enqueueCommand({
      type: "set_input_state",
      left: index % 2 === 0,
      right: index % 3 === 0,
      jumpHeld: index % 5 === 0,
      crouchHeld: false,
      lookUpHeld: false,
    });
    transport.advanceTick();
  }

  const beforeFlushDigest = computeWorldChecksum(transport.getClientWorld());
  transport.flushPublication({ materializeSnapshot: true });
  const afterFlushDigest = computeWorldChecksum(transport.getClientWorld());

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], ["set_input_state", "set_input_state", "set_input_state"]);
  assert.deepEqual(batches[1], ["set_input_state", "set_input_state"]);
  assert.notEqual(beforeFlushDigest, afterFlushDigest);
  assert.equal(transport.getClientWorld().tick, 5);
  assert.equal(transport.getClientSnapshot().worldState.tick, 5);
  assert.equal(transport.getClientState().revision, 5);
});

test("LocalTransport publishes snapshots and isolated client state after accepted commands", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const seenRevisions = [];

  transport.subscribe((state) => {
    seenRevisions.push(state.revision);
  });

  await Promise.resolve();

  transport.enqueueCommand({
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  });
  transport.advanceTick();

  const lastResults = transport.getLastCommandResults();
  const clientState = transport.getClientState();
  const clientWorld = transport.getClientWorld();

  assert.equal(lastResults.length, 1);
  assert.equal(lastResults[0].kind, "accepted");
  assert.equal(clientState.revision, transport.getClientWorld().worldRevision);
  assert.ok(clientState.snapshot);
  assert.equal(clientState.snapshot.worldRevision, transport.getClientWorld().worldRevision);
  assert.equal(clientWorld.players[actorId].input.left, true);
  assert.equal(world.players[actorId].input.left, false);

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();
  const afterPauseState = transport.getClientState();
  assert.ok(afterPauseState.delta);
  assert.notStrictEqual(clientWorld, world);
  assert.notStrictEqual(clientWorld.players[actorId], world.players[actorId]);

  clientWorld.players[actorId].input.left = false;
  assert.equal(world.players[actorId].input.left, false);
  assert.equal(seenRevisions.at(-1), afterPauseState.revision);
});

test("LocalTransport drops externally supplied command inboxes for constructor and editor replacement", () => {
  const { world, actorId } = createWorldWithPlayer();
  const externalEnvelope = createCommandEnvelope(actorId, 1, 0, { type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });
  world.commandInbox.push(externalEnvelope);

  const { transport } = createLocalTransportSession(world, actorId);
  const clientWorldAfterConstruction = transport.getClientWorld();
  assert.equal(clientWorldAfterConstruction.commandInbox.length, 0);

  const replacementWorld = createDefaultWorldState("room_transport_replacement");
  const replacementActorId = createPlayerId("player_transport_replacement");
  replacementWorld.players[replacementActorId] = createDefaultPlayerState(replacementActorId);
  replacementWorld.commandInbox.push(createCommandEnvelope(replacementActorId, 1, 0, { type: "pause_world" }));

  const { transport: replacementTransport, editor } = createLocalTransportSession(replacementWorld, replacementActorId);
  editor.replaceWorld(world);
  const clientWorldAfterReplacement = replacementTransport.getClientWorld();
  assert.equal(clientWorldAfterReplacement.commandInbox.length, 0);
});

test("LocalTransport constructor sanitizes forged command history before processing the next command", () => {
  const { world, actorId } = createWorldWithPlayer();
  const forgedEnvelope = createCommandEnvelope(actorId, 1, 0, { type: "pause_world", expectedWorldRevision: 0 });
  world.commandLedger.recent.push(createForgedAcceptedPauseReceipt(forgedEnvelope));
  world.commandLedger.actorHighWater[actorId] = 1;
  world.nextAuthorityOrder = 9;

  const { transport } = createLocalTransportSession(world, actorId);
  const sanitizedWorld = transport.getClientWorld();
  assert.equal(sanitizedWorld.commandLedger.recent.length, 0);
  assert.equal(sanitizedWorld.commandLedger.actorHighWater[actorId], undefined);
  assert.equal(sanitizedWorld.nextAuthorityOrder, 1);

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();

  const afterAttackState = transport.getClientWorld();
  assert.equal(afterAttackState.paused, true);
  assert.equal(afterAttackState.worldRevision, 1);
  const lastCommandResults = transport.getLastCommandResults();
  assert.equal(lastCommandResults.length, 1);
  assert.equal(lastCommandResults[0].kind, "accepted");
  assert.equal(lastCommandResults[0].code, "accepted");
});

test("LocalTransport editor replacement sanitizes forged ledger state before processing the next command", () => {
  const replacementWorld = createDefaultWorldState("room_transport_editor_replacement");
  const replacementActorId = createPlayerId("player_transport_editor_replacement");
  replacementWorld.players[replacementActorId] = createDefaultPlayerState(replacementActorId);

  const incomingWorld = createDefaultWorldState("room_transport_editor_incoming");
  incomingWorld.players[replacementActorId] = createDefaultPlayerState(replacementActorId);
  const forgedEnvelope = createCommandEnvelope(replacementActorId, 1, 0, { type: "pause_world", expectedWorldRevision: 0 });
  incomingWorld.commandLedger.recent.push(createForgedAcceptedPauseReceipt(forgedEnvelope));
  incomingWorld.commandLedger.actorHighWater[replacementActorId] = 1;
  incomingWorld.nextAuthorityOrder = 12;

  const { transport, editor } = createLocalTransportSession(replacementWorld, replacementActorId);
  editor.replaceWorld(incomingWorld);
  const sanitizedWorld = transport.getClientWorld();
  assert.equal(sanitizedWorld.commandLedger.recent.length, 0);
  assert.equal(sanitizedWorld.commandLedger.actorHighWater[replacementActorId], undefined);
  assert.equal(sanitizedWorld.nextAuthorityOrder, 1);

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();

  const afterReplacementState = transport.getClientWorld();
  assert.equal(afterReplacementState.paused, true);
  assert.equal(afterReplacementState.worldRevision, 1);
  const lastCommandResults = transport.getLastCommandResults();
  assert.equal(lastCommandResults.length, 1);
  assert.equal(lastCommandResults[0].kind, "accepted");
  assert.equal(lastCommandResults[0].code, "accepted");
});

test("LocalTransport pauses deterministic ticking and keeps revisions stable until unpaused", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const beforeTick = transport.getClientWorld().tick;

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();

  assert.equal(world.tick, 0);
  assert.equal(transport.getClientWorld().tick, beforeTick);
  assert.equal(transport.getClientState().revision, transport.getClientWorld().worldRevision);

  transport.enqueueCommand({ type: "resume_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();

  assert.equal(world.tick, 0);
  assert.equal(transport.getClientWorld().tick, beforeTick + 1);
  assert.equal(transport.getClientWorld().players[actorId].input.left, false);
  assert.equal(transport.getClientState().revision, transport.getClientWorld().worldRevision);
});

test("LocalTransport initializes placed faucets at low-flow and cycles them through the replicated client state", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const placeResults = transport.getLastCommandResults();
  assert.equal(placeResults.length, 1);
  assert.equal(placeResults[0].kind, "accepted");
  assert.equal(world.players[actorId].hotbar[0].kind, "material");
  assert.equal(world.players[actorId].inventoryRevision, 0);

  const clientWorldAfterPlace = transport.getClientWorld();
  const objectId = clientWorldAfterPlace.grid.getObjectId(10, 10);
  assert.ok(objectId);
  const objectCells = clientWorldAfterPlace.grid.getObjectCellIndices(objectId);
  assert.ok(objectCells.length > 0);
  for (const index of objectCells) {
    const x = index % clientWorldAfterPlace.grid.width;
    const y = Math.floor(index / clientWorldAfterPlace.grid.width);
    assert.equal(clientWorldAfterPlace.grid.get(x, y), MaterialId.Faucet);
    assert.equal(clientWorldAfterPlace.grid.getObjectId(x, y), objectId);
    assert.equal(clientWorldAfterPlace.grid.getFaucetFlow(x, y), 1);
  }
  const clientPlayerAfterPlace = clientWorldAfterPlace.players[actorId];
  assert.equal(clientPlayerAfterPlace.hotbar[0].kind, "empty");
  assert.equal(clientPlayerAfterPlace.inventoryRevision, 1);

  transport.enqueueCommand({
    type: "cycle_faucet",
    x: 10,
    y: 10,
    objectId,
    expectedTargetRevision: clientWorldAfterPlace.grid.cellRevisions[clientWorldAfterPlace.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const cycleResults = transport.getLastCommandResults();
  assert.equal(cycleResults.length, 1);
  assert.equal(cycleResults[0].kind, "accepted");
  const clientWorldAfterCycle = transport.getClientWorld();
  for (const index of objectCells) {
    const x = index % clientWorldAfterCycle.grid.width;
    const y = Math.floor(index / clientWorldAfterCycle.grid.width);
    assert.equal(clientWorldAfterCycle.grid.getFaucetFlow(x, y), 2);
  }
});

test("LocalTransport clears the hotbar slot after one-unit object placement and rejects the next placement without authority mutation", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const firstResult = transport.getLastCommandResults()[0];
  assert.equal(firstResult.kind, "accepted");
  assert.equal(firstResult.code, "accepted");
  assert.equal(world.players[actorId].hotbar[0].kind, "material");
  const clientWorldAfterFirst = transport.getClientWorld();
  assert.equal(clientWorldAfterFirst.players[actorId].hotbar[0].kind, "empty");
  const worldRevisionAfterFirst = clientWorldAfterFirst.tick;
  const inventoryRevisionAfterFirst = clientWorldAfterFirst.players[actorId].inventoryRevision;
  const targetRevisionAfterFirst = clientWorldAfterFirst.grid.cellRevisions[clientWorldAfterFirst.grid.index(10, 10)] ?? 0;

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: inventoryRevisionAfterFirst,
    expectedAnchorRevision: targetRevisionAfterFirst,
  });
  transport.advanceTick();

  const secondResult = transport.getLastCommandResults()[0];
  assert.equal(secondResult.kind, "rejected");
  assert.equal(secondResult.code, "tool");
  const clientWorldAfterSecond = transport.getClientWorld();
  assert.equal(clientWorldAfterSecond.players[actorId].hotbar[0].kind, "empty");
  assert.equal(clientWorldAfterSecond.worldRevision, worldRevisionAfterFirst + 1);
  assert.equal(clientWorldAfterSecond.players[actorId].inventoryRevision, inventoryRevisionAfterFirst);
  assert.equal(clientWorldAfterSecond.grid.get(10, 10), MaterialId.Faucet);
});

test("LocalTransport isolates client state objects and does not expose authority accessors", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);

  const firstState = transport.getClientState();
  firstState.clientWorld.players[actorId].input.left = true;
  const secondState = transport.getClientState();

  assert.equal(secondState.clientWorld.players[actorId].input.left, false);
  assert.equal(typeof transport.getClientWorld, "function");
  assert.equal(typeof transport.getClientSnapshot, "function");
  assert.equal("getAuthoritativeWorld" in transport, false);
  assert.equal("createEditorAccess" in transport, false);
});

test("LocalTransport binds owner-only commands to the local actor and rejects stale revisions without mutating authority", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const clientWorldBefore = transport.getClientWorld();

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: clientWorldBefore.worldRevision + 1 });
  transport.advanceTick();

  const results = transport.getLastCommandResults();
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "rejected");
  assert.equal(results[0].code, "revision");
  assert.equal(transport.getClientWorld().paused, false);
  assert.equal(transport.getClientWorld().worldRevision, clientWorldBefore.worldRevision + 1);
});

test("LocalTransport clears the brush stack when it is fully consumed and preserves positive counts for partial consumption", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Sand, count: 2 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  const fullStackResult = transport.getLastCommandResults()[0];
  assert.equal(fullStackResult.kind, "accepted");
  assert.equal(world.players[actorId].hotbar[0].kind, "material");
  assert.equal(transport.getClientWorld().players[actorId].hotbar[0].kind, "empty");

  const partialWorld = createDefaultWorldState("room_transport_partial");
  const partialActorId = createPlayerId("player_transport_partial");
  partialWorld.players[partialActorId] = createDefaultPlayerState(partialActorId);
  const partialPlayer = partialWorld.players[partialActorId];
  partialPlayer.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Sand, count: 5 }
    : { kind: "empty" });
  partialPlayer.activeHotbarSlot = 0;

  const { transport: partialTransport } = createLocalTransportSession(partialWorld, partialActorId);

  partialTransport.enqueueCommand({
    type: "place",
    x: 0,
    y: 0,
    brushRadius: 1,
    expectedInventoryRevision: partialPlayer.inventoryRevision,
    expectedAnchorRevision: partialWorld.grid.cellRevisions[partialWorld.grid.index(10, 10)] ?? 0,
  });
  partialTransport.advanceTick();

  const partialResult = partialTransport.getLastCommandResults()[0];
  assert.equal(partialResult.kind, "accepted");
  const partialClientPlayer = partialTransport.getClientWorld().players[partialActorId];
  assert.equal(partialClientPlayer.hotbar[0].kind, "material");
  assert.ok(partialClientPlayer.hotbar[0].count > 0);
  assert.equal(partialWorld.players[partialActorId].hotbar[0].kind, "material");
});

test("LocalTransport rejects owner-only pause and time commands for a different bound actor without authority mutation", () => {
  const ownerActorId = createPlayerId("player_transport_owner");
  const boundActorId = createPlayerId("player_transport_bound");
  const world = createDefaultWorldState("room_transport_owner_mismatch");
  world.ownerPlayerId = ownerActorId;
  world.players[ownerActorId] = createDefaultPlayerState(ownerActorId);
  world.players[boundActorId] = createDefaultPlayerState(boundActorId);
  world.time.dayNightTick = 7;
  world.time.dayNightCycle = 7 / 18000;

  const { transport: pauseTransport } = createLocalTransportSession(world, boundActorId);
  const initialRevision = pauseTransport.getClientWorld().worldRevision;

  pauseTransport.enqueueCommand({ type: "pause_world", expectedWorldRevision: pauseTransport.getClientState().revision });
  pauseTransport.advanceTick();
  const pauseResult = pauseTransport.getLastCommandResults()[0];
  assert.equal(pauseResult.kind, "rejected");
  assert.equal(pauseResult.code, "not_owner");
  assert.equal(pauseTransport.getClientWorld().paused, false);
  assert.equal(pauseTransport.getClientWorld().worldRevision, initialRevision + 1);
  assert.equal(pauseTransport.getClientWorld().ownerPlayerId, ownerActorId);

  const { transport: timeTransport } = createLocalTransportSession(world, boundActorId);
  timeTransport.enqueueCommand({ type: "set_time_preset", preset: "night", expectedWorldRevision: timeTransport.getClientState().revision });
  timeTransport.advanceTick();
  const timeResult = timeTransport.getLastCommandResults()[0];
  assert.equal(timeResult.kind, "rejected");
  assert.equal(timeResult.code, "not_owner");
  assert.equal(timeTransport.getClientWorld().time.dayNightTick, 8);
  assert.equal(world.time.dayNightTick, 7);
  assert.equal(world.ownerPlayerId, ownerActorId);
});

test("LocalTransport isolates subscriber callback state and preserves authoritative outcomes", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);

  let firstSubscriberState;
  let secondSubscriberState;

  transport.subscribe((state) => {
    firstSubscriberState = state;
    state.clientWorld.paused = false;
    state.clientWorld.players[actorId].input.left = false;
    state.clientWorld.players[actorId].activeHotbarSlot = 7;
    state.clientWorld.grid.set(0, 0, MaterialId.Sand);
    assert.equal(state.snapshot, null);
    state.delta.gridDimensions.width = 999;
    state.lastCommandResults[0].code = "invalid_command";
  });
  transport.subscribe((state) => {
    secondSubscriberState = state;
  });

  await Promise.resolve();

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();

  assert.equal(firstSubscriberState.clientWorld.paused, false);
  assert.equal(firstSubscriberState.clientWorld.players[actorId].input.left, false);
  assert.equal(firstSubscriberState.clientWorld.players[actorId].activeHotbarSlot, 7);
  assert.equal(firstSubscriberState.clientWorld.grid.get(0, 0), MaterialId.Sand);
  assert.equal(firstSubscriberState.snapshot, null);
  assert.equal(firstSubscriberState.delta.gridDimensions.width, 999);
  assert.equal(firstSubscriberState.lastCommandResults[0].code, "invalid_command");

  assert.equal(secondSubscriberState.clientWorld.paused, true);
  assert.equal(secondSubscriberState.clientWorld.players[actorId].input.left, false);
  assert.equal(secondSubscriberState.clientWorld.players[actorId].activeHotbarSlot, 0);
  assert.equal(secondSubscriberState.clientWorld.grid.get(0, 0), MaterialId.Empty);
  assert.equal(secondSubscriberState.snapshot, null);
  assert.notEqual(secondSubscriberState.delta.gridDimensions.width, 999);
  assert.equal(secondSubscriberState.lastCommandResults[0].code, "accepted");

  assert.equal(transport.getClientWorld().paused, true);
  assert.equal(transport.getClientWorld().players[actorId].input.left, false);
  assert.equal(transport.getClientWorld().players[actorId].activeHotbarSlot, 0);
  assert.equal(transport.getClientWorld().grid.get(0, 0), MaterialId.Empty);
  assert.equal(transport.getClientSnapshot().worldState.paused, true);
  assert.equal(transport.getClientState().lastCommandResults[0].code, "accepted");
});

test("LocalTransport commits canonical state and still notifies later listeners when an earlier subscriber throws", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);
  const laterStates = [];

  transport.subscribe(() => {
    throw new Error("subscriber boom");
  });
  transport.subscribe((state) => {
    laterStates.push(state);
  });

  await Promise.resolve();

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });

  assert.throws(() => transport.advanceTick(), /LocalTransport subscriber publication failed/);

  const clientWorld = transport.getClientWorld();
  const clientState = transport.getClientState();
  assert.equal(clientWorld.grid.get(10, 10), MaterialId.Faucet);
  assert.equal(clientWorld.players[actorId].hotbar[0].kind, "empty");
  assert.equal(clientState.revision, clientWorld.worldRevision);
  assert.equal(laterStates.length, 2);
  assert.equal(laterStates[0].revision, 0);
  assert.equal(laterStates[1].clientWorld.grid.get(10, 10), MaterialId.Faucet);
  assert.equal(laterStates[1].clientWorld.players[actorId].hotbar[0].kind, "empty");
  assert.equal(laterStates[1].snapshot, null);
});

test("LocalTransport queues reentrant publication retries while skipping unsubscribed listeners", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  let firstListenerCalls = 0;
  let secondListenerCalls = 0;

  let unsubscribeFirst;
  unsubscribeFirst = transport.subscribe((state) => {
    firstListenerCalls += 1;
    if (firstListenerCalls === 1) {
      unsubscribeFirst();
      transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: state.revision });
      transport.advanceTick();
    }
  });

  transport.subscribe(() => {
    secondListenerCalls += 1;
  });

  await Promise.resolve();

  transport.enqueueCommand({ type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });
  transport.advanceTick();

  assert.equal(firstListenerCalls, 1);
  assert.equal(secondListenerCalls, 2);
  assert.equal(transport.getClientWorld().paused, true);
  assert.equal(transport.getClientWorld().players[actorId].input.left, false);
});

test("LocalTransport preserves forced editor resync options across reentrant publication", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport, editor } = createLocalTransportSession(world, actorId);
  const replacementWorld = createDefaultWorldState("room_reentrant_editor_replacement");
  replacementWorld.players[actorId] = createDefaultPlayerState(actorId);
  replacementWorld.grid.set(4, 4, MaterialId.Sand);
  let replaced = false;

  transport.subscribe((state) => {
    if (!replaced && state.lastCommandResults.some((result) => result.type === "set_input_state")) {
      replaced = true;
      editor.replaceWorld(replacementWorld);
    }
  });
  await Promise.resolve();

  transport.enqueueCommand({ type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });
  transport.advanceTick();

  const clientWorld = transport.getClientWorld();
  const snapshot = transport.getClientSnapshot();
  assert.equal(replaced, true);
  assert.equal(clientWorld.roomId, replacementWorld.roomId);
  assert.equal(clientWorld.grid.get(4, 4), MaterialId.Sand);
  assert.equal(snapshot.worldState.roomId, replacementWorld.roomId);
  assert.equal(snapshot.worldState.grid.ids[replacementWorld.grid.index(4, 4)], MaterialId.Sand);
});

test("LocalTransport immediately drains a reentrant advance from an editor replacement publication", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport, editor } = createLocalTransportSession(world, actorId);
  const replacementWorld = createDefaultWorldState("room_reentrant_editor_advance");
  replacementWorld.ownerPlayerId = actorId;
  replacementWorld.players[actorId] = createDefaultPlayerState(actorId);
  const resultSequences = [];
  const command = {
    type: "set_input_state",
    left: true,
    right: false,
    jumpHeld: false,
    crouchHeld: false,
    lookUpHeld: false,
  };
  let advanceQueued = false;

  transport.subscribe((state) => {
    resultSequences.push(...state.lastCommandResults.map((result) => result.actorSequence));
    if (!advanceQueued && state.clientWorld.roomId === replacementWorld.roomId) {
      advanceQueued = true;
      transport.enqueueCommand(command);
      transport.advanceTick();
    }
  });
  await Promise.resolve();

  editor.replaceWorld(replacementWorld);

  processCommand(replacementWorld, createCommandEnvelope(actorId, 1, 0, command));
  advanceWorldTick(replacementWorld, { [actorId]: replacementWorld.players[actorId].input });

  const clientWorld = transport.getClientWorld();
  assert.equal(advanceQueued, true);
  assert.deepEqual(resultSequences, [1]);
  assert.equal(clientWorld.tick, 1);
  assert.equal(clientWorld.players[actorId].input.left, true);
  assert.equal(computeWorldChecksum(clientWorld), computeWorldChecksum(replacementWorld));
  assert.equal(transport.getClientSnapshot().checksum, computeWorldChecksum(replacementWorld));
});

test("LocalTransport isolates initial-sync failures per subscriber", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const revisions = [];

  transport.subscribe(() => {
    throw new Error("initial subscriber boom");
  });
  transport.subscribe((state) => {
    revisions.push(["second", state.revision]);
  });
  await Promise.resolve();

  transport.subscribe((state) => {
    revisions.push(["future", state.revision]);
  });
  await Promise.resolve();

  assert.deepEqual(revisions, [["second", 0], ["future", 0]]);
});

test("LocalTransport cancels stale initial sync after a newer publication", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const revisions = [];

  transport.subscribe((state) => {
    revisions.push(state.revision);
  });
  transport.advanceTick();
  await Promise.resolve();

  assert.deepEqual(revisions, [1]);
});

test("LocalTransport drains a reentrant initial command once and converges simulation state", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const referenceWorld = createDefaultWorldState(world.roomId);
  referenceWorld.ownerPlayerId = actorId;
  referenceWorld.players[actorId] = createDefaultPlayerState(actorId);
  const { transport } = createLocalTransportSession(world, actorId);
  const resultSequences = [];
  let commandQueued = false;

  transport.subscribe((state) => {
    resultSequences.push(...state.lastCommandResults.map((result) => result.actorSequence));
    if (!commandQueued) {
      commandQueued = true;
      transport.enqueueCommand({ type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });
      transport.advanceTick();
    }
  });
  await Promise.resolve();

  const command = { type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false };
  processCommand(referenceWorld, createCommandEnvelope(actorId, 1, 0, command));
  advanceWorldTick(referenceWorld, { [actorId]: referenceWorld.players[actorId].input });

  transport.flushPublication({ materializeSnapshot: true });
  const clientWorld = transport.getClientWorld();
  assert.deepEqual(resultSequences, [1]);
  assert.equal(clientWorld.tick, 1);
  assert.equal(clientWorld.players[actorId].input.left, true);
  assert.equal(computeWorldChecksum(clientWorld), computeWorldChecksum(referenceWorld));
  assert.equal(transport.getClientSnapshot().checksum, computeWorldChecksum(referenceWorld));
});

test("LocalTransport preserves pause and dirty state across reentrant callback generations", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 1 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);
  const publishedResultTypes = [];
  const publishedDeltaSummary = [];
  let reentrantTriggered = false;

  transport.subscribe((state) => {
    const results = state.lastCommandResults.map((result) => result.type);
    if (results.length > 0) {
      publishedResultTypes.push(results);
      publishedDeltaSummary.push({
        hasCells: state.delta ? state.delta.cells.length > 0 : false,
        hasPausedMetadata: state.delta ? state.delta.metadata.some((entry) => entry.field === "paused") : false,
      });
    }
    if (!reentrantTriggered && results[0] === "place") {
      reentrantTriggered = true;
      transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: state.revision });
      transport.advanceTick();
    }
  });

  await Promise.resolve();

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  assert.deepEqual(publishedResultTypes, [["place"], ["pause_world"]]);
  assert.equal(publishedDeltaSummary[0].hasCells, true);
  assert.equal(publishedDeltaSummary[1].hasPausedMetadata, true);
  assert.equal(transport.getClientWorld().paused, true);
  assert.equal(transport.getClientWorld().grid.get(10, 10), MaterialId.Faucet);
  assert.equal(transport.getClientWorld().worldRevision, transport.getClientState().clientWorld.worldRevision);
  assert.equal(transport.getClientState().lastCommandResults[0].type, "pause_world");
  assert.equal(transport.getClientWorld().grid.get(10, 10), transport.getClientState().clientWorld.grid.get(10, 10));
  assert.equal(transport.getClientWorld().paused, transport.getClientState().clientWorld.paused);
});

test("LocalTransport preserves later generations when the same cell is rewritten across reentrant publications", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 2 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId);
  const publishedResultTypes = [];
  let generation = 0;

  transport.subscribe((state) => {
    const results = state.lastCommandResults.map((result) => result.type);
    if (results.length > 0) {
      publishedResultTypes.push(...results);
      if (results[0] === "place" && generation === 0) {
        generation = 1;
        const objectId = state.clientWorld.grid.getObjectId(10, 10);
        transport.enqueueCommand({
          type: "cycle_faucet",
          x: 10,
          y: 10,
          objectId,
          expectedTargetRevision: state.clientWorld.grid.cellRevisions[state.clientWorld.grid.index(10, 10)] ?? 0,
        });
        transport.advanceTick();
      } else if (results[0] === "cycle_faucet" && generation === 1) {
        generation = 2;
        transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: state.revision });
        transport.advanceTick();
      }
    }
  });

  await Promise.resolve();

  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: player.inventoryRevision,
    expectedAnchorRevision: world.grid.cellRevisions[world.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  assert.deepEqual(publishedResultTypes, ["place", "cycle_faucet", "pause_world"]);
  assert.equal(transport.getClientWorld().grid.getFaucetFlow(10, 10), 2);
  assert.equal(transport.getClientWorld().paused, true);
});

test("LocalTransport handles throwing and unsubscribed listeners across reentrant generations without duplicate delivery", async () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);
  const publishedResultTypes = [];
  let reentrantTriggered = false;

  let unsubscribeFirst;
  unsubscribeFirst = transport.subscribe((state) => {
    const results = state.lastCommandResults.map((result) => result.type);
    if (results.length > 0) {
      publishedResultTypes.push(...results);
      if (!reentrantTriggered && results[0] === "set_input_state") {
        reentrantTriggered = true;
        unsubscribeFirst();
        transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: state.revision });
        transport.advanceTick();
        throw new Error("subscriber boom");
      }
    }
  });

  transport.subscribe((state) => {
    const results = state.lastCommandResults.map((result) => result.type);
    if (results.length > 0) {
      publishedResultTypes.push(...results);
    }
  });

  await Promise.resolve();

  transport.enqueueCommand({ type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false });
  assert.throws(() => transport.advanceTick(), /LocalTransport subscriber publication failed/);

  assert.deepEqual(publishedResultTypes.filter((type) => type === "set_input_state"), ["set_input_state", "set_input_state"]);
  assert.deepEqual(publishedResultTypes.filter((type) => type === "pause_world"), ["pause_world"]);
  assert.equal(transport.getClientWorld().paused, true);
  assert.equal(transport.getClientWorld().players[actorId].input.left, false);
  assert.equal(transport.getClientState().lastCommandResults[0].type, "pause_world");
});

test("LocalTransport flushes dirty journal entries after successful publication and avoids reprocessing stale cells", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Water, count: 6 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport } = createLocalTransportSession(world, actorId, { publicationHz: 10 });

  const placeState = transport.getClientWorld();
  transport.enqueueCommand({
    type: "place",
    x: 10,
    y: 10,
    brushRadius: 1,
    expectedInventoryRevision: placeState.players[actorId].inventoryRevision,
    expectedAnchorRevision: placeState.grid.cellRevisions[placeState.grid.index(10, 10)] ?? 0,
  });
  transport.advanceTick();

  assert.equal(transport.getClientDelta(), null);
  assert.equal(transport.getClientSnapshot().worldState.grid.ids[transport.getClientWorld().grid.index(10, 10)], MaterialId.Empty);

  transport.flushPublication();
  const initialSnapshot = transport.getClientSnapshot();
  assert.equal(initialSnapshot.worldState.grid.ids[transport.getClientWorld().grid.index(10, 10)], MaterialId.Water);
  assert.equal(initialSnapshot.worldState.players[actorId].inventoryRevision, 1);

  transport.enqueueCommand({ type: "pause_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();
  assert.ok(transport.getClientDelta());

  transport.enqueueCommand({ type: "resume_world", expectedWorldRevision: transport.getClientState().revision });
  transport.advanceTick();

  const snapshot = transport.getClientSnapshot();
  assert.equal(snapshot.worldState.grid.ids[transport.getClientWorld().grid.index(10, 10)], MaterialId.Water);

  const priorState = transport.getClientWorld();
  transport.enqueueCommand({
    type: "place",
    x: 15,
    y: 15,
    brushRadius: 1,
    expectedInventoryRevision: priorState.players[actorId].inventoryRevision,
    expectedAnchorRevision: priorState.grid.cellRevisions[priorState.grid.index(15, 15)] ?? 0,
  });
  transport.advanceTick();
  const beforeSecondPlacementSnapshot = transport.getClientSnapshot();
  transport.flushPublication();
  const laterPlacementSnapshot = transport.getClientSnapshot();
  assert.notDeepEqual(Array.from(laterPlacementSnapshot.worldState.grid.ids), Array.from(beforeSecondPlacementSnapshot.worldState.grid.ids));
  assert.equal(laterPlacementSnapshot.worldState.players[actorId].inventoryRevision, 2);
});

test("LocalTransport preserves pending dirty state when a subscriber publication fails", () => {
  const { world, actorId } = createWorldWithPlayer();
  const { transport } = createLocalTransportSession(world, actorId);

  transport.subscribe(() => {
    throw new Error("subscriber boom");
  });

  const index = world.grid.index(0, 0);
  world.grid.set(0, 0, MaterialId.Sand);
  assert.equal(world.grid.dirtyCells.size, 1);

  assert.throws(() => transport.advanceTick(), /subscriber boom/);
  assert.equal(world.grid.dirtyCells.size, 1);
  assert.equal(transport.getClientWorld().grid.get(0, 0), MaterialId.Empty);
  assert.equal(transport.getClientSnapshot().worldState.grid.ids[index], MaterialId.Empty);
});

test("LocalTransport materializes canonical snapshots after deltas and supports repeated subscribe/unsubscribe cycles", () => {
  const { world, actorId } = createWorldWithPlayer();
  const player = world.players[actorId];
  player.hotbar = Array.from({ length: 10 }, (_, slot) => slot === 0
    ? { kind: "material", materialId: MaterialId.Faucet, count: 4 }
    : { kind: "empty" });
  player.activeHotbarSlot = 0;

  const { transport, editor } = createLocalTransportSession(world, actorId);

  const unsubscribeFirst = transport.subscribe(() => {});
  const unsubscribeSecond = transport.subscribe(() => {});
  unsubscribeFirst();
  unsubscribeSecond();

  for (let step = 0; step < 4; step += 1) {
    const priorState = transport.getClientWorld();
    transport.enqueueCommand({
      type: "place",
      x: 10 + step,
      y: 10 + step,
      brushRadius: 1,
      expectedInventoryRevision: priorState.players[actorId].inventoryRevision,
      expectedAnchorRevision: priorState.grid.cellRevisions[priorState.grid.index(10 + step, 10 + step)] ?? 0,
    });
    transport.advanceTick();
  }

  const explicitSnapshot = transport.getClientSnapshot();
  const explicitState = transport.getClientState();
  assert.ok(explicitState.snapshot);
  assert.equal(explicitSnapshot.checksum, explicitState.snapshot.checksum);
  assert.equal(explicitSnapshot.worldRevision, transport.getClientWorld().worldRevision);
  assert.equal(explicitSnapshot.worldState.grid.ids[transport.getClientWorld().grid.index(10, 10)], MaterialId.Faucet);

  const replacementWorld = createDefaultWorldState("room_transport_snapshot_replacement");
  const replacementActorId = createPlayerId("player_transport_snapshot_replacement");
  replacementWorld.players[replacementActorId] = createDefaultPlayerState(replacementActorId);
  editor.replaceWorld(replacementWorld);

  const replacedSnapshot = transport.getClientSnapshot();
  assert.equal(replacedSnapshot.worldState.players[replacementActorId].id, replacementActorId);
  assert.equal(transport.getClientWorld().players[replacementActorId].input.left, false);
  assert.equal(replacedSnapshot.worldRevision, transport.getClientWorld().worldRevision);

  const unsubscribeAfterReplacement = transport.subscribe(() => {});
  unsubscribeAfterReplacement();
  const stateAfterResubscribe = transport.getClientState();
  assert.ok(stateAfterResubscribe.snapshot);
  assert.equal(stateAfterResubscribe.snapshot.worldRevision, transport.getClientWorld().worldRevision);
});

test("LocalTransport constructor and editor replacement clone their input worlds", () => {
  const initialWorld = createDefaultWorldState("room_transport_alias_constructor");
  const actorId = createPlayerId("player_transport_alias_constructor");
  initialWorld.players[actorId] = createDefaultPlayerState(actorId);

  const { transport, editor } = createLocalTransportSession(initialWorld, actorId);
  initialWorld.players[actorId].input.left = true;
  initialWorld.grid.set(0, 0, MaterialId.Sand);
  initialWorld.time = 99;

  const clientWorld = transport.getClientWorld();
  assert.equal(clientWorld.players[actorId].input.left, false);
  assert.equal(clientWorld.grid.get(0, 0), MaterialId.Empty);
  assert.notEqual(clientWorld.time, 99);

  const replacementWorld = createDefaultWorldState("room_transport_alias_replacement");
  const replacementActorId = createPlayerId("player_transport_alias_replacement");
  replacementWorld.players[replacementActorId] = createDefaultPlayerState(replacementActorId);

  editor.replaceWorld(replacementWorld);
  replacementWorld.players[replacementActorId].input.left = true;
  replacementWorld.grid.set(1, 1, MaterialId.Sand);
  replacementWorld.time = 77;

  const replacedWorld = transport.getClientWorld();
  assert.equal(replacedWorld.players[replacementActorId].input.left, false);
  assert.equal(replacedWorld.grid.get(1, 1), MaterialId.Empty);
  assert.notEqual(replacedWorld.time, 77);
});
