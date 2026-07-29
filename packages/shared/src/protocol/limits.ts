export const PROTOCOL_VERSION = 1 as const;

// Bounded UTF-8 JSON framing.
export const MAX_FRAME_BYTES = 1024 * 1024;

// String and ID safety limits.
export const MAX_ID_LENGTH = 128;
export const MAX_STRING_LENGTH = 4096;

// Nested object and collection safety limits.
export const MAX_OBJECT_FIELDS = 64;
export const MAX_NESTED_COLLECTION_ITEMS = 100_000;

// Batch and entity safety limits.
export const MAX_BATCH_COMMANDS = 64;
export const MAX_CELL_DELTAS = 4096;
export const MAX_ENTITY_DELTAS = 256;
export const MAX_METADATA_ENTRIES = 32;

// Decoder work budget for bounded fuzzing and resource safety.
export const MAX_DECODER_WORK = 100_000;

// Integer range limits that match the shared replication validators.
export const MIN_INTEGER = 0;
export const MAX_INTEGER = 0x1_0000_0000 - 1;
