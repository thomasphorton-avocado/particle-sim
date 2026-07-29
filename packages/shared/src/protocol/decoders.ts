import { parseGameplayCommand } from "../commands.js";
import { parsePlayerId, parseRoomId } from "../ids.js";
import { decodeWorldDelta, decodeWorldSnapshot, WORLD_SNAPSHOT_SCHEMA_VERSION } from "../replication.js";
import { WORLD_STATE_SCHEMA_VERSION } from "../serialization.js";
import { MAX_BATCH_COMMANDS, MAX_CELL_DELTAS, MAX_DECODER_WORK, MAX_ENTITY_DELTAS, MAX_ID_LENGTH, MAX_INTEGER, MAX_METADATA_ENTRIES, MAX_NESTED_COLLECTION_ITEMS, MAX_OBJECT_FIELDS, MAX_STRING_LENGTH, MIN_INTEGER, PROTOCOL_VERSION } from "./limits.js";
import { ProtocolCodecError, decodeProtocolMessageFrame as decodeProtocolJsonFrame, encodeProtocolMessage as encodeProtocolJsonMessage } from "./json.js";
import type {
  ProtocolClientCommand,
  ProtocolCommandAcknowledgement,
  ProtocolCommandAcknowledgementMessage,
  ProtocolCommandBatchMessage,
  ProtocolDeltaMessage,
  ProtocolErrorCode,
  ProtocolErrorMessage,
  ProtocolHelloMessage,
  ProtocolJoinAcceptedMessage,
  ProtocolJoinMessage,
  ProtocolJoinRejectedMessage,
  ProtocolMessage,
  ProtocolPingMessage,
  ProtocolPongMessage,
  ProtocolResyncReason,
  ProtocolResyncRequiredMessage,
  ProtocolResyncRequestMessage,
  ProtocolRoomClosureCode,
  ProtocolRoomClosureMessage,
  ProtocolSnapshotMessage,
  ProtocolJoinRejectCode,
  ProtocolVersionedMessage,
} from "./types.js";

interface DecoderWork {
  used: number;
}

function consumeWork(work: DecoderWork, amount = 1): void {
  work.used += amount;
  if (work.used > MAX_DECODER_WORK) {
    throw new ProtocolCodecError("decoder_work_limit_exceeded", `Decoder work limit exceeded (${MAX_DECODER_WORK})`);
  }
}

function assertPlainObject(value: unknown, label: string, work: DecoderWork): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an object`);
  }
  consumeWork(work, 1 + Object.keys(value).length);
  return value as Record<string, unknown>;
}

function assertAllowedFields(value: Record<string, unknown>, label: string, allowedFields: ReadonlySet<string>, work: DecoderWork): void {
  consumeWork(work, 1);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new ProtocolCodecError("unknown_field", `${label} contains an unknown field (${key})`);
    }
  }
}

function assertRequiredField(value: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new ProtocolCodecError("malformed_message", `${label} is required`);
  }
  return value[key];
}

function assertString(value: unknown, label: string, work: DecoderWork, allowEmpty = true): string {
  if (typeof value !== "string") {
    throw new ProtocolCodecError("malformed_message", `${label} must be a string`);
  }
  consumeWork(work, 1);
  if (!allowEmpty && value.length === 0) {
    throw new ProtocolCodecError("malformed_message", `${label} must not be empty`);
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new ProtocolCodecError("malformed_message", `${label} exceeds the ${MAX_STRING_LENGTH} character limit`);
  }
  return value;
}

function assertInteger(value: unknown, label: string, work: DecoderWork, min = MIN_INTEGER, max = MAX_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ProtocolCodecError("invalid_integer", `${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ProtocolCodecError("invalid_integer", `${label} is outside the supported range`);
  }
  consumeWork(work, 1);
  return value;
}

function assertNonNegativeInteger(value: unknown, label: string, work: DecoderWork): number {
  return assertInteger(value, label, work, MIN_INTEGER, MAX_INTEGER);
}

function assertLiteralString<T extends string>(value: unknown, label: string, work: DecoderWork, allowedValues: ReadonlySet<T>): T {
  const text = assertString(value, label, work, false);
  if (!allowedValues.has(text as T)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be one of ${Array.from(allowedValues).join(", ")}`);
  }
  return text as T;
}

function assertProtocolVersion(value: unknown, work: DecoderWork): number {
  const protocolVersion = assertNonNegativeInteger(value, "protocolVersion", work);
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolCodecError("unsupported_protocol_version", `Unsupported protocol version ${protocolVersion}`);
  }
  return protocolVersion;
}

function assertSchemaVersion(value: unknown, label: string, work: DecoderWork, expected: number): number {
  const schemaVersion = assertNonNegativeInteger(value, label, work);
  if (schemaVersion !== expected) {
    throw new ProtocolCodecError("unsupported_schema_version", `${label} ${schemaVersion} is unsupported`);
  }
  return schemaVersion;
}

function assertRoomId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parseRoomId> {
  const roomIdText = assertString(value, label, work, false);
  if (roomIdText.length > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parseRoomId(roomIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid room id`);
  }
}

function assertPlayerId(value: unknown, label: string, work: DecoderWork): ReturnType<typeof parsePlayerId> {
  const playerIdText = assertString(value, label, work, false);
  if (playerIdText.length > MAX_ID_LENGTH) {
    throw new ProtocolCodecError("invalid_id", `${label} exceeds the ${MAX_ID_LENGTH} byte limit`);
  }
  try {
    return parsePlayerId(playerIdText);
  } catch {
    throw new ProtocolCodecError("invalid_id", `${label} must be a valid player id`);
  }
}

function assertOptionalString(value: unknown, label: string, work: DecoderWork, allowEmpty = true): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertString(value, label, work, allowEmpty);
}

function assertOptionalInteger(value: unknown, label: string, work: DecoderWork): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertNonNegativeInteger(value, label, work);
}

function assertVersionedMessageFields(value: Record<string, unknown>, work: DecoderWork): ProtocolVersionedMessage {
  const protocolVersion = assertProtocolVersion(value["protocolVersion"], work);
  const worldSnapshotSchemaVersion = assertSchemaVersion(value["worldSnapshotSchemaVersion"], "worldSnapshotSchemaVersion", work, WORLD_SNAPSHOT_SCHEMA_VERSION);
  const worldStateSchemaVersion = assertSchemaVersion(value["worldStateSchemaVersion"], "worldStateSchemaVersion", work, WORLD_STATE_SCHEMA_VERSION);
  return { protocolVersion, worldSnapshotSchemaVersion, worldStateSchemaVersion } as ProtocolVersionedMessage;
}

function wrapReplicaValidation<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProtocolCodecError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    if (lowered.includes("unsupported") && (lowered.includes("schema") || lowered.includes("version"))) {
      throw new ProtocolCodecError("unsupported_schema_version", `${label}: ${message}`);
    }
    if (lowered.includes("revision")) {
      throw new ProtocolCodecError("invalid_revision", `${label}: ${message}`);
    }
    if (lowered.includes("dimension") || lowered.includes("griddimensions")) {
      throw new ProtocolCodecError("invalid_dimensions", `${label}: ${message}`);
    }
    throw new ProtocolCodecError("malformed_message", `${label}: ${message}`);
  }
}

function assertReplicaRecord(value: unknown, label: string, work: DecoderWork): Record<string, unknown> {
  const object = assertPlainObject(value, label, work);
  if (Object.keys(object).length > MAX_OBJECT_FIELDS) {
    throw new ProtocolCodecError("malformed_message", `${label} exceeds the ${MAX_OBJECT_FIELDS} field limit`);
  }
  return object;
}

function assertReplicaObject(value: unknown, label: string, allowedFields: ReadonlySet<string>, work: DecoderWork): Record<string, unknown> {
  const object = assertReplicaRecord(value, label, work);
  assertAllowedFields(object, label, allowedFields, work);
  return object;
}

function assertArray(value: unknown, label: string, work: DecoderWork, maxLength = MAX_BATCH_COMMANDS, errorCode: ProtocolErrorCode = "malformed_message"): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an array`);
  }
  if (value.length > maxLength) {
    throw new ProtocolCodecError(errorCode, `${label} exceeds the ${maxLength} entry limit`);
  }
  consumeWork(work, 1 + value.length);
  return value;
}

function assertReplicaArray(value: unknown, label: string, work: DecoderWork, maxLength = MAX_NESTED_COLLECTION_ITEMS, errorCode: ProtocolErrorCode = "malformed_message"): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolCodecError("malformed_message", `${label} must be an array`);
  }
  if (value.length > maxLength) {
    throw new ProtocolCodecError(errorCode, `${label} exceeds the ${maxLength} entry limit`);
  }
  consumeWork(work, 1 + value.length);
  return value;
}

function assertReplicaMap(value: unknown, label: string, work: DecoderWork, maxEntries = MAX_NESTED_COLLECTION_ITEMS, errorCode: ProtocolErrorCode = "malformed_message"): Record<string, unknown> {
  const object = assertReplicaRecord(value, label, work);
  if (Object.keys(object).length > maxEntries) {
    throw new ProtocolCodecError(errorCode, `${label} exceeds the ${maxEntries} entry limit`);
  }
  consumeWork(work, 1 + Object.keys(object).length);
  return object;
}

function assertReplicaValue(value: unknown, label: string, work: DecoderWork): void {
  if (value === null || value === undefined) {
    consumeWork(work, 1);
    return;
  }
  if (typeof value === "string") {
    assertString(value, label, work, true);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    consumeWork(work, 1);
    return;
  }
  if (Array.isArray(value)) {
    const arrayValue = assertReplicaArray(value, label, work);
    for (let index = 0; index < arrayValue.length; index += 1) {
      assertReplicaValue(arrayValue[index], `${label}[${index}]`, work);
    }
    return;
  }
  if (typeof value === "object") {
    const objectValue = assertReplicaRecord(value, label, work);
    for (const [key, entry] of Object.entries(objectValue)) {
      assertReplicaValue(entry, `${label}.${key}`, work);
    }
    return;
  }
  throw new ProtocolCodecError("malformed_message", `${label} has an unsupported value`);
}

function assertSnapshotShape(value: unknown, work: DecoderWork): void {
  const snapshot = assertReplicaObject(value, "snapshot", new Set(["version", "worldRevision", "checksum", "worldState"]), work);
  assertNonNegativeInteger(snapshot["version"], "snapshot.version", work);
  assertNonNegativeInteger(snapshot["worldRevision"], "snapshot.worldRevision", work);
  assertString(snapshot["checksum"], "snapshot.checksum", work, false);
  assertWorldStateShape(snapshot["worldState"], work);
}

function assertWorldStateShape(value: unknown, work: DecoderWork): void {
  const worldState = assertReplicaObject(value, "world state", new Set([
    "schemaVersion",
    "roomId",
    "grid",
    "random",
    "players",
    "fallingObjects",
    "paused",
    "tick",
    "time",
    "weather",
    "nextPlayerOrdinal",
    "nextObjectOrdinal",
    "ownerPlayerId",
    "worldRevision",
    "nextAuthorityOrder",
    "commandLedger",
  ]), work);
  assertNonNegativeInteger(worldState["schemaVersion"], "worldState.schemaVersion", work);
  assertString(worldState["roomId"], "worldState.roomId", work, false);
  assertGridShape(worldState["grid"], work);
  assertRandomShape(worldState["random"], work);
  assertPlayerMapShape(worldState["players"], work);
  assertFallingObjectMapShape(worldState["fallingObjects"], work);
  assertReplicaValue(worldState["paused"], "worldState.paused", work);
  assertNonNegativeInteger(worldState["tick"], "worldState.tick", work);
  assertTimeShape(worldState["time"], work);
  assertWeatherShape(worldState["weather"], work);
  assertNonNegativeInteger(worldState["nextPlayerOrdinal"], "worldState.nextPlayerOrdinal", work);
  assertNonNegativeInteger(worldState["nextObjectOrdinal"], "worldState.nextObjectOrdinal", work);
  assertReplicaValue(worldState["ownerPlayerId"], "worldState.ownerPlayerId", work);
  assertNonNegativeInteger(worldState["worldRevision"], "worldState.worldRevision", work);
  assertNonNegativeInteger(worldState["nextAuthorityOrder"], "worldState.nextAuthorityOrder", work);
  assertCommandLedgerShape(worldState["commandLedger"], work);
}

function assertGridShape(value: unknown, work: DecoderWork): void {
  const grid = assertReplicaObject(value, "grid", new Set(["width", "height", "ids", "shade", "auxiliary", "objectMembership", "cellRevisions"]), work);
  const width = assertNonNegativeInteger(grid["width"], "grid.width", work);
  const height = assertNonNegativeInteger(grid["height"], "grid.height", work);
  const totalCells = width * height;
  if (totalCells > MAX_NESTED_COLLECTION_ITEMS) {
    throw new ProtocolCodecError("malformed_message", "grid dimensions exceed the nested collection limit");
  }
  assertReplicaArray(grid["ids"], "grid.ids", work, totalCells);
  assertReplicaArray(grid["shade"], "grid.shade", work, totalCells);
  assertReplicaArray(grid["auxiliary"], "grid.auxiliary", work, totalCells);
  assertReplicaArray(grid["cellRevisions"], "grid.cellRevisions", work, totalCells);
  const objectMembership = assertReplicaArray(grid["objectMembership"], "grid.objectMembership", work);
  for (let index = 0; index < objectMembership.length; index += 1) {
    const entry = assertReplicaObject(objectMembership[index], `grid.objectMembership[${index}]`, new Set(["x", "y", "objectId"]), work);
    assertNonNegativeInteger(entry["x"], `grid.objectMembership[${index}].x`, work);
    assertNonNegativeInteger(entry["y"], `grid.objectMembership[${index}].y`, work);
    assertString(entry["objectId"], `grid.objectMembership[${index}].objectId`, work, false);
  }
}

function assertRandomShape(value: unknown, work: DecoderWork): void {
  const random = assertReplicaObject(value, "random", new Set(["algorithm", "seed", "state"]), work);
  assertString(random["algorithm"], "random.algorithm", work, false);
  assertNonNegativeInteger(random["seed"], "random.seed", work);
  assertNonNegativeInteger(random["state"], "random.state", work);
}

function assertPlayerMapShape(value: unknown, work: DecoderWork): void {
  const players = assertReplicaMap(value, "players", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [playerId, playerState] of Object.entries(players)) {
    assertPlayerStateShape(playerState, `players.${playerId}`, work);
  }
}

function assertPlayerStateShape(value: unknown, label: string, work: DecoderWork): void {
  const player = assertReplicaObject(value, label, new Set([
    "id",
    "x",
    "y",
    "vx",
    "vy",
    "width",
    "height",
    "grounded",
    "facing",
    "airTicks",
    "previousJumpHeld",
    "swingElapsedTicks",
    "faucetCooldownUntilTick",
    "crouching",
    "lookingUp",
    "swimming",
    "input",
    "inventory",
    "hotbar",
    "activeHotbarSlot",
    "inventoryRevision",
    "pendingRefunds",
  ]), work);
  assertString(player["id"], `${label}.id`, work, false);
  assertReplicaValue(player["x"], `${label}.x`, work);
  assertReplicaValue(player["y"], `${label}.y`, work);
  assertReplicaValue(player["vx"], `${label}.vx`, work);
  assertReplicaValue(player["vy"], `${label}.vy`, work);
  assertReplicaValue(player["width"], `${label}.width`, work);
  assertReplicaValue(player["height"], `${label}.height`, work);
  assertReplicaValue(player["grounded"], `${label}.grounded`, work);
  assertReplicaValue(player["facing"], `${label}.facing`, work);
  assertReplicaValue(player["airTicks"], `${label}.airTicks`, work);
  assertReplicaValue(player["previousJumpHeld"], `${label}.previousJumpHeld`, work);
  assertReplicaValue(player["swingElapsedTicks"], `${label}.swingElapsedTicks`, work);
  assertReplicaValue(player["faucetCooldownUntilTick"], `${label}.faucetCooldownUntilTick`, work);
  assertReplicaValue(player["crouching"], `${label}.crouching`, work);
  assertReplicaValue(player["lookingUp"], `${label}.lookingUp`, work);
  assertReplicaValue(player["swimming"], `${label}.swimming`, work);
  assertInputShape(player["input"], `${label}.input`, work);
  assertInventoryShape(player["inventory"], `${label}.inventory`, work);
  assertHotbarShape(player["hotbar"], `${label}.hotbar`, work);
  assertNonNegativeInteger(player["activeHotbarSlot"], `${label}.activeHotbarSlot`, work);
  assertNonNegativeInteger(player["inventoryRevision"], `${label}.inventoryRevision`, work);
  assertPendingRefundsShape(player["pendingRefunds"], `${label}.pendingRefunds`, work);
}

function assertInputShape(value: unknown, label: string, work: DecoderWork): void {
  const input = assertReplicaObject(value, label, new Set(["left", "right", "jumpHeld", "crouchHeld", "lookUpHeld", "mineHeld"]), work);
  assertReplicaValue(input["left"], `${label}.left`, work);
  assertReplicaValue(input["right"], `${label}.right`, work);
  assertReplicaValue(input["jumpHeld"], `${label}.jumpHeld`, work);
  assertReplicaValue(input["crouchHeld"], `${label}.crouchHeld`, work);
  assertReplicaValue(input["lookUpHeld"], `${label}.lookUpHeld`, work);
  assertReplicaValue(input["mineHeld"], `${label}.mineHeld`, work);
}

function assertInventoryShape(value: unknown, label: string, work: DecoderWork): void {
  const inventory = assertReplicaMap(value, label, work, MAX_NESTED_COLLECTION_ITEMS);
  for (const [key, entry] of Object.entries(inventory)) {
    assertNonNegativeInteger(entry, `${label}.${key}`, work);
  }
}

function assertHotbarShape(value: unknown, label: string, work: DecoderWork): void {
  const hotbar = assertReplicaArray(value, label, work, 10);
  if (hotbar.length !== 10) {
    throw new ProtocolCodecError("malformed_message", `${label} must have exactly 10 entries`);
  }
  for (let index = 0; index < hotbar.length; index += 1) {
    const entry = hotbar[index];
    if (entry === null) {
      continue;
    }
    const item = assertReplicaObject(entry, `${label}[${index}]`, new Set(["kind", "materialId", "count"]), work);
    assertString(item["kind"], `${label}[${index}].kind`, work, false);
    if (item["kind"] === "material") {
      assertNonNegativeInteger(item["materialId"], `${label}[${index}].materialId`, work);
      assertNonNegativeInteger(item["count"], `${label}[${index}].count`, work);
    }
  }
}

function assertPendingRefundsShape(value: unknown, label: string, work: DecoderWork): void {
  const refunds = assertReplicaMap(value, label, work, MAX_NESTED_COLLECTION_ITEMS);
  for (const [key, entry] of Object.entries(refunds)) {
    assertNonNegativeInteger(entry, `${label}.${key}`, work);
  }
}

function assertFallingObjectMapShape(value: unknown, work: DecoderWork): void {
  const fallingObjects = assertReplicaMap(value, "fallingObjects", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [objectId, state] of Object.entries(fallingObjects)) {
    assertFallingObjectShape(state, `fallingObjects.${objectId}`, work);
  }
}

function assertFallingObjectShape(value: unknown, label: string, work: DecoderWork): void {
  const fallingObject = assertReplicaObject(value, label, new Set(["id", "materialId", "x", "y", "restY", "vy", "offsets", "provenance"]), work);
  assertString(fallingObject["id"], `${label}.id`, work, false);
  assertNonNegativeInteger(fallingObject["materialId"], `${label}.materialId`, work);
  assertReplicaValue(fallingObject["x"], `${label}.x`, work);
  assertReplicaValue(fallingObject["y"], `${label}.y`, work);
  assertReplicaValue(fallingObject["restY"], `${label}.restY`, work);
  assertReplicaValue(fallingObject["vy"], `${label}.vy`, work);
  const offsets = assertReplicaArray(fallingObject["offsets"], `${label}.offsets`, work, MAX_NESTED_COLLECTION_ITEMS);
  for (let index = 0; index < offsets.length; index += 1) {
    const entry = assertReplicaArray(offsets[index], `${label}.offsets[${index}]`, work, 2);
    if (entry.length !== 2) {
      throw new ProtocolCodecError("malformed_message", `${label}.offsets[${index}] must contain exactly 2 numbers`);
    }
    assertReplicaValue(entry[0], `${label}.offsets[${index}][0]`, work);
    assertReplicaValue(entry[1], `${label}.offsets[${index}][1]`, work);
  }
  assertFallingProvenanceShape(fallingObject["provenance"], `${label}.provenance`, work);
}

function assertFallingProvenanceShape(value: unknown, label: string, work: DecoderWork): void {
  const provenance = assertReplicaObject(value, label, new Set(["kind"]), work);
  const kind = assertString(provenance["kind"], `${label}.kind`, work, false);
  if (kind === "legacy") {
    return;
  }
  if (kind === "placement") {
    const placement = assertReplicaObject(value, label, new Set(["kind", "actorId", "commandId", "sourceSlot", "materialId", "amount"]), work);
    assertString(placement["actorId"], `${label}.actorId`, work, false);
    assertString(placement["commandId"], `${label}.commandId`, work, false);
    assertNonNegativeInteger(placement["sourceSlot"], `${label}.sourceSlot`, work);
    assertNonNegativeInteger(placement["materialId"], `${label}.materialId`, work);
    assertNonNegativeInteger(placement["amount"], `${label}.amount`, work);
    return;
  }
  throw new ProtocolCodecError("malformed_message", `${label}.kind must be 'legacy' or 'placement'`);
}

function assertTimeShape(value: unknown, work: DecoderWork): void {
  const time = assertReplicaObject(value, "time", new Set(["dayNightTick"]), work);
  assertReplicaValue(time["dayNightTick"], "time.dayNightTick", work);
}

function assertWeatherShape(value: unknown, work: DecoderWork): void {
  const weather = assertReplicaObject(value, "weather", new Set([
    "kind",
    "episodeElapsed",
    "episodeDuration",
    "wind",
    "visualTime",
    "rainAccumulator",
    "lightningFlash",
    "lightningCooldown",
    "boltX",
    "boltY",
    "boltSeed",
  ]), work);
  assertString(weather["kind"], "weather.kind", work, false);
  assertReplicaValue(weather["episodeElapsed"], "weather.episodeElapsed", work);
  assertReplicaValue(weather["episodeDuration"], "weather.episodeDuration", work);
  assertReplicaValue(weather["wind"], "weather.wind", work);
  assertReplicaValue(weather["visualTime"], "weather.visualTime", work);
  assertReplicaValue(weather["rainAccumulator"], "weather.rainAccumulator", work);
  assertReplicaValue(weather["lightningFlash"], "weather.lightningFlash", work);
  assertReplicaValue(weather["lightningCooldown"], "weather.lightningCooldown", work);
  assertReplicaValue(weather["boltX"], "weather.boltX", work);
  assertReplicaValue(weather["boltY"], "weather.boltY", work);
  assertReplicaValue(weather["boltSeed"], "weather.boltSeed", work);
}

function assertCommandLedgerShape(value: unknown, work: DecoderWork): void {
  const ledger = assertReplicaObject(value, "commandLedger", new Set(["actorHighWater", "recent"]), work);
  const actorHighWater = assertReplicaMap(ledger["actorHighWater"], "commandLedger.actorHighWater", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (const [key, entry] of Object.entries(actorHighWater)) {
    assertNonNegativeInteger(entry, `commandLedger.actorHighWater.${key}`, work);
  }
  const recent = assertReplicaArray(ledger["recent"], "commandLedger.recent", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < recent.length; index += 1) {
    assertCommandReceiptShape(recent[index], `commandLedger.recent[${index}]`, work);
  }
}

function assertCommandReceiptShape(value: unknown, label: string, work: DecoderWork): void {
  const receipt = assertReplicaObject(value, label, new Set([
    "commandId",
    "actorId",
    "actorSequence",
    "authorityOrder",
    "issuedTick",
    "processedTick",
    "commandType",
    "code",
    "accepted",
    "beforeWorldRevision",
    "afterWorldRevision",
    "beforeInventoryRevision",
    "afterInventoryRevision",
    "beforeTargetRevision",
    "afterTargetRevision",
    "acceptedEffect",
    "fingerprint",
  ]), work);
  assertString(receipt["commandId"], `${label}.commandId`, work, false);
  assertString(receipt["actorId"], `${label}.actorId`, work, false);
  assertNonNegativeInteger(receipt["actorSequence"], `${label}.actorSequence`, work);
  assertReplicaValue(receipt["authorityOrder"], `${label}.authorityOrder`, work);
  assertNonNegativeInteger(receipt["issuedTick"], `${label}.issuedTick`, work);
  assertNonNegativeInteger(receipt["processedTick"], `${label}.processedTick`, work);
  assertString(receipt["commandType"], `${label}.commandType`, work, false);
  assertString(receipt["code"], `${label}.code`, work, false);
  assertReplicaValue(receipt["accepted"], `${label}.accepted`, work);
  assertNonNegativeInteger(receipt["beforeWorldRevision"], `${label}.beforeWorldRevision`, work);
  assertNonNegativeInteger(receipt["afterWorldRevision"], `${label}.afterWorldRevision`, work);
  assertNonNegativeInteger(receipt["beforeInventoryRevision"], `${label}.beforeInventoryRevision`, work);
  assertNonNegativeInteger(receipt["afterInventoryRevision"], `${label}.afterInventoryRevision`, work);
  assertNonNegativeInteger(receipt["beforeTargetRevision"], `${label}.beforeTargetRevision`, work);
  assertNonNegativeInteger(receipt["afterTargetRevision"], `${label}.afterTargetRevision`, work);
  assertReplicaValue(receipt["acceptedEffect"], `${label}.acceptedEffect`, work);
  assertString(receipt["fingerprint"], `${label}.fingerprint`, work, false);
}

function assertDeltaShape(value: unknown, work: DecoderWork): void {
  const delta = assertReplicaObject(value, "delta", new Set(["version", "baseRevision", "targetRevision", "gridDimensions", "cells", "players", "fallingObjects", "metadata"]), work);
  assertNonNegativeInteger(delta["version"], "delta.version", work);
  const baseRevision = assertNonNegativeInteger(delta["baseRevision"], "delta.baseRevision", work);
  const targetRevision = assertNonNegativeInteger(delta["targetRevision"], "delta.targetRevision", work);
  if (baseRevision > targetRevision) {
    throw new ProtocolCodecError("invalid_revision", "delta.baseRevision cannot exceed delta.targetRevision");
  }
  const cells = assertReplicaArray(delta["cells"], "delta.cells", work, MAX_CELL_DELTAS, "cell_too_large");
  for (let index = 0; index < cells.length; index += 1) {
    assertDeltaCellShape(cells[index], `delta.cells[${index}]`, work);
  }
  const players = assertReplicaArray(delta["players"], "delta.players", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < players.length; index += 1) {
    assertDeltaEntityShape(players[index], `delta.players[${index}]`, "playerId", work);
  }
  const fallingObjects = assertReplicaArray(delta["fallingObjects"], "delta.fallingObjects", work, MAX_ENTITY_DELTAS, "entity_too_large");
  for (let index = 0; index < fallingObjects.length; index += 1) {
    assertDeltaEntityShape(fallingObjects[index], `delta.fallingObjects[${index}]`, "objectId", work);
  }
  const metadata = assertReplicaArray(delta["metadata"], "delta.metadata", work, MAX_METADATA_ENTRIES, "entity_too_large");
  for (let index = 0; index < metadata.length; index += 1) {
    assertDeltaMetadataShape(metadata[index], `delta.metadata[${index}]`, work);
  }
  assertGridDimensionsShape(delta["gridDimensions"], work);
}

function assertGridDimensionsShape(value: unknown, work: DecoderWork): void {
  const dimensions = assertReplicaObject(value, "gridDimensions", new Set(["width", "height"]), work);
  assertNonNegativeInteger(dimensions["width"], "gridDimensions.width", work);
  assertNonNegativeInteger(dimensions["height"], "gridDimensions.height", work);
}

function assertDeltaCellShape(value: unknown, label: string, work: DecoderWork): void {
  const cell = assertReplicaObject(value, label, new Set(["index", "materialId", "shade", "auxiliary", "objectId", "revision"]), work);
  assertNonNegativeInteger(cell["index"], `${label}.index`, work);
  assertNonNegativeInteger(cell["materialId"], `${label}.materialId`, work);
  assertReplicaValue(cell["shade"], `${label}.shade`, work);
  assertReplicaValue(cell["auxiliary"], `${label}.auxiliary`, work);
  assertReplicaValue(cell["objectId"], `${label}.objectId`, work);
  assertNonNegativeInteger(cell["revision"], `${label}.revision`, work);
}

function assertDeltaEntityShape(value: unknown, label: string, entityIdField: string, work: DecoderWork): void {
  const entity = assertReplicaObject(value, label, new Set([entityIdField, "state"]), work);
  assertString(entity[entityIdField], `${label}.${entityIdField}`, work, false);
  if (entity["state"] !== null) {
    assertPlayerStateShape(entity["state"], `${label}.state`, work);
  }
}

function assertDeltaMetadataShape(value: unknown, label: string, work: DecoderWork): void {
  const metadata = assertReplicaObject(value, label, new Set(["field", "value"]), work);
  assertLiteralString(metadata["field"], `${label}.field`, work, new Set([
    "roomId",
    "tick",
    "paused",
    "time",
    "weather",
    "random",
    "ownerPlayerId",
    "worldRevision",
    "nextAuthorityOrder",
    "nextPlayerOrdinal",
    "nextObjectOrdinal",
    "commandLedger",
  ]));
  assertReplicaValue(metadata["value"], `${label}.value`, work);
}

function assertCommandValueBounds(command: ProtocolClientCommand, work: DecoderWork): void {
  const { command: gameplayCommand } = command;
  switch (gameplayCommand.type) {
    case "set_input_state":
      return;
    case "mine_start":
    case "mine_stop":
      return;
    case "select_slot": {
      assertInteger(gameplayCommand.slot, "command.slot", work, 0, 9);
      assertNonNegativeInteger(gameplayCommand.expectedInventoryRevision, "command.expectedInventoryRevision", work);
      return;
    }
    case "place": {
      assertNonNegativeInteger(gameplayCommand.x, "command.x", work);
      assertNonNegativeInteger(gameplayCommand.y, "command.y", work);
      assertInteger(gameplayCommand.brushRadius, "command.brushRadius", work, 1, 16);
      assertNonNegativeInteger(gameplayCommand.expectedInventoryRevision, "command.expectedInventoryRevision", work);
      assertNonNegativeInteger(gameplayCommand.expectedAnchorRevision, "command.expectedAnchorRevision", work);
      return;
    }
    case "harvest": {
      assertNonNegativeInteger(gameplayCommand.x, "command.x", work);
      assertNonNegativeInteger(gameplayCommand.y, "command.y", work);
      assertNonNegativeInteger(gameplayCommand.expectedTargetRevision, "command.expectedTargetRevision", work);
      return;
    }
    case "cycle_faucet": {
      assertNonNegativeInteger(gameplayCommand.x, "command.x", work);
      assertNonNegativeInteger(gameplayCommand.y, "command.y", work);
      assertString(gameplayCommand.objectId, "command.objectId", work, false);
      if (gameplayCommand.objectId.length > MAX_ID_LENGTH) {
        throw new ProtocolCodecError("invalid_id", "command.objectId exceeds the maximum supported length");
      }
      assertNonNegativeInteger(gameplayCommand.expectedTargetRevision, "command.expectedTargetRevision", work);
      return;
    }
    case "pause_world":
    case "resume_world": {
      assertNonNegativeInteger(gameplayCommand.expectedWorldRevision, "command.expectedWorldRevision", work);
      return;
    }
    case "set_time_preset": {
      assertNonNegativeInteger(gameplayCommand.expectedWorldRevision, "command.expectedWorldRevision", work);
      return;
    }
    default: {
      throw new ProtocolCodecError("malformed_message", "command type is unsupported");
    }
  }
}

function assertCommand(value: unknown, work: DecoderWork): ProtocolClientCommand {
  const commandObject = assertPlainObject(value, "command", work);
  const allowedFields = new Set(["clientSequence", "issuedTick", "command"]);
  assertAllowedFields(commandObject, "command", allowedFields, work);
  const clientSequence = assertNonNegativeInteger(commandObject["clientSequence"], "clientSequence", work);
  const issuedTick = assertNonNegativeInteger(commandObject["issuedTick"], "issuedTick", work);
  const command = parseGameplayCommand(commandObject["command"]);
  if (command === null) {
    throw new ProtocolCodecError("malformed_message", "command must be a valid gameplay command");
  }
  const protocolCommand = { clientSequence, issuedTick, command };
  assertCommandValueBounds(protocolCommand, work);
  return protocolCommand;
}

function assertCommandBatch(value: Record<string, unknown>, work: DecoderWork): ProtocolCommandBatchMessage {
  const allowedFields = new Set(["kind", "streamSequence", "commands"]);
  assertAllowedFields(value, "command batch", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const commands = assertArray(value["commands"], "commands", work, MAX_BATCH_COMMANDS, "batch_too_large").map((entry) => assertCommand(entry, work));
  return { kind: "command_batch", streamSequence, commands };
}

function assertCommandAcknowledgement(value: unknown, work: DecoderWork): ProtocolCommandAcknowledgement {
  const ackObject = assertPlainObject(value, "command acknowledgement", work);
  const allowedFields = new Set(["clientSequence", "issuedTick", "accepted", "code", "authorityOrder", "processedTick", "beforeWorldRevision", "afterWorldRevision", "beforeInventoryRevision", "afterInventoryRevision", "beforeTargetRevision", "afterTargetRevision", "acceptedEffect"]);
  assertAllowedFields(ackObject, "command acknowledgement", allowedFields, work);
  const clientSequence = assertNonNegativeInteger(ackObject["clientSequence"], "clientSequence", work);
  const issuedTick = assertNonNegativeInteger(ackObject["issuedTick"], "issuedTick", work);
  const acceptedValue = assertRequiredField(ackObject, "accepted", "accepted");
  const accepted = typeof acceptedValue === "boolean" ? acceptedValue : (() => { throw new ProtocolCodecError("malformed_message", "accepted must be a boolean"); })();
  const code = assertLiteralString(assertRequiredField(ackObject, "code", "code"), "code", work, new Set<ProtocolCommandAcknowledgement["code"]>([
    "accepted",
    "unknown_actor",
    "paused",
    "not_owner",
    "already_state",
    "future_tick",
    "stale",
    "conflict",
    "slot",
    "tool",
    "revision",
    "inventory",
    "target",
    "bounds",
    "range",
    "collision",
    "footprint",
    "work_limit",
    "invalid_command",
  ]));
  const authorityOrderValue = assertRequiredField(ackObject, "authorityOrder", "authorityOrder");
  const authorityOrder = authorityOrderValue === null ? null : assertNonNegativeInteger(authorityOrderValue, "authorityOrder", work);
  const processedTick = assertNonNegativeInteger(assertRequiredField(ackObject, "processedTick", "processedTick"), "processedTick", work);
  const beforeWorldRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "beforeWorldRevision", "beforeWorldRevision"), "beforeWorldRevision", work);
  const afterWorldRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "afterWorldRevision", "afterWorldRevision"), "afterWorldRevision", work);
  const beforeInventoryRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "beforeInventoryRevision", "beforeInventoryRevision"), "beforeInventoryRevision", work);
  const afterInventoryRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "afterInventoryRevision", "afterInventoryRevision"), "afterInventoryRevision", work);
  const beforeTargetRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "beforeTargetRevision", "beforeTargetRevision"), "beforeTargetRevision", work);
  const afterTargetRevision = assertNonNegativeInteger(assertRequiredField(ackObject, "afterTargetRevision", "afterTargetRevision"), "afterTargetRevision", work);
  const acceptedEffectValue = assertRequiredField(ackObject, "acceptedEffect", "acceptedEffect");
  const acceptedEffect = acceptedEffectValue === null ? null : assertString(acceptedEffectValue, "acceptedEffect", work, true);
  if (accepted && code !== "accepted") {
    throw new ProtocolCodecError("malformed_message", "accepted acknowledgements must use the accepted code");
  }
  if (!accepted && code === "accepted") {
    throw new ProtocolCodecError("malformed_message", "rejected acknowledgements must not use the accepted code");
  }
  return {
    clientSequence,
    issuedTick,
    accepted,
    code,
    authorityOrder,
    processedTick,
    beforeWorldRevision,
    afterWorldRevision,
    beforeInventoryRevision,
    afterInventoryRevision,
    beforeTargetRevision,
    afterTargetRevision,
    acceptedEffect,
  };
}

function assertCommandAcknowledgementMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolCommandAcknowledgementMessage {
  const allowedFields = new Set(["kind", "streamSequence", "acknowledgements"]);
  assertAllowedFields(value, "command acknowledgement message", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const acknowledgements = assertArray(value["acknowledgements"], "acknowledgements", work, MAX_BATCH_COMMANDS, "batch_too_large").map((entry) => assertCommandAcknowledgement(entry, work));
  return { kind: "command_acknowledgement", streamSequence, acknowledgements };
}

function assertSnapshotMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolSnapshotMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "snapshot"]);
  assertAllowedFields(value, "snapshot message", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  assertSnapshotShape(value["snapshot"], work);
  const snapshot = wrapReplicaValidation("snapshot", () => decodeWorldSnapshot(value["snapshot"]));
  if (snapshot.worldRevision < 0) {
    throw new ProtocolCodecError("invalid_revision", "snapshot.worldRevision must be non-negative");
  }
  return {
    kind: "snapshot",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    snapshot,
  };
}

function assertDeltaMessage(value: Record<string, unknown>, work: DecoderWork): ProtocolDeltaMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "delta"]);
  assertAllowedFields(value, "delta message", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  assertDeltaShape(value["delta"], work);
  const deltaObject = assertPlainObject(value["delta"], "delta", work);
  const cellEntries = deltaObject["cells"];
  const playerEntries = deltaObject["players"];
  const fallingObjectEntries = deltaObject["fallingObjects"];
  const metadataEntries = deltaObject["metadata"];
  if (Array.isArray(cellEntries) && cellEntries.length > MAX_CELL_DELTAS) {
    throw new ProtocolCodecError("cell_too_large", `delta.cells exceeds the ${MAX_CELL_DELTAS} entry limit`);
  }
  if (Array.isArray(playerEntries) && playerEntries.length > MAX_ENTITY_DELTAS) {
    throw new ProtocolCodecError("entity_too_large", `delta.players exceeds the ${MAX_ENTITY_DELTAS} entry limit`);
  }
  if (Array.isArray(fallingObjectEntries) && fallingObjectEntries.length > MAX_ENTITY_DELTAS) {
    throw new ProtocolCodecError("entity_too_large", `delta.fallingObjects exceeds the ${MAX_ENTITY_DELTAS} entry limit`);
  }
  if (Array.isArray(metadataEntries) && metadataEntries.length > MAX_METADATA_ENTRIES) {
    throw new ProtocolCodecError("entity_too_large", `delta.metadata exceeds the ${MAX_METADATA_ENTRIES} entry limit`);
  }
  const delta = wrapReplicaValidation("delta", () => decodeWorldDelta(value["delta"]));
  if (delta.targetRevision < delta.baseRevision) {
    throw new ProtocolCodecError("invalid_revision", "delta.targetRevision must be >= delta.baseRevision");
  }
  return {
    kind: "delta",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    delta,
  };
}

function assertResyncRequest(value: Record<string, unknown>, work: DecoderWork): ProtocolResyncRequestMessage {
  const allowedFields = new Set(["kind", "streamSequence", "reason", "lastKnownStreamSequence", "lastKnownWorldRevision"]);
  assertAllowedFields(value, "resync request", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const reason = value["reason"] === undefined ? undefined : assertLiteralString(value["reason"], "reason", work, new Set<ProtocolResyncReason>(["stale", "out_of_date", "delta_gap", "protocol_error"]));
  const lastKnownStreamSequence = assertOptionalInteger(value["lastKnownStreamSequence"], "lastKnownStreamSequence", work);
  const lastKnownWorldRevision = assertOptionalInteger(value["lastKnownWorldRevision"], "lastKnownWorldRevision", work);
  return { kind: "resync_request", streamSequence, reason, lastKnownStreamSequence, lastKnownWorldRevision };
}

function assertResyncRequired(value: Record<string, unknown>, work: DecoderWork): ProtocolResyncRequiredMessage {
  const allowedFields = new Set(["kind", "streamSequence", "reason", "lastKnownStreamSequence", "lastKnownWorldRevision"]);
  assertAllowedFields(value, "resync required", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const reason = assertLiteralString(value["reason"], "reason", work, new Set<ProtocolResyncReason>(["stale", "out_of_date", "delta_gap", "protocol_error"]));
  const lastKnownStreamSequence = assertOptionalInteger(value["lastKnownStreamSequence"], "lastKnownStreamSequence", work);
  const lastKnownWorldRevision = assertOptionalInteger(value["lastKnownWorldRevision"], "lastKnownWorldRevision", work);
  return { kind: "resync_required", streamSequence, reason, lastKnownStreamSequence, lastKnownWorldRevision };
}

function assertProtocolError(value: Record<string, unknown>, work: DecoderWork): ProtocolErrorMessage {
  const allowedFields = new Set(["kind", "streamSequence", "code", "message"]);
  assertAllowedFields(value, "protocol error", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const code = assertLiteralString(value["code"], "code", work, new Set<ProtocolErrorCode>([
    "unsupported_protocol_version",
    "unsupported_message_kind",
    "unsupported_schema_version",
    "invalid_json",
    "invalid_utf8",
    "frame_too_large",
    "malformed_message",
    "unknown_field",
    "invalid_id",
    "invalid_integer",
    "invalid_revision",
    "invalid_dimensions",
    "batch_too_large",
    "cell_too_large",
    "entity_too_large",
    "decoder_work_limit_exceeded",
  ]));
  const message = assertOptionalString(value["message"], "message", work);
  return { kind: "protocol_error", streamSequence, code, message };
}

function assertPing(value: Record<string, unknown>, work: DecoderWork): ProtocolPingMessage {
  const allowedFields = new Set(["kind", "streamSequence", "nonce"]);
  assertAllowedFields(value, "ping", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const nonce = assertOptionalString(value["nonce"], "nonce", work);
  return { kind: "ping", streamSequence, nonce };
}

function assertPong(value: Record<string, unknown>, work: DecoderWork): ProtocolPongMessage {
  const allowedFields = new Set(["kind", "streamSequence", "nonce"]);
  assertAllowedFields(value, "pong", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const nonce = assertOptionalString(value["nonce"], "nonce", work);
  return { kind: "pong", streamSequence, nonce };
}

function assertRoomClosure(value: Record<string, unknown>, work: DecoderWork): ProtocolRoomClosureMessage {
  const allowedFields = new Set(["kind", "streamSequence", "code", "reason"]);
  assertAllowedFields(value, "room closure", allowedFields, work);
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const code = assertLiteralString(value["code"], "code", work, new Set<ProtocolRoomClosureCode>(["room_closed", "room_replaced", "server_shutdown", "protocol_error"]));
  const reason = assertOptionalString(value["reason"], "reason", work);
  return { kind: "room_closed", streamSequence, code, reason };
}

function assertHello(value: Record<string, unknown>, work: DecoderWork): ProtocolHelloMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "clientId", "clientName"]);
  assertAllowedFields(value, "hello", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const clientId = assertOptionalString(value["clientId"], "clientId", work);
  const clientName = assertOptionalString(value["clientName"], "clientName", work);
  return {
    kind: "hello",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    clientId,
    clientName,
  };
}

function assertJoin(value: Record<string, unknown>, work: DecoderWork): ProtocolJoinMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "roomId", "resumeToken"]);
  assertAllowedFields(value, "join", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const resumeToken = value["resumeToken"] === undefined ? undefined : assertString(value["resumeToken"], "resumeToken", work, false);
  return {
    kind: "join",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    roomId,
    resumeToken,
  };
}

function assertJoinAccepted(value: Record<string, unknown>, work: DecoderWork): ProtocolJoinAcceptedMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "roomId", "playerId"]);
  assertAllowedFields(value, "join accepted", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const playerId = assertPlayerId(value["playerId"], "playerId", work);
  return {
    kind: "join_accepted",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    roomId,
    playerId,
  };
}

function assertJoinRejected(value: Record<string, unknown>, work: DecoderWork): ProtocolJoinRejectedMessage {
  const allowedFields = new Set(["kind", "protocolVersion", "worldSnapshotSchemaVersion", "worldStateSchemaVersion", "streamSequence", "roomId", "code", "message"]);
  assertAllowedFields(value, "join rejected", allowedFields, work);
  const versioned = assertVersionedMessageFields(value, work) as ProtocolVersionedMessage;
  const streamSequence = assertNonNegativeInteger(value["streamSequence"], "streamSequence", work);
  const roomId = assertRoomId(value["roomId"], "roomId", work);
  const code = assertLiteralString(value["code"], "code", work, new Set<ProtocolJoinRejectCode>([
    "room_not_found",
    "room_full",
    "already_joined",
    "unauthorized",
    "protocol_error",
  ]));
  const message = assertOptionalString(value["message"], "message", work);
  return {
    kind: "join_rejected",
    protocolVersion: versioned.protocolVersion,
    worldSnapshotSchemaVersion: versioned.worldSnapshotSchemaVersion,
    worldStateSchemaVersion: versioned.worldStateSchemaVersion,
    streamSequence,
    roomId,
    code,
    message,
  };
}

function assertProtocolMessageObject(value: unknown): ProtocolMessage {
  const work: DecoderWork = { used: 0 };
  const object = assertPlainObject(value, "protocol message", work);
  const kindValue = assertString(object["kind"], "kind", work, false);
  switch (kindValue) {
    case "hello":
      return assertHello(object, work);
    case "join":
      return assertJoin(object, work);
    case "join_accepted":
      return assertJoinAccepted(object, work);
    case "join_rejected":
      return assertJoinRejected(object, work);
    case "command_batch":
      return assertCommandBatch(object, work);
    case "command_acknowledgement":
      return assertCommandAcknowledgementMessage(object, work);
    case "snapshot":
      return assertSnapshotMessage(object, work);
    case "delta":
      return assertDeltaMessage(object, work);
    case "resync_request":
      return assertResyncRequest(object, work);
    case "resync_required":
      return assertResyncRequired(object, work);
    case "protocol_error":
      return assertProtocolError(object, work);
    case "ping":
      return assertPing(object, work);
    case "pong":
      return assertPong(object, work);
    case "room_closed":
      return assertRoomClosure(object, work);
    default:
      throw new ProtocolCodecError("unsupported_message_kind", `Unsupported message kind ${kindValue}`);
  }
}

export function encodeProtocolMessage(message: unknown): Uint8Array {
  return encodeProtocolJsonMessage(message);
}

export function decodeProtocolMessage(input: unknown): ProtocolMessage {
  const decoded = typeof input === "string" || input instanceof ArrayBuffer || ArrayBuffer.isView(input)
    ? decodeProtocolJsonFrame(input)
    : input;
  return assertProtocolMessageObject(decoded);
}

export function decodeProtocolMessageObject(value: unknown): ProtocolMessage {
  return assertProtocolMessageObject(value);
}
