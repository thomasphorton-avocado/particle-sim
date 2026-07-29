import type { CommandResultCode, GameplayCommand, GameplayCommandType } from "../commands.js";
import type { PlayerId, RoomId } from "../ids.js";
import type { WorldDelta, WorldSnapshot } from "../replication.js";
import { PROTOCOL_VERSION } from "./limits.js";

export type ProtocolJoinRejectCode = "room_not_found" | "room_full" | "already_joined" | "unauthorized" | "protocol_error";
export type ProtocolRoomClosureCode = "room_closed" | "room_replaced" | "server_shutdown" | "protocol_error";
export type ProtocolResyncReason = "stale" | "out_of_date" | "delta_gap" | "protocol_error";
export type ProtocolErrorCode =
  | "unsupported_protocol_version"
  | "unsupported_message_kind"
  | "unsupported_schema_version"
  | "invalid_json"
  | "invalid_utf8"
  | "frame_too_large"
  | "malformed_message"
  | "unknown_field"
  | "invalid_id"
  | "invalid_integer"
  | "invalid_revision"
  | "invalid_dimensions"
  | "batch_too_large"
  | "cell_too_large"
  | "entity_too_large"
  | "decoder_work_limit_exceeded";

export interface ProtocolVersionedMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
}

export interface ProtocolHelloMessage extends ProtocolVersionedMessage {
  kind: "hello";
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
  clientId?: string;
  clientName?: string;
}

export interface ProtocolJoinMessage extends ProtocolVersionedMessage {
  kind: "join";
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
  roomId: RoomId;
  playerId?: PlayerId;
}

export interface ProtocolJoinAcceptedMessage extends ProtocolVersionedMessage {
  kind: "join_accepted";
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
  streamSequence: number;
  roomId: RoomId;
  playerId: PlayerId;
}

export interface ProtocolJoinRejectedMessage extends ProtocolVersionedMessage {
  kind: "join_rejected";
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
  streamSequence: number;
  roomId: RoomId;
  code: ProtocolJoinRejectCode;
  message?: string;
}

export interface ProtocolClientCommand {
  clientSequence: number;
  issuedTick: number;
  command: GameplayCommand;
}

export interface ProtocolCommandBatchMessage {
  kind: "command_batch";
  streamSequence: number;
  commands: ProtocolClientCommand[];
}

export interface ProtocolCommandAcknowledgement {
  clientSequence: number;
  issuedTick: number;
  accepted: boolean;
  code: CommandResultCode;
  authorityOrder: number | null;
  processedTick: number;
  beforeWorldRevision: number;
  afterWorldRevision: number;
  beforeInventoryRevision: number;
  afterInventoryRevision: number;
  beforeTargetRevision: number;
  afterTargetRevision: number;
  acceptedEffect: string | null;
}

export interface ProtocolCommandAcknowledgementMessage {
  kind: "command_acknowledgement";
  streamSequence: number;
  acknowledgements: ProtocolCommandAcknowledgement[];
}

export interface ProtocolSnapshotMessage extends ProtocolVersionedMessage {
  kind: "snapshot";
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
  streamSequence: number;
  snapshot: WorldSnapshot;
}

export interface ProtocolDeltaMessage extends ProtocolVersionedMessage {
  kind: "delta";
  worldSnapshotSchemaVersion: number;
  worldStateSchemaVersion: number;
  streamSequence: number;
  delta: WorldDelta;
}

export interface ProtocolResyncRequestMessage {
  kind: "resync_request";
  streamSequence: number;
  reason?: ProtocolResyncReason;
  lastKnownStreamSequence?: number;
  lastKnownWorldRevision?: number;
}

export interface ProtocolResyncRequiredMessage {
  kind: "resync_required";
  streamSequence: number;
  reason: ProtocolResyncReason;
  lastKnownStreamSequence?: number;
  lastKnownWorldRevision?: number;
}

export interface ProtocolErrorMessage {
  kind: "protocol_error";
  streamSequence: number;
  code: ProtocolErrorCode;
  message?: string;
}

export interface ProtocolPingMessage {
  kind: "ping";
  streamSequence: number;
  nonce?: string;
}

export interface ProtocolPongMessage {
  kind: "pong";
  streamSequence: number;
  nonce?: string;
}

export interface ProtocolRoomClosureMessage {
  kind: "room_closed";
  streamSequence: number;
  code: ProtocolRoomClosureCode;
  reason?: string;
}

export type ProtocolClientMessage =
  | ProtocolHelloMessage
  | ProtocolJoinMessage
  | ProtocolCommandBatchMessage
  | ProtocolResyncRequestMessage
  | ProtocolPingMessage;

export type ProtocolServerMessage =
  | ProtocolJoinAcceptedMessage
  | ProtocolJoinRejectedMessage
  | ProtocolCommandAcknowledgementMessage
  | ProtocolSnapshotMessage
  | ProtocolDeltaMessage
  | ProtocolResyncRequiredMessage
  | ProtocolErrorMessage
  | ProtocolPongMessage
  | ProtocolRoomClosureMessage;

export type ProtocolMessage = ProtocolClientMessage | ProtocolServerMessage;
export type ProtocolMessageKind = ProtocolMessage["kind"];
export type ProtocolCommandKind = GameplayCommand["type"];
export type ProtocolMessageType = GameplayCommandType;
