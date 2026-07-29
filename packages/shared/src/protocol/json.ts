import { MAX_FRAME_BYTES } from "./limits.js";
import type { ProtocolErrorCode } from "./types.js";

export class ProtocolCodecError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProtocolCodecError";
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type ProtocolFrameInput = Uint8Array | ArrayBuffer | ArrayBufferView | string;

function toUtf8Bytes(input: ProtocolFrameInput): Uint8Array {
  if (typeof input === "string") {
    if (input.length > MAX_FRAME_BYTES) {
      throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    const encoded = textEncoder.encode(input);
    if (encoded.byteLength > MAX_FRAME_BYTES) {
      throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    return encoded;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_FRAME_BYTES) {
      throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    return new Uint8Array(input);
  }
  if (input instanceof ArrayBuffer) {
    if (input.byteLength > MAX_FRAME_BYTES) {
      throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    if (view.byteLength > MAX_FRAME_BYTES) {
      throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return bytes;
  }
  return new Uint8Array();
}

export function encodeProtocolMessage(message: unknown): Uint8Array {
  let payload: string;
  try {
    payload = JSON.stringify(message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    throw new ProtocolCodecError("invalid_json", `Protocol message could not be serialized: ${messageText}`);
  }
  if (payload === undefined) {
    throw new ProtocolCodecError("invalid_json", "Protocol message must be JSON-serializable");
  }
  return toUtf8Bytes(payload);
}

export function decodeProtocolMessageFrame(input: ProtocolFrameInput): unknown {
  const bytes = toUtf8Bytes(input);
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolCodecError("frame_too_large", `Protocol frame exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new ProtocolCodecError("invalid_utf8", "Protocol message is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolCodecError("malformed_message", "Protocol message is not valid JSON");
  }
}
