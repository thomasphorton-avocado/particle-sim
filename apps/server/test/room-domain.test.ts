import assert from "node:assert/strict";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import test from "node:test";
import { createGameplayRandomState, createPlayerId, type RoomId } from "@particle-sim/shared";
import { parseServerConfig } from "../src/config.js";
import { startServer } from "../src/main.js";
import { RoomAdmissionPolicy, createRoomAdmissionPolicyConfig } from "../src/room/admission.js";
import { Room, type RoomConfig, type RoomDependencies } from "../src/room/room.js";
import { DeadlineScheduler, ManualDeadlineTimerDriver, type Clock } from "../src/room/scheduler.js";
import { MemoryPublisher, RoomManager, type RoomTimerAdapter } from "../src/room/room-manager.js";
import type { RoomCommandAck, RoomPublication } from "../src/room/types.js";

let nextTestRoomOrdinal = 1;

class FakeClock implements Clock {
  #nowMs: number;
  #driver?: ManualDeadlineTimerDriver;

  constructor(startMs = 0, driver?: ManualDeadlineTimerDriver) {
    this.#nowMs = startMs;
    this.#driver = driver;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
    this.#driver?.advanceBy(ms);
  }
}

class TestPublisher {
  publications: RoomPublication[] = [];

  publish(publication: RoomPublication): void {
    this.publications.push(publication);
  }
}

class FakeTimingAdapter implements RoomTimerAdapter {
  #nowMs: number;
  #nextId: number;
  #pending: Array<{ id: number; callback: () => void; dueAt: number }>;

  constructor(startMs = 0) {
    this.#nowMs = startMs;
    this.#nextId = 1;
    this.#pending = [];
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.push({ id, callback, dueAt: this.#nowMs + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle !== "number") {
      return;
    }
    this.#pending = this.#pending.filter((entry) => entry.id !== handle);
  }

  advanceBy(ms: number): void {
    this.#nowMs += ms;
    while (true) {
      const dueEntries = this.#pending.filter((entry) => entry.dueAt <= this.#nowMs).sort((left, right) => left.dueAt - right.dueAt);
      if (dueEntries.length === 0) {
        return;
      }
      this.#pending = this.#pending.filter((entry) => !dueEntries.some((candidate) => candidate.id === entry.id));
      for (const entry of dueEntries) {
        entry.callback();
      }
    }
  }
}

function createTestRoom(configOverrides: Partial<RoomConfig> = {}) {
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const publisher = new TestPublisher();
  const roomId = `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId;
  const room = new Room(
    {
      roomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
      ...configOverrides,
    },
    { clock, scheduler, publisher } as RoomDependencies,
  );
  return { room, clock, scheduler, publisher, manualDriver };
}

test("rooms stay isolated while advancing deterministically", async () => {
  const roomA = createTestRoom();
  const roomB = createTestRoom();

  const joinA = roomA.room.enqueueJoin({ sessionId: "session-a", connectionId: "conn-a", connectionOrdinal: 1, generation: 1 });
  const joinB = roomB.room.enqueueJoin({ sessionId: "session-b", connectionId: "conn-b", connectionOrdinal: 1, generation: 1 });
  assert.equal(joinA.accepted, true);
  assert.equal(joinB.accepted, true);
  await roomA.room.flushPendingIngresses();
  await roomB.room.flushPendingIngresses();

  roomA.room.handleTick();
  roomB.room.handleTick();

  assert.equal(roomA.room.state.tick, 1);
  assert.equal(roomB.room.state.tick, 1);
  assert.notStrictEqual(roomA.room.world.players, roomB.room.world.players);
  assert.notEqual(roomA.room.world.roomId, roomB.room.world.roomId);
});

test("deadline scheduler catches up without overlap", () => {
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  let active = 0;
  let callbacks = 0;

  scheduler.start(() => {
    active += 1;
    callbacks += 1;
    assert.equal(active, 1);
    active -= 1;
  });

  clock.advance(250);

  assert.equal(callbacks, 2);
  assert.equal(scheduler.state.lastDelayKind, "catch-up");
});

test("interleaved commands keep per-membership sequence state", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "two", connectionId: "conn-2", connectionOrdinal: 2 }).accepted, true);
  await room.room.flushPendingIngresses();

  const [firstMembership, secondMembership] = room.room.memberships;
  const firstCommand = room.room.enqueueCommand({
    membershipId: firstMembership.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: firstMembership.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  const secondCommand = room.room.enqueueCommand({
    membershipId: secondMembership.membershipId,
    sessionId: "two",
    connectionId: "conn-2",
    connectionOrdinal: 4,
    generation: secondMembership.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  const thirdCommand = room.room.enqueueCommand({
    membershipId: firstMembership.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 5,
    generation: firstMembership.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });

  assert.equal(firstCommand.accepted, true);
  assert.equal(secondCommand.accepted, true);
  assert.equal(thirdCommand.accepted, true);
  await room.room.flushPendingIngresses();

  const receipts = room.room.world.commandLedger.recent as Array<{ actorSequence: number; actorId: string }>;
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map((receipt) => receipt.actorSequence), [1, 1, 2]);
  assert.equal(receipts[0]?.actorId, room.room.memberships[0]?.playerId);
  assert.equal(receipts[1]?.actorId, room.room.memberships[1]?.playerId);
});

test("capacity, reconnect, and owner transfer remain deterministic", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  assert.equal(room.room.enqueueJoin({ sessionId: "two", connectionId: "conn-2", connectionOrdinal: 2 }).accepted, true);
  await room.room.flushPendingIngresses();

  const firstMembership = room.room.memberships[0];
  const leave = room.room.enqueueLeave({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 3, generation: firstMembership.generation, membershipId: firstMembership.membershipId });
  assert.equal(leave.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 1);
  assert.equal(room.room.memberships[0]?.sessionId, "two");
  assert.equal(room.room.world.players[firstMembership.playerId], undefined);

  const rejoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 4 });
  assert.equal(rejoin.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 2);
  assert.ok(room.room.world.players[firstMembership.playerId]);
  assert.equal(room.room.memberships[0]?.owner, true);
});

test("stale generations and old connections are fenced before drain", async () => {
  const room = createTestRoom();

  assert.equal(room.room.enqueueJoin({ sessionId: "stale", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  const staleCommand = room.room.enqueueCommand({
    membershipId: membership.membershipId,
    sessionId: "stale",
    connectionId: "conn-2",
    connectionOrdinal: 2,
    generation: membership.generation + 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(staleCommand.accepted, false);
  assert.equal(staleCommand.code, "stale_membership");
});

test("empty rooms freeze while preserving deterministic world state", async () => {
  const room = createTestRoom();
  room.room.world.tick = 14;
  room.room.world.paused = true;
  room.room.world.weather.kind = "storm";
  room.room.world.weather.wind = -3;
  room.room.world.time.dayNightTick = 404;
  room.room.world.random = createGameplayRandomState(999);

  const before = {
    tick: room.room.state.tick,
    paused: room.room.world.paused,
    weatherKind: room.room.world.weather.kind,
    weatherWind: room.room.world.weather.wind,
    checksum: room.room.state.checksum,
    randomSeed: JSON.stringify(room.room.world.random),
  };

  room.room.handleTick();

  const after = {
    tick: room.room.state.tick,
    paused: room.room.world.paused,
    weatherKind: room.room.world.weather.kind,
    weatherWind: room.room.world.weather.wind,
    checksum: room.room.state.checksum,
    randomSeed: JSON.stringify(room.room.world.random),
  };

  assert.deepEqual(after, before);
});

test("idle cleanup applies the injected policy hook", async () => {
  const clock = new FakeClock();
  const manager = new RoomManager(
    { maxRooms: 8, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      clock,
      idleCleanupPolicy: (room) => clock.nowMs() - room.lastActivityAtMs > 100,
    },
  );

  const room = await manager.createRoom();
  clock.advance(200);
  const cleaned = await manager.cleanupIdleRooms(clock.nowMs());

  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0]?.roomId, room.roomId);
});

test("shutdown rejects queued ingress and blocks post-close joins", async () => {
  const room = createTestRoom();
  assert.equal(room.room.enqueueJoin({ sessionId: "shutdown", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const closePromise = room.room.beginShutdown("server_shutdown");
  const queuedJoin = room.room.enqueueJoin({ sessionId: "later", connectionId: "conn-2", connectionOrdinal: 2 });
  assert.equal(queuedJoin.accepted, false);
  await closePromise;

  const postCloseCommand = room.room.enqueueCommand({
    membershipId: room.room.memberships[0]?.membershipId ?? "",
    sessionId: "shutdown",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: room.room.memberships[0]?.generation ?? 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(postCloseCommand.accepted, false);
});

test("room manager shutdown times out on a never-resolving hook", async () => {
  const clock = new FakeClock();
  const timing = new FakeTimingAdapter();
  const manager = new RoomManager(
    { maxRooms: 4, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      clock,
      timing,
      hooks: {
        onClosed: () => new Promise<void>(() => undefined),
      },
    },
  );

  await manager.createRoom();
  const shutdownPromise = manager.shutdown(5);
  timing.advanceBy(5);
  await assert.rejects(shutdownPromise, /timed out/i);
  assert.equal(manager.roomCount, 0);
});

test("tick publications stay bounded and omit full snapshots", async () => {
  const publisher = new MemoryPublisher();
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const roomId = `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId;
  const room = new Room(
    {
      roomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
    },
    { clock, scheduler, publisher },
  );

  assert.equal(room.enqueueJoin({ sessionId: "publisher", connectionId: "conn-p", connectionOrdinal: 1 }).accepted, true);
  await room.flushPendingIngresses();

  for (let index = 0; index < 80; index += 1) {
    room.handleTick();
  }

  assert.ok(publisher.publications.length <= 64);
  const tickPublications = publisher.publications.filter((publication) => publication.reason === "tick");
  assert.ok(tickPublications.length > 0);
  assert.equal(tickPublications[0]?.snapshot, undefined);
});

test("reconnect restores player state and advances command sequence", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  const playerId = membership?.playerId;
  assert.ok(playerId);
  room.room.world.players[playerId].x = 99;
  room.room.world.players[playerId].input.jumpHeld = true;
  room.room.world.players[playerId].pendingRefunds = { stone: 3 };

  const firstCommand = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(firstCommand.accepted, true);
  await room.room.flushPendingIngresses();

  const leave = room.room.enqueueLeave({
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    membershipId: membership!.membershipId,
  });
  assert.equal(leave.accepted, true);
  await room.room.flushPendingIngresses();

  const rejoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 4 });
  assert.equal(rejoin.accepted, true);
  await room.room.flushPendingIngresses();

  const rejoinedMembership = room.room.memberships.find((entry) => entry.sessionId === "one");
  assert.ok(rejoinedMembership);
  const restoredPlayer = room.room.world.players[rejoinedMembership!.playerId];
  assert.equal(restoredPlayer?.x, 99);
  assert.equal(restoredPlayer?.input.jumpHeld, true);
  assert.deepEqual(restoredPlayer?.pendingRefunds, { stone: 3 });

  const secondCommand = room.room.enqueueCommand({
    membershipId: rejoinedMembership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1b",
    connectionOrdinal: 5,
    generation: rejoinedMembership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(secondCommand.accepted, true);
  await room.room.flushPendingIngresses();

  const receipts = room.room.world.commandLedger.recent as Array<{ actorSequence: number }>;
  assert.equal(receipts.at(-1)?.actorSequence, 2);
});

test("pending reservations keep an identity and reject duplicate joins", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  const firstJoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 });
  assert.equal(firstJoin.accepted, true);
  const duplicateJoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-2", connectionOrdinal: 2 });
  assert.equal(duplicateJoin.accepted, false);
  assert.equal(duplicateJoin.code, "join_pending");

  const command = room.room.enqueueCommand({
    membershipId: firstJoin.membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: firstJoin.membership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(command.accepted, false);
  assert.equal(command.code, "join_pending");
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships[0]?.membershipId, firstJoin.membership!.membershipId);
  assert.equal(room.room.world.commandLedger.recent.length, 0);
});

test("startServer rejects EADDRINUSE without uncaught errors", async () => {
  const blocker = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    blocker.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  const address = blocker.address() as AddressInfo;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error);
  };
  process.once("uncaughtException", onUncaught);
  try {
    const config = parseServerConfig({
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(address.port),
      MAX_ROOMS: "4",
      MIN_CAPACITY: "2",
      MAX_CAPACITY: "4",
      TICK_HZ: "60",
      MAX_CATCH_UP_TICKS: "3",
      SHUTDOWN_GRACE_MS: "2000",
      IDLE_CLEANUP_THRESHOLD_MS: "30000",
      RECONNECT_TIMEOUT_MS: "10000",
      RECONNECT_TOMBSTONE_LIMIT: "8",
    });
    await assert.rejects(startServer(config), (error: unknown) => {
      const nodeError = error as NodeJS.ErrnoException;
      assert.equal(nodeError.code, "EADDRINUSE");
      return true;
    });
    assert.deepEqual(uncaught, []);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
  }
});

test("handle.stop memoizes concurrent shutdown", async () => {
  const config = parseServerConfig({
    ...process.env,
    PORT: "0",
    HOST: "127.0.0.1",
    MAX_ROOMS: "4",
    MIN_CAPACITY: "2",
    MAX_CAPACITY: "4",
    TICK_HZ: "60",
    MAX_CATCH_UP_TICKS: "3",
    SHUTDOWN_GRACE_MS: "2000",
    IDLE_CLEANUP_THRESHOLD_MS: "30000",
    RECONNECT_TIMEOUT_MS: "10000",
    RECONNECT_TOMBSTONE_LIMIT: "8",
  });
  const handle = await startServer(config);
  try {
    const first = handle.stop();
    const second = handle.stop();
    assert.strictEqual(second, first);
    await Promise.all([first, second]);
    assert.equal(handle.server.listening, false);
  } finally {
    if (handle.server.listening) {
      await handle.stop();
    }
  }
});

test("command before leave still processes in queue order and later commands are rejected", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const command = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(command.accepted, true);

  const leave = room.room.enqueueLeave({
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    membershipId: membership!.membershipId,
  });
  assert.equal(leave.accepted, true);

  const laterCommand = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 4,
    generation: membership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(laterCommand.accepted, false);
  assert.equal(laterCommand.code, "leave_pending");

  await room.room.flushPendingIngresses();

  const receipts = room.room.world.commandLedger.recent as Array<{ actorSequence: number }>;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.actorSequence, 1);
  assert.equal(room.room.memberships.length, 0);
});

test("commands are rejected until the join reservation is realized", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  const commandBeforeJoin = room.room.enqueueCommand({
    membershipId: "membership_1",
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 1,
    generation: 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(commandBeforeJoin.accepted, false);
  assert.equal(commandBeforeJoin.code, "not_joined");

  const join = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 2 });
  assert.equal(join.accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const commandAfterJoin = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(commandAfterJoin.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.world.commandLedger.recent.length, 1);
});

test("admission policy enforces rate-window and backlog limits", () => {
  const clock = new FakeClock(0);
  const policy = new RoomAdmissionPolicy(
    createRoomAdmissionPolicyConfig({
      rateWindowMs: 1_000,
      rateLimit: 1,
      maxQueuedCommandsPerPlayer: 1,
      maxQueuedCommandsPerRoom: 1,
      maxCommandsPerPlayerPerTick: 2,
      maxCommandsPerTick: 2,
    }),
    clock,
  );

  const first = policy.enqueueCommand({
    membershipId: "membership_a",
    sessionId: "one",
    connectionId: "conn-a",
    generation: 1,
    playerId: createPlayerId("player_a"),
    actorSequence: 1,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(first.accepted, true);

  const rateLimited = policy.enqueueCommand({
    membershipId: "membership_a",
    sessionId: "one",
    connectionId: "conn-a",
    generation: 1,
    playerId: createPlayerId("player_a"),
    actorSequence: 2,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(rateLimited.accepted, false);
  assert.equal(rateLimited.code, "rate_limited");

  clock.advance(1_000);
  const roomBacklog = policy.enqueueCommand({
    membershipId: "membership_b",
    sessionId: "two",
    connectionId: "conn-b",
    generation: 1,
    playerId: createPlayerId("player_b"),
    actorSequence: 1,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(roomBacklog.accepted, false);
  assert.equal(roomBacklog.code, "room_backlog");
});

test("admission policy consumes connection and player buckets atomically", () => {
  const clock = new FakeClock(0);
  const policy = new RoomAdmissionPolicy(
    createRoomAdmissionPolicyConfig({
      rateWindowMs: 1_000,
      rateLimit: 2,
      maxQueuedCommandsPerPlayer: 4,
      maxQueuedCommandsPerRoom: 8,
      maxCommandsPerPlayerPerTick: 2,
      maxCommandsPerTick: 2,
    }),
    clock,
  );

  const first = policy.enqueueCommand({
    membershipId: "membership_a",
    sessionId: "one",
    connectionId: "conn-a",
    generation: 1,
    playerId: createPlayerId("player_a"),
    actorSequence: 1,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(first.accepted, true);

  const second = policy.enqueueCommand({
    membershipId: "membership_b",
    sessionId: "two",
    connectionId: "conn-b",
    generation: 1,
    playerId: createPlayerId("player_b"),
    actorSequence: 2,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(second.accepted, true);

  const third = policy.enqueueCommand({
    membershipId: "membership_c",
    sessionId: "three",
    connectionId: "conn-b",
    generation: 1,
    playerId: createPlayerId("player_b"),
    actorSequence: 3,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(third.accepted, true);

  const shouldFail = policy.enqueueCommand({
    membershipId: "membership_d",
    sessionId: "four",
    connectionId: "conn-a",
    generation: 1,
    playerId: createPlayerId("player_b"),
    actorSequence: 4,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(shouldFail.accepted, false);
  assert.equal(shouldFail.code, "rate_limited");

  const shouldSucceed = policy.enqueueCommand({
    membershipId: "membership_e",
    sessionId: "five",
    connectionId: "conn-a",
    generation: 1,
    playerId: createPlayerId("player_c"),
    actorSequence: 5,
    command: { type: "pause_world", expectedWorldRevision: 1 },
  });
  assert.equal(shouldSucceed.accepted, true);
});

test("admission policy drains players in round-robin order", () => {
  const clock = new FakeClock(0);
  const policy = new RoomAdmissionPolicy(
    createRoomAdmissionPolicyConfig({
      maxBatchSize: 4,
      maxCommandsPerTick: 4,
      maxCommandsPerPlayerPerTick: 1,
      maxQueuedCommandsPerPlayer: 4,
      maxQueuedCommandsPerRoom: 4,
    }),
    clock,
  );

  for (const [index, playerId] of [createPlayerId("player_a"), createPlayerId("player_b"), createPlayerId("player_c")].entries()) {
    const accepted = policy.enqueueCommand({
      membershipId: `membership_${index + 1}`,
      sessionId: `session_${index + 1}`,
      connectionId: `conn-${index + 1}`,
      generation: 1,
      playerId,
      actorSequence: index + 1,
      command: { type: "pause_world", expectedWorldRevision: 1 },
    });
    assert.equal(accepted.accepted, true);
  }

  const batch = policy.takeNextBatch(4, 1);
  assert.equal(batch.length, 3);
  assert.deepEqual(batch.map((entry) => entry.playerId), [createPlayerId("player_a"), createPlayerId("player_b"), createPlayerId("player_c")]);
});

test("deferred lifecycle ingress yields to the next boundary without spinning", { timeout: 1_000 }, async () => {
  const acks: RoomCommandAck[] = [];
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const publisher = new TestPublisher();
  const room = new Room(
    {
      roomId: `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
      admissionPolicy: {
        maxBatchSize: 2,
        rateWindowMs: 1_000,
        rateLimit: 16,
        maxQueuedCommandsPerPlayer: 16,
        maxQueuedCommandsPerRoom: 16,
        maxCommandsPerPlayerPerTick: 2,
        maxCommandsPerTick: 2,
        maxAckHistory: 64,
        maxRateBuckets: 16,
        rateBucketTtlMs: 2_000,
      },
    },
    {
      clock,
      scheduler,
      publisher,
      hooks: {
        onCommandAck: (_roomId: string, _membership: unknown, ack: RoomCommandAck) => {
          acks.push(ack);
        },
      },
    } as RoomDependencies,
  );

  assert.equal(room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.flushPendingIngresses();

  const membership = room.memberships[0];
  assert.ok(membership);
  const acceptedCommands = [1, 2, 3].map((actorSequence) => room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: actorSequence + 1,
    generation: membership!.generation,
    actorSequence,
    issuedTick: actorSequence,
    command: { type: "pause_world", expectedWorldRevision: room.state.worldRevision },
  }));
  for (const accepted of acceptedCommands) {
    assert.equal(accepted.accepted, true);
  }

  const leave = room.enqueueLeave({
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 5,
    generation: membership!.generation,
    membershipId: membership!.membershipId,
  });
  assert.equal(leave.accepted, true);

  room.handleTick();
  assert.equal(acks.length, 2);
  assert.equal(room.world.commandLedger.recent.length, 2);
  assert.equal(room.memberships.length, 1);
  assert.equal(room.ingressQueueSize, 1);

  room.handleTick();
  await room.flushPendingIngresses();

  assert.equal(acks.length, 3);
  assert.equal(room.world.commandLedger.recent.length, 3);
  assert.equal(room.memberships.length, 0);
});

test("duplicate replays reuse the original receipt without advancing sequence", async () => {
  const acks: RoomCommandAck[] = [];
  const room = createTestRoom();
  const hooks = {
    onCommandAck: (_roomId: string, _membership: unknown, ack: RoomCommandAck) => {
      acks.push(ack);
    },
  };
  const roomWithHooks = new Room(
    {
      roomId: `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
    },
    { clock: room.clock, scheduler: room.scheduler, publisher: room.publisher, hooks },
  );

  assert.equal(roomWithHooks.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await roomWithHooks.flushPendingIngresses();

  const membership = roomWithHooks.memberships[0];
  assert.ok(membership);
  const replayCommand = { type: "pause_world" as const, expectedWorldRevision: roomWithHooks.state.worldRevision };
  const first = roomWithHooks.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    actorSequence: 1,
    issuedTick: 1,
    command: replayCommand,
  });
  assert.equal(first.accepted, true);
  await roomWithHooks.flushPendingIngresses();

  const duplicate = roomWithHooks.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    actorSequence: 1,
    issuedTick: 1,
    command: replayCommand,
  });
  assert.equal(duplicate.accepted, true);
  await roomWithHooks.flushPendingIngresses();

  const conflicting = roomWithHooks.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 4,
    generation: membership!.generation,
    actorSequence: 1,
    issuedTick: 1,
    command: { type: "pause_world", expectedWorldRevision: roomWithHooks.state.worldRevision + 1 },
  });
  assert.equal(conflicting.accepted, false);
  assert.equal(conflicting.code, "conflicting_sequence");
  await roomWithHooks.flushPendingIngresses();

  assert.equal(roomWithHooks.world.commandLedger.recent.length, 1);
  assert.equal(acks.length, 3);
  assert.equal(acks[1]?.commandId, acks[0]?.commandId);
  assert.equal(acks[1]?.authorityOrder, acks[0]?.authorityOrder);
});

test("invalid actor and issued ticks are rejected before admission", async () => {
  const room = createTestRoom();

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const invalidSequence = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    actorSequence: 0,
    issuedTick: 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(invalidSequence.accepted, false);
  assert.equal(invalidSequence.code, "invalid_actor_sequence");

  const invalidTick = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    actorSequence: 1,
    issuedTick: -1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(invalidTick.accepted, false);
  assert.equal(invalidTick.code, "invalid_issued_tick");
  assert.equal(room.room.world.commandLedger.recent.length, 0);
});

test("future and stale sequences preserve authoritative high-water", async () => {
  const room = createTestRoom();

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const first = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    actorSequence: 1,
    issuedTick: 1,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(first.accepted, true);
  await room.room.flushPendingIngresses();

  const future = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    actorSequence: 3,
    issuedTick: 2,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(future.accepted, false);
  assert.equal(future.code, "future_sequence");

  const next = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 4,
    generation: membership!.generation,
    actorSequence: 2,
    issuedTick: 2,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(next.accepted, true);
  await room.room.flushPendingIngresses();

  const receipts = room.room.world.commandLedger.recent as Array<{ actorSequence: number }>;
  assert.deepEqual(receipts.map((receipt) => receipt.actorSequence), [1, 2]);
});

test("same-boundary leave replacement clears old command sequence state", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const leave = room.room.enqueueLeave({
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    membershipId: membership!.membershipId,
  });
  assert.equal(leave.accepted, true);

  const replacement = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 3 });
  assert.equal(replacement.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal(room.room.memberships.length, 1);
  assert.equal((room.room as unknown as { commandSequenceMapSize: number }).commandSequenceMapSize, 1);
});

test("oldest tombstones are evicted when reconnect state exceeds the bound", async () => {
  const room = createTestRoom({ maxCapacity: 2, reconnectTombstoneLimit: 2 });

  for (const sessionId of ["one", "two", "three"]) {
    assert.equal(room.room.enqueueJoin({ sessionId, connectionId: `${sessionId}-conn`, connectionOrdinal: 1 }).accepted, true);
    await room.room.flushPendingIngresses();
    const membership = room.room.memberships.find((entry) => entry.sessionId === sessionId);
    assert.ok(membership);
    const leave = room.room.enqueueLeave({
      sessionId,
      connectionId: `${sessionId}-conn`,
      connectionOrdinal: 2,
      generation: membership!.generation,
      membershipId: membership!.membershipId,
    });
    assert.equal(leave.accepted, true);
    await room.room.flushPendingIngresses();
  }

  const rejoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 3 });
  assert.equal(rejoin.accepted, true);
  assert.notEqual(rejoin.membership?.membershipId, "membership_1");
});

test("close-hook failures settle the room close promise", async () => {
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const publisher = new TestPublisher();
  const room = new Room(
    {
      roomId: `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
    },
    {
      clock,
      scheduler,
      publisher,
      hooks: {
        onClosed: async () => {
          throw new Error("boom");
        },
      },
    },
  );

  await assert.rejects(room.beginShutdown("server_shutdown"), /boom/);
  await assert.rejects(room.beginShutdown("server_shutdown"), /boom/);
});

test("command-ack hook failures stay contained", async () => {
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const publisher = new TestPublisher();
  const room = new Room(
    {
      roomId: `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
    },
    {
      clock,
      scheduler,
      publisher,
      hooks: {
        onCommandAck: () => {
          throw new Error("ack boom");
        },
      },
    },
  );

  assert.equal(room.enqueueJoin({ sessionId: "ack", connectionId: "conn-ack", connectionOrdinal: 1 }).accepted, true);
  await room.flushPendingIngresses();

  const command = room.enqueueCommand({
    membershipId: room.memberships[0]!.membershipId,
    sessionId: "ack",
    connectionId: "conn-ack",
    connectionOrdinal: 2,
    generation: room.memberships[0]!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.state.worldRevision },
  });
  assert.equal(command.accepted, true);
  await room.flushPendingIngresses();

  assert.equal(room.activeCommandReceipts.length, 1);
  assert.equal(room.state.tick, 0);
});

test("reconnect reservations stay pinned past tombstone expiry", async () => {
  const room = createTestRoom({ maxCapacity: 2, reconnectTimeoutMs: 50 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const playerId = membership!.playerId;
  room.room.world.players[playerId].x = 99;
  room.room.world.players[playerId].input.jumpHeld = true;
  room.room.world.players[playerId].pendingRefunds = { stone: 3 };

  const firstCommand = room.room.enqueueCommand({
    membershipId: membership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(firstCommand.accepted, true);
  await room.room.flushPendingIngresses();

  const leave = room.room.enqueueLeave({
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 3,
    generation: membership!.generation,
    membershipId: membership!.membershipId,
  });
  assert.equal(leave.accepted, true);
  await room.room.flushPendingIngresses();

  const reconnect = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 4 });
  assert.equal(reconnect.accepted, true);
  room.clock.advance(100);
  await room.room.flushPendingIngresses();

  const rejoinedMembership = room.room.memberships.find((entry) => entry.sessionId === "one");
  assert.ok(rejoinedMembership);
  const restoredPlayer = room.room.world.players[rejoinedMembership!.playerId];
  assert.equal(restoredPlayer?.x, 99);
  assert.equal(restoredPlayer?.input.jumpHeld, true);
  assert.deepEqual(restoredPlayer?.pendingRefunds, { stone: 3 });

  const secondCommand = room.room.enqueueCommand({
    membershipId: rejoinedMembership!.membershipId,
    sessionId: "one",
    connectionId: "conn-1b",
    connectionOrdinal: 5,
    generation: rejoinedMembership!.generation,
    command: { type: "pause_world", expectedWorldRevision: room.room.state.worldRevision },
  });
  assert.equal(secondCommand.accepted, true);
  await room.room.flushPendingIngresses();

  const receipts = room.room.world.commandLedger.recent as Array<{ actorSequence: number }>;
  assert.equal(receipts.at(-1)?.actorSequence, 2);
});

test("room manager shutdown surfaces room close failures as aggregate errors", async () => {
  const manager = new RoomManager(
    { maxRooms: 4, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      hooks: {
        onClosed: async () => {
          throw new Error("close failed");
        },
      },
    },
  );

  await manager.createRoom();
  await assert.rejects(manager.shutdown(5), /close failed/);
  assert.equal(manager.roomCount, 0);
});

test("room manager shutdown is idempotent while room hooks are pending", async () => {
  let resolveHook!: () => void;
  const pendingHook = new Promise<void>((resolve) => {
    resolveHook = resolve;
  });
  const manager = new RoomManager(
    { maxRooms: 4, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      hooks: {
        onClosed: () => pendingHook,
      },
    },
  );

  await manager.createRoom();
  const first = manager.shutdown(100);
  const second = manager.shutdown(100);
  assert.strictEqual(second, first);
  resolveHook();
  await first;
  await second;
});

test("failed idle cleanup removes the room and frees capacity", async () => {
  const clock = new FakeClock();
  const manager = new RoomManager(
    { maxRooms: 1, minCapacity: 2, maxCapacity: 2, tickHz: 60, maxCatchUpTicks: 2, idleCleanupThresholdMs: 100 },
    {
      clock,
      idleCleanupPolicy: () => true,
      hooks: {
        onClosed: async () => {
          throw new Error("cleanup failed");
        },
      },
    },
  );

  const room = await manager.createRoom();
  await assert.rejects(manager.cleanupIdleRooms(clock.nowMs()), /cleanup failed/);
  assert.equal(manager.roomCount, 0);
  assert.equal(manager.getRoom(room.roomId), undefined);
  const recovered = await manager.createRoom();
  assert.ok(recovered);
});

test("join and leave hooks run in order and drain on shutdown", async () => {
  const events: string[] = [];
  let resolveJoined!: () => void;
  const joinedBlocked = new Promise<void>((resolve) => {
    resolveJoined = resolve;
  });
  const manualDriver = new ManualDeadlineTimerDriver();
  const clock = new FakeClock(0, manualDriver);
  const scheduler = new DeadlineScheduler(clock, 100, 2, manualDriver);
  const publisher = new TestPublisher();
  const room = new Room(
    {
      roomId: `room_${String(nextTestRoomOrdinal++).padStart(4, "0")}` as RoomId,
      minCapacity: 2,
      maxCapacity: 2,
      tickHz: 60,
      maxCatchUpTicks: 2,
      idleCleanupThresholdMs: 1_000,
    },
    {
      clock,
      scheduler,
      publisher,
      hooks: {
        onJoined: async () => {
          events.push("join");
          await joinedBlocked;
        },
        onLeft: async () => {
          events.push("leave");
        },
      },
    },
  );

  assert.equal(room.enqueueJoin({ sessionId: "hooked", connectionId: "conn-hook", connectionOrdinal: 1 }).accepted, true);
  await room.flushPendingIngresses();

  const leave = room.enqueueLeave({
    sessionId: "hooked",
    connectionId: "conn-hook",
    connectionOrdinal: 2,
    generation: room.memberships[0]!.generation,
    membershipId: room.memberships[0]!.membershipId,
  });
  assert.equal(leave.accepted, true);
  await room.flushPendingIngresses();

  let closeSettled = false;
  const closePromise = room.beginShutdown("server_shutdown");
  void closePromise.then(() => {
    closeSettled = true;
  });
  await Promise.resolve();
  assert.equal(closeSettled, false);
  resolveJoined();
  await closePromise;
  assert.deepEqual(events, ["join", "leave"]);
});

test("reconnect churn prunes old command sequence state", async () => {
  const room = createTestRoom({ maxCapacity: 2 });

  assert.equal(room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1", connectionOrdinal: 1 }).accepted, true);
  await room.room.flushPendingIngresses();

  const membership = room.room.memberships[0];
  assert.ok(membership);
  const leave = room.room.enqueueLeave({
    sessionId: "one",
    connectionId: "conn-1",
    connectionOrdinal: 2,
    generation: membership!.generation,
    membershipId: membership!.membershipId,
  });
  assert.equal(leave.accepted, true);
  await room.room.flushPendingIngresses();

  const rejoin = room.room.enqueueJoin({ sessionId: "one", connectionId: "conn-1b", connectionOrdinal: 3 });
  assert.equal(rejoin.accepted, true);
  await room.room.flushPendingIngresses();

  assert.equal((room.room as unknown as { commandSequenceMapSize: number }).commandSequenceMapSize, 1);
});

test("parseServerConfig requires canonical integers and accepts valid boundaries", () => {
  const baseEnv = { NODE_ENV: "test", HOST: "127.0.0.1", PORT: "3000", MAX_ROOMS: "4", MIN_CAPACITY: "2", MAX_CAPACITY: "4", TICK_HZ: "60", MAX_CATCH_UP_TICKS: "3", SHUTDOWN_GRACE_MS: "2000", IDLE_CLEANUP_THRESHOLD_MS: "30000", RECONNECT_TIMEOUT_MS: "10000", RECONNECT_TOMBSTONE_LIMIT: "8" };
  const invalidCases = [
    ["PORT", "1.5"],
    ["MAX_ROOMS", "2e3"],
    ["TICK_HZ", "10ms"],
    ["SHUTDOWN_GRACE_MS", " 2000"],
    ["MIN_CAPACITY", "-2"],
  ] as const;

  for (const [key, value] of invalidCases) {
    assert.throws(() => parseServerConfig({ ...baseEnv, [key]: value }), /canonical integer|must be an integer/i);
  }

  const config = parseServerConfig({
    ...baseEnv,
    PORT: "3001",
    MAX_ROOMS: "1",
    MIN_CAPACITY: "2",
    MAX_CAPACITY: "4",
    TICK_HZ: "60",
    MAX_CATCH_UP_TICKS: "0",
    SHUTDOWN_GRACE_MS: "1",
    IDLE_CLEANUP_THRESHOLD_MS: "1",
    RECONNECT_TIMEOUT_MS: "1",
    RECONNECT_TOMBSTONE_LIMIT: "1",
  });

  assert.equal(config.port, 3001);
  assert.equal(config.maxRooms, 1);
  assert.equal(config.reconnectTimeoutMs, 1);
  assert.equal(config.reconnectTombstoneLimit, 1);
});
