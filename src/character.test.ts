/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { attachCharacterInput, getCharacterInputState, resetCharacterInputState } from "./character";
import { consumeBufferedInputs, createInputEdgeBuffer, type InputEdgeBuffer } from "./input-buffer";

function dispatchMouseEvent(type: "mousedown" | "mouseup"): void {
  window.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
}

function dispatchPointerEvent(type: "pointerdown" | "pointerup" | "pointercancel" | "lostpointercapture", options: { pointerId?: number; pointerType?: string; button?: number } = {}): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { pointerId: number; pointerType: string; button: number };
  Object.defineProperties(event, {
    pointerId: { configurable: true, value: options.pointerId ?? 0 },
    pointerType: { configurable: true, value: options.pointerType ?? "mouse" },
    button: { configurable: true, value: options.button ?? 0 },
  });
  window.dispatchEvent(event);
}

describe("character mine input aggregation", () => {
  let buffer: InputEdgeBuffer;

  beforeEach(() => {
    buffer = createInputEdgeBuffer();
    attachCharacterInput(buffer);
    resetCharacterInputState();
  });

  it("keeps mine true after mouse release while touch remains held", () => {
    dispatchMouseEvent("mousedown");
    dispatchPointerEvent("pointerdown", { pointerId: 2, pointerType: "touch" });
    dispatchMouseEvent("mouseup");

    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 2, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("keeps mine true when touch and mouse are added in reverse order", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 3, pointerType: "touch" });
    dispatchMouseEvent("mousedown");
    dispatchPointerEvent("pointerup", { pointerId: 3, pointerType: "touch" });

    expect(getCharacterInputState().mine).toBe(true);

    dispatchMouseEvent("mouseup");
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("keeps mine true while one of two simultaneous touch pointers remains active", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 4, pointerType: "touch" });
    dispatchPointerEvent("pointerdown", { pointerId: 5, pointerType: "touch" });
    dispatchPointerEvent("pointerup", { pointerId: 4, pointerType: "touch" });

    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointercancel", { pointerId: 5, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("clears the final touch pointer on pointercancel", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 6, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointercancel", { pointerId: 6, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("rejects secondary mouse button pointer events while preserving primary mouse and touch behavior", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 7, pointerType: "mouse", button: 1 });
    expect(getCharacterInputState().mine).toBe(false);

    dispatchPointerEvent("pointerdown", { pointerId: 8, pointerType: "mouse", button: 0 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 7, pointerType: "mouse", button: 2 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerdown", { pointerId: 9, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointercancel", { pointerId: 7, pointerType: "mouse", button: 1 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 8, pointerType: "mouse", button: 0 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 9, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("rejects secondary pen button pointer events while preserving primary pen behavior", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 10, pointerType: "pen", button: 2 });
    expect(getCharacterInputState().mine).toBe(false);

    dispatchPointerEvent("pointerdown", { pointerId: 11, pointerType: "pen", button: 0 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 10, pointerType: "pen", button: 2 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 11, pointerType: "pen", button: 0 });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("clears primary mouse mining on pointercancel with button -1", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 12, pointerType: "mouse", button: 0 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointercancel", { pointerId: 12, pointerType: "mouse", button: -1 });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("clears primary pen mining on lostpointercapture with button -1", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 13, pointerType: "pen", button: 0 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("lostpointercapture", { pointerId: 13, pointerType: "pen", button: -1 });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("keeps touch mining active when mouse or pen cleanup events arrive for another pointer", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 14, pointerType: "touch" });
    dispatchPointerEvent("pointerdown", { pointerId: 15, pointerType: "mouse", button: 0 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointercancel", { pointerId: 15, pointerType: "mouse", button: -1 });
    expect(getCharacterInputState().mine).toBe(true);

    dispatchPointerEvent("pointerup", { pointerId: 14, pointerType: "touch" });
    expect(getCharacterInputState().mine).toBe(false);
  });

  it("emits exactly one consumed mine edge for a fast touch tap", () => {
    dispatchPointerEvent("pointerdown", { pointerId: 16, pointerType: "touch" });
    dispatchPointerEvent("pointerup", { pointerId: 16, pointerType: "touch" });

    expect(consumeBufferedInputs(buffer).mineHeld).toBe(true);
    expect(consumeBufferedInputs(buffer).mineHeld).toBe(false);
  });
});
