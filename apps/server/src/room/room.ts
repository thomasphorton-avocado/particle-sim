import {
  advanceWorldTick,
  computeWorldChecksum,
  createCommandId,
  createDefaultPlayerState,
  createDefaultWorldState,
  createPlayerId,
  createWorldSnapshot,
  enqueueCommand,
  processPendingCommands,
  type CommandReceipt,
  type CommandEnvelope,
  type GameplayCommand,
  type PlayerId,
  type RoomId,
} from "@particle-sim/shared";
import type { WorldState } from "@particle-sim/shared";
import { createDefaultRoomId } from "../config.js";
import type { Clock } from "./scheduler.js";
import type { DeadlineSchedulerState, RoomScheduler } from "./scheduler.js";
import type { CommandRequest, JoinRequest, LeaveRequest, RoomIngress, RoomPublication, RoomPublisher, RoomTransportHooks, RoomLifecycleReason, RoomMemberState } from "./types.js";

export interface RoomStateSummary {
  readonly roomId: RoomId;
  readonly tick: number;
  readonly worldRevision: number;
  readonly checksum: string;
  readonly capacity: number;
  readonly memberships: RoomMemberState[];
  readonly ownerPlayerId: PlayerId | null;
  readonly schedulerSuspended: boolean;
  readonly closing: boolean;
}

interface MembershipRecord {
  membershipId: string;
  playerId: PlayerId;
  sessionId: string;
  connectionId: string;
  generation: number;
  joinOrdinal: number;
  receiveOrdinal: number;
  connected: boolean;
  owner: boolean;
  joinedAtTick: number;
  leftAtTick: number | null;
}

export interface RoomConfig {
  readonly roomId: RoomId;
  readonly minCapacity: number;
  readonly maxCapacity: number;
  readonly tickHz: number;
  readonly maxCatchUpTicks: number;
  readonly idleCleanupThresholdMs: number;
}

export interface RoomDependencies {
  readonly clock: Clock;
  readonly scheduler: RoomScheduler;
  readonly publisher: RoomPublisher;
  readonly hooks?: RoomTransportHooks;
}

export class Room {
  #roomId: RoomId;
  #config: RoomConfig;
  #clock: Clock;
  #scheduler: RoomScheduler;
  #publisher: RoomPublisher;
  #hooks?: RoomTransportHooks;
  #world: WorldState;
  #membershipsById: Map<string, MembershipRecord>;
  #membershipsBySession: Map<string, MembershipRecord>;
  #tombstonesBySession: Map<string, MembershipRecord>;
  #ingressQueue: RoomIngress[];
  #nextJoinOrdinal: number;
  #nextReceiveOrdinal: number;
  #nextMembershipGeneration: number;
  #tickInProgress: boolean;
  #closing: boolean;
  #shutdownRequested: boolean;
  #schedulerSuspended: boolean;
  #closePromise: Promise<void>;
  #resolveClosePromise: (() => void) | null = null;
  #shutdownReason: RoomLifecycleReason | null;
  #lastPublication: RoomPublication | null;
  #lastActivityAtMs: number;
  #activeCommandReceipts: CommandReceipt[];
  #commandSequencesByMembership: Map<string, number>;
  #tombstoneLifetimeTicks: number;

  constructor(config: RoomConfig, dependencies: RoomDependencies) {
    this.#roomId = config.roomId;
    this.#config = config;
    this.#clock = dependencies.clock;
    this.#scheduler = dependencies.scheduler;
    this.#publisher = dependencies.publisher;
    this.#hooks = dependencies.hooks;
    this.#world = createDefaultWorldState(config.roomId);
    this.#membershipsById = new Map();
    this.#membershipsBySession = new Map();
    this.#tombstonesBySession = new Map();
    this.#ingressQueue = [];
    this.#nextJoinOrdinal = 1;
    this.#nextReceiveOrdinal = 1;
    this.#nextMembershipGeneration = 1;
    this.#tickInProgress = false;
    this.#closing = false;
    this.#shutdownRequested = false;
    this.#schedulerSuspended = true;
    this.#shutdownReason = null;
    this.#lastPublication = null;
    this.#lastActivityAtMs = this.#clock.nowMs();
    this.#activeCommandReceipts = [];
    this.#commandSequencesByMembership = new Map();
    this.#tombstoneLifetimeTicks = Math.max(2, config.maxCapacity * 2);
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClosePromise = resolve;
    });

    this.#scheduler.stop();
  }

  get roomId(): RoomId {
    return this.#roomId;
  }

  get world(): WorldState {
    return this.#world;
  }

  get state(): RoomStateSummary {
    return {
      roomId: this.#roomId,
      tick: this.#world.tick,
      worldRevision: this.#world.worldRevision,
      checksum: this.checksum,
      capacity: this.#config.maxCapacity,
      memberships: this.memberships,
      ownerPlayerId: this.#world.ownerPlayerId,
      schedulerSuspended: this.#schedulerSuspended,
      closing: this.#closing,
    };
  }

  get schedulerState(): DeadlineSchedulerState {
    return this.#scheduler.state;
  }

  get memberships(): RoomMemberState[] {
    return Array.from(this.#membershipsById.values())
      .filter((membership) => membership.connected)
      .sort((left, right) => left.joinOrdinal - right.joinOrdinal)
      .map((membership) => ({
        membershipId: membership.membershipId,
        playerId: membership.playerId,
        sessionId: membership.sessionId,
        connectionId: membership.connectionId,
        generation: membership.generation,
        joinOrdinal: membership.joinOrdinal,
        receiveOrdinal: membership.receiveOrdinal,
        connected: membership.connected,
        owner: membership.owner,
      }));
  }

  get checksum(): string {
    return computeWorldChecksum(this.#world);
  }

  get ingressQueueSize(): number {
    return this.#ingressQueue.length;
  }

  get closing(): boolean {
    return this.#closing;
  }

  get tickInProgress(): boolean {
    return this.#tickInProgress;
  }

  get closePromise(): Promise<void> {
    return this.#closePromise;
  }

  get lastPublication(): RoomPublication | null {
    return this.#lastPublication;
  }

  get lastActivityAtMs(): number {
    return this.#lastActivityAtMs;
  }

  get activeCommandReceipts(): readonly CommandReceipt[] {
    return this.#activeCommandReceipts;
  }

  async beginShutdown(reason: RoomLifecycleReason): Promise<void> {
    if (this.#closing) {
      return this.#closePromise;
    }
    this.#closing = true;
    this.#shutdownRequested = true;
    this.#shutdownReason = reason;
    this.#schedulerSuspended = true;
    this.#scheduler.stop();
    this.#ingressQueue.length = 0;
    this.#pruneExpiredTombstones();
    this.#lastActivityAtMs = this.#clock.nowMs();
    if (this.#tickInProgress) {
      return this.#closePromise;
    }
    await this.publishClosing(reason);
    this.resolveClose();
    return this.#closePromise;
  }

  enqueueJoin(request: JoinRequest): { accepted: boolean; membership?: RoomMemberState; code?: string; message?: string } {
    this.#lastActivityAtMs = this.#clock.nowMs();
    if (this.#closing) {
      return { accepted: false, code: "room_closed", message: "room is closed" };
    }
    this.#pruneExpiredTombstones();
    if (this.#projectedMembershipCount() >= this.#config.maxCapacity) {
      return { accepted: false, code: "room_full", message: "room is full" };
    }
    const existing = this.#membershipsBySession.get(request.sessionId);
    const tombstone = this.#tombstonesBySession.get(request.sessionId);
    const reconnecting = Boolean(tombstone && !this.#tombstoneExpired(tombstone));
    const pendingLeave = this.#hasPendingLeave(request.sessionId);
    if (existing && existing.connected && !pendingLeave && !reconnecting) {
      return { accepted: false, code: "already_joined", message: "session already joined" };
    }
    const joinOrdinal = reconnecting ? tombstone!.joinOrdinal : this.#nextJoinOrdinal;
    if (!reconnecting) {
      this.#nextJoinOrdinal += 1;
    }
    const membershipId = reconnecting ? tombstone!.membershipId : `membership_${joinOrdinal}`;
    const generation = this.#nextMembershipGeneration;
    this.#nextMembershipGeneration += 1;
    const ingress: RoomIngress = {
      kind: "join",
      membershipId,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      connectionOrdinal: request.connectionOrdinal,
      receiveOrdinal: this.#nextReceiveOrdinal,
      generation,
      joinOrdinal,
      playerId: reconnecting ? tombstone!.playerId : undefined,
    };
    this.#nextReceiveOrdinal += 1;
    this.#ingressQueue.push(ingress);
    return { accepted: true, membership: this.#membershipSummaryForIngress(ingress) };
  }

  enqueueLeave(request: LeaveRequest): { accepted: boolean; code?: string; message?: string } {
    this.#lastActivityAtMs = this.#clock.nowMs();
    if (this.#closing) {
      return { accepted: false, code: "room_closed", message: "room is closed" };
    }
    const membership = this.#membershipsBySession.get(request.sessionId);
    if (!membership || !membership.connected) {
      return { accepted: false, code: "not_joined", message: "session is not joined" };
    }
    if (request.membershipId === undefined || request.connectionId === undefined || request.generation === undefined) {
      return { accepted: false, code: "invalid_request", message: "membership id, connection id, and generation are required" };
    }
    if (request.membershipId !== membership.membershipId || request.connectionId !== membership.connectionId || request.generation !== membership.generation) {
      return { accepted: false, code: "stale_membership", message: "membership identity is stale" };
    }
    const ingress: RoomIngress = {
      kind: "leave",
      membershipId: membership.membershipId,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      connectionOrdinal: request.connectionOrdinal,
      receiveOrdinal: this.#nextReceiveOrdinal,
      generation: membership.generation,
    };
    this.#nextReceiveOrdinal += 1;
    this.#ingressQueue.push(ingress);
    return { accepted: true };
  }

  enqueueCommand(request: CommandRequest): { accepted: boolean; code?: string; message?: string } {
    this.#lastActivityAtMs = this.#clock.nowMs();
    if (this.#closing) {
      return { accepted: false, code: "room_closed", message: "room is closed" };
    }
    const membership = this.#membershipsBySession.get(request.sessionId);
    if (!membership || !membership.connected) {
      return { accepted: false, code: "not_joined", message: "session is not joined" };
    }
    if (request.membershipId === undefined || request.connectionId === undefined || request.generation === undefined) {
      return { accepted: false, code: "invalid_request", message: "membership id, connection id, and generation are required" };
    }
    if (request.membershipId !== membership.membershipId || request.connectionId !== membership.connectionId || request.generation !== membership.generation) {
      return { accepted: false, code: "stale_membership", message: "membership identity is stale" };
    }
    const ingress: RoomIngress = {
      kind: "command",
      membershipId: membership.membershipId,
      sessionId: request.sessionId,
      connectionId: request.connectionId,
      connectionOrdinal: request.connectionOrdinal,
      receiveOrdinal: this.#nextReceiveOrdinal,
      generation: membership.generation,
      command: this.#buildCommandEnvelope(membership, request.command),
    };
    this.#nextReceiveOrdinal += 1;
    this.#ingressQueue.push(ingress);
    return { accepted: true };
  }

  handleTick(): void {
    if (this.#tickInProgress) {
      return;
    }
    this.#tickInProgress = true;
    try {
      if (this.#closing) {
        return;
      }
      this.processQueuedLifecycle();
      if (!this.#closing) {
        this.#applyAuthoritativeTick();
        this.publishSnapshot("tick");
      }
      if (this.#shutdownRequested && this.#closing) {
        this.publishClosing(this.#shutdownReason ?? "server_shutdown");
        this.resolveClose();
      }
    } finally {
      this.#tickInProgress = false;
    }
  }

  async flushPendingIngresses(): Promise<void> {
    if (this.#tickInProgress || this.#closing) {
      return;
    }
    this.processQueuedLifecycle();
  }

  private processQueuedLifecycle(): void {
    if (this.#closing) {
      return;
    }
    while (this.#ingressQueue.length > 0) {
      const ingress = this.#ingressQueue.shift();
      if (!ingress) {
        break;
      }
      this.processIngress(ingress);
    }
  }

  private processIngress(ingress: RoomIngress): void {
    if (ingress.kind === "join") {
      this.applyJoin(ingress);
      return;
    }
    if (ingress.kind === "leave") {
      this.applyLeave(ingress);
      return;
    }
    this.applyCommand(ingress);
  }

  private applyJoin(ingress: RoomIngress): void {
    if (this.#closing) {
      return;
    }
    this.#pruneExpiredTombstones();
    const existing = this.#membershipsBySession.get(ingress.sessionId);
    if (existing && existing.connected) {
      return;
    }
    const tombstone = this.#tombstonesBySession.get(ingress.sessionId);
    const reconnecting = Boolean(tombstone && !this.#tombstoneExpired(tombstone));
    if (reconnecting) {
      const membership = tombstone!;
      membership.connected = true;
      membership.connectionId = ingress.connectionId;
      membership.generation = ingress.generation;
      membership.receiveOrdinal = ingress.receiveOrdinal;
      membership.leftAtTick = null;
      membership.joinedAtTick = this.#world.tick;
      this.#commandSequencesByMembership.set(membership.membershipId, 1);
      this.#tombstonesBySession.delete(membership.sessionId);
      this.#membershipsById.set(membership.membershipId, membership);
      this.#membershipsBySession.set(membership.sessionId, membership);
      this.#world.players[membership.playerId] = createDefaultPlayerState(membership.playerId);
      this.#world.ownerPlayerId = this.#world.ownerPlayerId ?? membership.playerId;
      this.#reconcileOwner();
      this.#schedulerSuspended = false;
      this.#scheduler.start(() => {
        this.handleTick();
      });
      this.#lastActivityAtMs = this.#clock.nowMs();
      this.publishMembership();
      return;
    }
    if (this.#activeMembershipCount() >= this.#config.maxCapacity) {
      return;
    }
    const membership = this.#createMembershipRecord(ingress);
    this.#membershipsById.set(membership.membershipId, membership);
    this.#membershipsBySession.set(membership.sessionId, membership);
    this.#commandSequencesByMembership.set(membership.membershipId, 1);
    this.#world.players[membership.playerId] = createDefaultPlayerState(membership.playerId);
    this.#world.nextPlayerOrdinal = this.#world.nextPlayerOrdinal + 1;
    this.#world.ownerPlayerId = this.#world.ownerPlayerId ?? membership.playerId;
    this.#reconcileOwner();
    this.#schedulerSuspended = false;
    this.#scheduler.start(() => {
      this.handleTick();
    });
    this.#lastActivityAtMs = this.#clock.nowMs();
    this.publishMembership();
  }

  private applyLeave(ingress: RoomIngress): void {
    if (this.#closing) {
      return;
    }
    const membership = this.#membershipsBySession.get(ingress.sessionId);
    if (!membership || !membership.connected) {
      return;
    }
    if (membership.membershipId !== ingress.membershipId || membership.connectionId !== ingress.connectionId || membership.generation !== ingress.generation) {
      return;
    }
    membership.connected = false;
    membership.leftAtTick = this.#world.tick;
    this.#membershipsBySession.delete(ingress.sessionId);
    this.#membershipsById.delete(membership.membershipId);
    delete this.#world.players[membership.playerId];
    this.#tombstonesBySession.set(membership.sessionId, membership);
    this.#reconcileOwner();
    this.#schedulerSuspended = this.#activeMembershipCount() === 0;
    if (this.#schedulerSuspended) {
      this.#scheduler.stop();
    }
    this.#pruneExpiredTombstones();
    this.#lastActivityAtMs = this.#clock.nowMs();
    this.publishMembership();
  }

  private applyCommand(ingress: RoomIngress): void {
    if (this.#closing) {
      return;
    }
    const membership = this.#membershipsBySession.get(ingress.sessionId);
    if (!membership || !membership.connected) {
      return;
    }
    if (membership.membershipId !== ingress.membershipId || membership.connectionId !== ingress.connectionId || membership.generation !== ingress.generation) {
      return;
    }
    const envelope = ingress.command;
    if (!envelope) {
      return;
    }
    enqueueCommand(this.#world, envelope);
    const results = processPendingCommands(this.#world);
    if (results.length > 0) {
      const receipt = this.#world.commandLedger.recent[this.#world.commandLedger.recent.length - 1] as CommandReceipt | undefined;
      if (receipt) {
        this.#activeCommandReceipts = [receipt];
        this.#hooks?.onCommandAck?.(this.#roomId, this.#membershipSummary(membership), receipt);
      }
    }
  }

  #buildCommandEnvelope(membership: MembershipRecord, command: GameplayCommand): CommandEnvelope {
    const actorSequence = this.#getNextCommandSequence(membership.membershipId);
    return {
      commandId: createCommandId(`command_${actorSequence}`),
      actorId: membership.playerId,
      actorSequence,
      issuedTick: this.#world.tick,
      command,
    };
  }

  #getNextCommandSequence(membershipId: string): number {
    const nextSequence = this.#commandSequencesByMembership.get(membershipId) ?? 1;
    this.#commandSequencesByMembership.set(membershipId, nextSequence + 1);
    return nextSequence;
  }

  #createMembershipRecord(ingress: RoomIngress): MembershipRecord {
    const joinOrdinal = ingress.joinOrdinal ?? this.#nextJoinOrdinal;
    const playerId = ingress.playerId ?? createPlayerId(`player_${joinOrdinal}`);
    const membership: MembershipRecord = {
      membershipId: ingress.membershipId,
      playerId,
      sessionId: ingress.sessionId,
      connectionId: ingress.connectionId,
      generation: ingress.generation,
      joinOrdinal,
      receiveOrdinal: ingress.receiveOrdinal,
      connected: true,
      owner: false,
      joinedAtTick: this.#world.tick,
      leftAtTick: null,
    };
    return membership;
  }

  #reconcileOwner(): void {
    const activeMemberships = Array.from(this.#membershipsById.values())
      .filter((membership) => membership.connected)
      .sort((left, right) => left.joinOrdinal - right.joinOrdinal);
    if (activeMemberships.length === 0) {
      this.#world.ownerPlayerId = null;
      return;
    }
    const owner = activeMemberships[0];
    owner.owner = true;
    for (const membership of activeMemberships.slice(1)) {
      membership.owner = false;
    }
    this.#world.ownerPlayerId = owner.playerId;
  }

  #activeMembershipCount(): number {
    return Array.from(this.#membershipsById.values()).filter((membership) => membership.connected).length;
  }

  #projectedMembershipCount(): number {
    const pendingLeaveSessions = new Set(this.#ingressQueue.filter((ingress) => ingress.kind === "leave").map((ingress) => ingress.sessionId));
    const connectedCount = Array.from(this.#membershipsById.values()).filter((membership) => membership.connected && !pendingLeaveSessions.has(membership.sessionId)).length;
    const pendingJoinCount = this.#ingressQueue.filter((ingress) => ingress.kind === "join").length;
    return connectedCount + pendingJoinCount;
  }

  #hasPendingLeave(sessionId: string): boolean {
    return this.#ingressQueue.some((ingress) => ingress.kind === "leave" && ingress.sessionId === sessionId);
  }

  #pruneExpiredTombstones(): void {
    for (const [sessionId, membership] of Array.from(this.#tombstonesBySession.entries())) {
      if (!this.#tombstoneExpired(membership)) {
        continue;
      }
      this.#tombstonesBySession.delete(sessionId);
      this.#membershipsById.delete(membership.membershipId);
    }
  }

  #tombstoneExpired(membership: MembershipRecord): boolean {
    if (membership.leftAtTick === null) {
      return false;
    }
    return this.#world.tick - membership.leftAtTick > this.#tombstoneLifetimeTicks;
  }

  #applyAuthoritativeTick(): void {
    if (this.#schedulerSuspended || this.#world.paused) {
      return;
    }
    advanceWorldTick(this.#world);
  }

  private publishMembership(): void {
    this.publishSnapshot("membership");
  }

  private publishSnapshot(reason: RoomPublication["reason"]): void {
    const snapshot = createWorldSnapshot(this.#world);
    const publication: RoomPublication = {
      roomId: this.#roomId,
      tick: this.#world.tick,
      worldRevision: this.#world.worldRevision,
      checksum: computeWorldChecksum(this.#world),
      memberships: this.memberships.map((membership) => ({
        membershipId: membership.membershipId,
        playerId: membership.playerId,
        sessionId: membership.sessionId,
        connectionId: membership.connectionId,
        generation: membership.generation,
        joinOrdinal: membership.joinOrdinal,
        receiveOrdinal: membership.receiveOrdinal,
        connected: membership.connected,
        owner: membership.owner,
      })),
      reason,
      snapshot,
    };
    this.#lastPublication = publication;
    this.#publisher.publish(publication);
  }

  private async publishClosing(reason: RoomLifecycleReason): Promise<void> {
    const snapshot = createWorldSnapshot(this.#world);
    const publication: RoomPublication = {
      roomId: this.#roomId,
      tick: this.#world.tick,
      worldRevision: this.#world.worldRevision,
      checksum: computeWorldChecksum(this.#world),
      memberships: this.memberships.map((membership) => ({
        membershipId: membership.membershipId,
        playerId: membership.playerId,
        sessionId: membership.sessionId,
        connectionId: membership.connectionId,
        generation: membership.generation,
        joinOrdinal: membership.joinOrdinal,
        receiveOrdinal: membership.receiveOrdinal,
        connected: membership.connected,
        owner: membership.owner,
      })),
      reason: "closing",
      snapshot,
    };
    this.#lastPublication = publication;
    this.#publisher.publish(publication);
    await Promise.resolve(this.#hooks?.onClosed?.(this.#roomId, reason));
  }

  #membershipSummary(membership: MembershipRecord): RoomMemberState {
    return {
      membershipId: membership.membershipId,
      playerId: membership.playerId,
      sessionId: membership.sessionId,
      connectionId: membership.connectionId,
      generation: membership.generation,
      joinOrdinal: membership.joinOrdinal,
      receiveOrdinal: membership.receiveOrdinal,
      connected: membership.connected,
      owner: membership.owner,
    };
  }

  #membershipSummaryForIngress(ingress: RoomIngress): RoomMemberState {
    const joinOrdinal = ingress.joinOrdinal ?? this.#nextJoinOrdinal;
    return {
      membershipId: ingress.membershipId,
      playerId: ingress.playerId ?? createPlayerId(`player_${joinOrdinal}`),
      sessionId: ingress.sessionId,
      connectionId: ingress.connectionId,
      generation: ingress.generation,
      joinOrdinal,
      receiveOrdinal: ingress.receiveOrdinal,
      connected: false,
      owner: false,
    };
  }

  private resolveClose(): void {
    if (this.#resolveClosePromise) {
      this.#resolveClosePromise();
      this.#resolveClosePromise = null;
    }
  }
}

export function createRoomIdValue(index: number): RoomId {
  return createDefaultRoomId(index) as RoomId;
}
