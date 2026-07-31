import type { CommandEnvelope, GameplayCommand, WorldSnapshot, CommandResultCode } from "@particle-sim/shared";
import type { PlayerId, RoomId } from "@particle-sim/shared";

export type RoomLifecycleReason = "server_shutdown" | "idle_cleanup" | "manual_close";

export type RoomPolicyCode =
  | "malformed_message"
  | "rate_limited"
  | "player_backlog"
  | "room_backlog"
  | "stale_session"
  | "room_closed"
  | "room_closing"
  | "leave_pending"
  | "left_room"
  | "not_joined"
  | "stale_membership"
  | "invalid_actor_sequence"
  | "invalid_issued_tick"
  | "future_sequence"
  | "shutdown";

export interface MembershipSummary {
  readonly membershipId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly joinOrdinal: number;
  readonly receiveOrdinal: number;
  readonly connected: boolean;
  readonly owner: boolean;
}

export interface RoomPublication {
  readonly roomId: RoomId;
  readonly tick: number;
  readonly worldRevision: number;
  readonly checksum: string;
  readonly memberships: MembershipSummary[];
  readonly reason: "tick" | "membership" | "closing";
  readonly snapshot?: WorldSnapshot;
}

export interface RoomPublisher {
  publish(publication: RoomPublication): void;
}

export interface RoomTransportHooks {
  onJoined?(roomId: RoomId, membership: MembershipSummary): void | Promise<void>;
  onLeft?(roomId: RoomId, membership: MembershipSummary): void | Promise<void>;
  onClosed?(roomId: RoomId, reason: RoomLifecycleReason): void | Promise<void>;
  onCommandAck?(roomId: RoomId, membership: MembershipSummary, ack: RoomCommandAck): void | Promise<void>;
  onError?(roomId: RoomId, error: unknown): void | Promise<void>;
}

export interface RoomIngress {
  readonly kind: "join" | "leave" | "command";
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly receiveOrdinal: number;
  readonly generation: number;
  readonly joinOrdinal?: number;
  readonly playerId?: PlayerId;
  readonly command?: CommandEnvelope;
}

export interface JoinRequest {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly generation?: number;
}

export interface LeaveRequest {
  readonly membershipId?: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly generation?: number;
}

export interface CommandRequest {
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly connectionOrdinal: number;
  readonly generation?: number;
  readonly actorSequence?: number;
  readonly issuedTick?: number;
  readonly command: GameplayCommand;
}

export interface RoomCommandAckBase {
  readonly kind: "policy_rejection" | "gameplay_result";
  readonly membershipId: string;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly playerId: PlayerId;
  readonly receiveOrdinal: number;
  readonly actorSequence: number | null;
  readonly issuedTick: number | null;
  readonly accepted: boolean;
  readonly policyCode: RoomPolicyCode | "gameplay_accepted" | "gameplay_rejected";
  readonly gameplayCode: CommandResultCode | null;
  readonly processedTick: number;
  readonly authorityOrder: number | null;
  readonly beforeWorldRevision: number;
  readonly afterWorldRevision: number;
  readonly beforeInventoryRevision: number;
  readonly afterInventoryRevision: number;
  readonly beforeTargetRevision: number;
  readonly afterTargetRevision: number;
  readonly acceptedEffect: string | null;
  readonly commandId: string | null;
}

export interface RoomCommandPolicyAck extends RoomCommandAckBase {
  readonly kind: "policy_rejection";
  readonly policyCode: RoomPolicyCode;
  readonly gameplayCode: null;
  readonly accepted: false;
}

export interface RoomCommandGameplayAck extends RoomCommandAckBase {
  readonly kind: "gameplay_result";
  readonly policyCode: "gameplay_accepted" | "gameplay_rejected";
  readonly gameplayCode: CommandResultCode;
}

export type RoomCommandAck = RoomCommandPolicyAck | RoomCommandGameplayAck;

export interface RoomCommandAdmissionResult {
  readonly accepted: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly ack?: RoomCommandAck;
}

export interface RoomCommandBatchAdmissionResult {
  readonly accepted: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly results: RoomCommandAdmissionResult[];
}

export interface RoomMemberState {
  readonly membershipId: string;
  readonly playerId: PlayerId;
  readonly sessionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly joinOrdinal: number;
  readonly receiveOrdinal: number;
  readonly connected: boolean;
  readonly owner: boolean;
}
