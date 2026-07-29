import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWorldChecksum,
  createDefaultWorldState,
  createPlayerId,
  createStarterWorld,
  createWorldDelta,
  createWorldSnapshot,
  decodeProtocolMessage,
  encodeProtocolMessage,
  MAX_BATCH_COMMANDS,
  MAX_CELL_DELTAS,
  MAX_ENTITY_DELTAS,
  MAX_FRAME_BYTES,
  MAX_ID_LENGTH,
  MAX_METADATA_ENTRIES,
  MAX_STRING_LENGTH,
  MaterialId,
  PROTOCOL_VERSION,
  WORLD_SNAPSHOT_SCHEMA_VERSION,
  WORLD_STATE_SCHEMA_VERSION,
  createDefaultPlayerState,
  createRoomId,
} from "@particle-sim/shared";

function createProtocolFixture() {
  const roomId = createRoomId("room_proto");
  const world = createDefaultWorldState(roomId);
  const playerId = createPlayerId("player_proto");
  world.players[playerId] = createDefaultPlayerState(playerId);
  world.grid.set(0, 0, MaterialId.Wall);
  world.players[playerId].input.left = true;
  world.worldRevision += 1;
  const snapshot = createWorldSnapshot(world);
  const delta = createWorldDelta(snapshot, world);
  assert.ok(delta);
  return { roomId, playerId, world, snapshot, delta };
}

function createCommandBatch() {
  return {
    kind: "command_batch",
    streamSequence: 9,
    commands: [
      {
        clientSequence: 1,
        issuedTick: 3,
        command: { type: "set_input_state", left: true, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false },
      },
      {
        clientSequence: 2,
        issuedTick: 4,
        command: { type: "pause_world", expectedWorldRevision: 1 },
      },
    ],
  };
}

test("wraps serialization failures and validates literal unions with stable protocol errors", () => {
  assert.throws(() => encodeProtocolMessage({ value: 1n }), (error) => {
    assert.equal(error.code, "invalid_json");
    return true;
  });

  const fixture = createProtocolFixture();
  const unsupportedSnapshot = structuredClone(fixture.snapshot);
  unsupportedSnapshot.worldState.schemaVersion = 999999;
  assert.throws(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 1,
    snapshot: unsupportedSnapshot,
  }), (error) => {
    assert.equal(error.code, "unsupported_schema_version");
    return true;
  });

  assert.throws(() => decodeProtocolMessage({
    kind: "join_rejected",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 1,
    roomId: fixture.roomId,
    code: "bad_reason",
    message: "invalid",
  }), (error) => {
    assert.equal(error.code, "malformed_message");
    return true;
  });
});

test("accepts placement provenance and optional delta grid dimensions", () => {
  const fixture = createProtocolFixture();
  const placementSnapshot = structuredClone(fixture.snapshot);
  placementSnapshot.worldState.fallingObjects = {
    object_falling_one: {
      id: "object_falling_one",
      materialId: MaterialId.Clock,
      x: 0,
      y: 0,
      restY: 0,
      vy: 0,
      offsets: [[0, 0]],
      provenance: {
        kind: "placement",
        actorId: fixture.playerId,
        commandId: "command_1",
        sourceSlot: 0,
        materialId: MaterialId.Clock,
        amount: 1,
      },
    },
  };
  placementSnapshot.checksum = computeWorldChecksum(placementSnapshot);
  assert.doesNotThrow(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 2,
    snapshot: placementSnapshot,
  }));

  const fallingObjectDelta = structuredClone(fixture.delta);
  fallingObjectDelta.fallingObjects = [{
    objectId: "object_falling_one",
    state: {
      id: "object_falling_one",
      materialId: MaterialId.Clock,
      x: 0,
      y: 0,
      restY: 0,
      vy: 0,
      offsets: [[0, 0]],
      provenance: { kind: "legacy" },
    },
  }];
  delete fallingObjectDelta.gridDimensions;
  assert.doesNotThrow(() => decodeProtocolMessage({
    kind: "delta",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 3,
    delta: fallingObjectDelta,
  }));
});

test("rejects deeply nested values, oversized object keys, and strict nested metadata unions", () => {
  const fixture = createProtocolFixture();

  let deepValue = { value: 0 };
  for (let index = 0; index < 80; index += 1) {
    deepValue = { value: deepValue };
  }
  const deepSnapshot = structuredClone(fixture.snapshot);
  deepSnapshot.worldState.paused = deepValue;
  assert.throws(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 100,
    snapshot: deepSnapshot,
  }), /malformed_message/);

  const oversizedKeySnapshot = structuredClone(fixture.snapshot);
  oversizedKeySnapshot.worldState.players = {
    [`x`.repeat(MAX_STRING_LENGTH + 1)]: structuredClone(fixture.snapshot.worldState.players[fixture.playerId]),
  };
  assert.throws(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 101,
    snapshot: oversizedKeySnapshot,
  }), /malformed_message/);

  const invalidHotbarSnapshot = structuredClone(fixture.snapshot);
  invalidHotbarSnapshot.worldState.players[fixture.playerId].hotbar = [{ kind: "bogus" }];
  assert.throws(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 102,
    snapshot: invalidHotbarSnapshot,
  }), /malformed_message/);

  const invalidWeatherSnapshot = structuredClone(fixture.snapshot);
  invalidWeatherSnapshot.worldState.weather = {
    kind: "blizzard",
    episodeElapsed: 0,
    episodeDuration: 1,
    wind: 0,
    visualTime: 0,
    rainAccumulator: 0,
    lightningFlash: null,
    lightningCooldown: null,
    boltX: null,
    boltY: null,
    boltSeed: 1,
  };
  assert.throws(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 103,
    snapshot: invalidWeatherSnapshot,
  }), /malformed_message/);

  const invalidMetadataDelta = structuredClone(fixture.delta);
  invalidMetadataDelta.metadata = [{ field: "time", value: { dayNightTick: 0, unexpected: true } }];
  assert.throws(() => decodeProtocolMessage({
    kind: "delta",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 104,
    delta: invalidMetadataDelta,
  }), /unknown_field/);

  const presentGridDelta = structuredClone(fixture.delta);
  presentGridDelta.gridDimensions = { width: 3, height: 4 };
  assert.doesNotThrow(() => decodeProtocolMessage({
    kind: "delta",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 105,
    delta: presentGridDelta,
  }));
});

test("accepts large starter-world snapshots within the decoder work budget", () => {
  const world = createStarterWorld({ roomId: "room_starter" });
  const snapshot = createWorldSnapshot(world);
  assert.doesNotThrow(() => decodeProtocolMessage({
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 12,
    snapshot,
  }));
});

test("round-trips every protocol message variant", () => {
  const fixture = createProtocolFixture();
  const messages = [
    {
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      clientId: "client_1",
      clientName: "tester",
    },
    {
      kind: "join",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      roomId: fixture.roomId,
      resumeToken: "resume-1",
    },
    {
      kind: "join_accepted",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      streamSequence: 1,
      roomId: fixture.roomId,
      playerId: fixture.playerId,
    },
    {
      kind: "join_rejected",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      streamSequence: 2,
      roomId: fixture.roomId,
      code: "room_full",
      message: "room is full",
    },
    createCommandBatch(),
    {
      kind: "command_acknowledgement",
      streamSequence: 3,
      acknowledgements: [
        {
          clientSequence: 1,
          issuedTick: 3,
          accepted: true,
          code: "accepted",
          authorityOrder: 12,
          processedTick: 7,
          beforeWorldRevision: 0,
          afterWorldRevision: 1,
          beforeInventoryRevision: 0,
          afterInventoryRevision: 1,
          beforeTargetRevision: 0,
          afterTargetRevision: 1,
          acceptedEffect: null,
        },
      ],
    },
    {
      kind: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      streamSequence: 4,
      snapshot: fixture.snapshot,
    },
    {
      kind: "delta",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      streamSequence: 5,
      delta: fixture.delta,
    },
    {
      kind: "resync_request",
      streamSequence: 6,
      reason: "delta_gap",
      lastKnownStreamSequence: 4,
      lastKnownWorldRevision: fixture.snapshot.worldRevision,
    },
    {
      kind: "resync_required",
      streamSequence: 7,
      reason: "stale",
      lastKnownStreamSequence: 5,
      lastKnownWorldRevision: fixture.snapshot.worldRevision,
    },
    {
      kind: "protocol_error",
      streamSequence: 8,
      code: "unsupported_message_kind",
      message: "unsupported type",
    },
    {
      kind: "ping",
      streamSequence: 9,
      nonce: "nonce-1",
    },
    {
      kind: "pong",
      streamSequence: 10,
      nonce: "nonce-1",
    },
    {
      kind: "room_closed",
      streamSequence: 11,
      code: "room_closed",
      reason: "server shutdown",
    },
  ];

  for (const message of messages) {
    const encoded = encodeProtocolMessage(message);
    assert.ok(encoded.byteLength <= MAX_FRAME_BYTES);
    const restored = decodeProtocolMessage(encoded);
    assert.deepEqual(restored, message);
  }
});

test("rejects frame size overshoots and accepts the boundary when within the limit", () => {
  const message = { kind: "ping", streamSequence: 0, nonce: "" };
  const encoded = encodeProtocolMessage(message);
  assert.ok(encoded.byteLength <= MAX_FRAME_BYTES);

  const oversized = new Uint8Array(MAX_FRAME_BYTES + 1);
  assert.throws(() => decodeProtocolMessage(oversized), /frame_too_large/);

  let low = 0;
  let high = MAX_FRAME_BYTES;
  let bestNonce = "";
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = "x".repeat(mid);
    try {
      const candidateBytes = encodeProtocolMessage({ kind: "ping", streamSequence: 0, nonce: candidate });
      if (candidateBytes.byteLength <= MAX_FRAME_BYTES) {
        bestNonce = candidate;
        low = mid;
      } else {
        high = mid - 1;
      }
    } catch {
      high = mid - 1;
    }
  }
  const boundaryBytes = encodeProtocolMessage({ kind: "ping", streamSequence: 0, nonce: bestNonce });
  assert.ok(boundaryBytes.byteLength <= MAX_FRAME_BYTES);
  assert.throws(() => encodeProtocolMessage({ kind: "ping", streamSequence: 0, nonce: `${bestNonce}x` }), /frame_too_large/);
});

test("rejects malformed JSON, unsupported versions, and unsupported schemas", () => {
  assert.throws(() => decodeProtocolMessage(new Uint8Array([0x7b, 0x22, 0x6b, 0x69, 0x6e, 0x64])), /malformed_message/);
  assert.throws(() => decodeProtocolMessage("{not-json"), /malformed_message/);

  assert.throws(
    () => decodeProtocolMessage({
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION + 1,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    }),
    /unsupported_protocol_version/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION + 1,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    }),
    /unsupported_schema_version/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION + 1,
    }),
    /unsupported_schema_version/,
  );
});

test("rejects unknown fields and invalid IDs, integers, revisions, and dimensions", () => {
  assert.throws(
    () => decodeProtocolMessage({
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      unexpected: true,
    }),
    /unknown_field/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "join",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      roomId: "bad-identifier",
    }),
    /invalid_id/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "command_batch",
      streamSequence: -1,
      commands: [],
    }),
    /invalid_integer/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "delta",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      streamSequence: 1,
      delta: {
        version: 1,
        baseRevision: 3,
        targetRevision: 2,
        cells: [],
        players: [],
        fallingObjects: [],
        metadata: [],
      },
    }),
    /invalid_revision/,
  );
});

test("rejects client identity, invalid unions, and bounded gameplay commands", () => {
  const fixture = createProtocolFixture();
  assert.throws(
    () => decodeProtocolMessage({
      kind: "join",
      protocolVersion: PROTOCOL_VERSION,
      worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
      worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
      roomId: fixture.roomId,
      playerId: createPlayerId("player_join"),
    }),
    /unknown_field/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "command_acknowledgement",
      streamSequence: 1,
      acknowledgements: [{ clientSequence: 1, issuedTick: 1, accepted: false, code: "accepted" }],
    }),
    /invalid_union|malformed_message/,
  );

  assert.throws(
    () => decodeProtocolMessage({
      kind: "command_batch",
      streamSequence: 1,
      commands: [{
        clientSequence: 1,
        issuedTick: 1,
        command: {
          type: "cycle_faucet",
          objectId: `object-${"x".repeat(MAX_ID_LENGTH + 1)}`,
        },
      }],
    }),
    /invalid_id|invalid_integer|malformed_message/,
  );
});

test("deterministic fuzz input is rejected or round-tripped safely", () => {
  let seed = 0xC0FFEE;
  for (let index = 0; index < 128; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const candidate = seed % 3 === 0
      ? { kind: "ping", streamSequence: seed & 0x3ff, nonce: `n${seed}` }
      : seed % 3 === 1
        ? { kind: "hello", protocolVersion: PROTOCOL_VERSION, worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION, worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION, clientName: `x${seed}` }
        : {
            kind: "join",
            protocolVersion: PROTOCOL_VERSION,
            worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
            worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
            roomId: `room_${seed}`,
          };
    if (candidate.kind === "join" && candidate.roomId.length > 128) {
      continue;
    }
    try {
      const decoded = decodeProtocolMessage(candidate);
      assert.ok(decoded);
      const reEncoded = encodeProtocolMessage(decoded);
      const roundTripped = decodeProtocolMessage(reEncoded);
      assert.deepEqual(roundTripped, decoded);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});

test("rejects oversized batches, cells, entities, and decoder work budgets", () => {
  const oversizedBatch = {
    kind: "command_batch",
    streamSequence: 0,
    commands: Array.from({ length: MAX_BATCH_COMMANDS + 1 }, (_value, index) => ({
      clientSequence: index,
      issuedTick: index,
      command: { type: "set_input_state", left: false, right: false, jumpHeld: false, crouchHeld: false, lookUpHeld: false },
    })),
  };
  assert.throws(() => decodeProtocolMessage(oversizedBatch), /batch_too_large/);

  const oversizedCells = {
    kind: "delta",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 1,
    delta: {
      version: 1,
      baseRevision: 0,
      targetRevision: 1,
      cells: Array.from({ length: MAX_CELL_DELTAS + 1 }, (_value, index) => ({ index, materialId: MaterialId.Empty, shade: 0, auxiliary: 0, objectId: null, revision: 1 })),
      players: [],
      fallingObjects: [],
      metadata: [],
    },
  };
  assert.throws(() => decodeProtocolMessage(oversizedCells), /cell_too_large/);

  const oversizedEntities = {
    kind: "delta",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 1,
    delta: {
      version: 1,
      baseRevision: 0,
      targetRevision: 1,
      cells: [],
      players: Array.from({ length: MAX_ENTITY_DELTAS + 1 }, (_value, index) => ({ playerId: `player_${index}`, state: null })),
      fallingObjects: [],
      metadata: [],
    },
  };
  assert.throws(() => decodeProtocolMessage(oversizedEntities), /entity_too_large/);

  const oversizedMetadata = {
    kind: "delta",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    streamSequence: 1,
    delta: {
      version: 1,
      baseRevision: 0,
      targetRevision: 1,
      cells: [],
      players: [],
      fallingObjects: [],
      metadata: Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_value, index) => ({ field: "tick", value: index })),
    },
  };
  assert.throws(() => decodeProtocolMessage(oversizedMetadata), /entity_too_large/);

  const pathological = {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    worldSnapshotSchemaVersion: WORLD_SNAPSHOT_SCHEMA_VERSION,
    worldStateSchemaVersion: WORLD_STATE_SCHEMA_VERSION,
    clientName: "x".repeat(200_000),
  };
  assert.throws(() => decodeProtocolMessage(pathological), /malformed_message|decoder_work_limit_exceeded/);
});
