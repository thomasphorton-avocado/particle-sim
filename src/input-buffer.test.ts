import { describe, expect, it } from "vitest";
import { consumeBufferedInputs, createInputEdgeBuffer, setInputEdgeBufferHeld, updateInputEdgeBuffer } from "./input-buffer";

describe("input edge buffer", () => {
  it("emits one edge for a fast tap and then clears it", () => {
    const buffer = createInputEdgeBuffer();

    setInputEdgeBufferHeld(buffer, "jump", true);
    setInputEdgeBufferHeld(buffer, "jump", false);

    const firstTick = consumeBufferedInputs(buffer);
    expect(firstTick.jumpHeld).toBe(true);
    const secondTick = consumeBufferedInputs(buffer);
    expect(secondTick.jumpHeld).toBe(false);
  });

  it("uses the current held state after the latch has been consumed", () => {
    const buffer = createInputEdgeBuffer();

    setInputEdgeBufferHeld(buffer, "mine", true);
    const firstTick = consumeBufferedInputs(buffer);
    expect(firstTick.mineHeld).toBe(true);

    setInputEdgeBufferHeld(buffer, "mine", false);
    const secondTick = consumeBufferedInputs(buffer);
    expect(secondTick.mineHeld).toBe(false);

    setInputEdgeBufferHeld(buffer, "mine", true);
    const thirdTick = consumeBufferedInputs(buffer);
    expect(thirdTick.mineHeld).toBe(true);
  });
});

describe("updateInputEdgeBuffer", () => {
  it("latches jump on a rising edge via updateInputEdgeBuffer", () => {
    const buffer = createInputEdgeBuffer();

    updateInputEdgeBuffer(buffer, { jump: true, mine: false });
    expect(buffer.latchedJump).toBe(true);
    expect(buffer.heldJump).toBe(true);

    const tick = consumeBufferedInputs(buffer);
    expect(tick.jumpHeld).toBe(true);
    expect(buffer.latchedJump).toBe(false);
  });

  it("latches mine on a rising edge via updateInputEdgeBuffer", () => {
    const buffer = createInputEdgeBuffer();

    updateInputEdgeBuffer(buffer, { jump: false, mine: true });
    expect(buffer.latchedMine).toBe(true);

    const tick = consumeBufferedInputs(buffer);
    expect(tick.mineHeld).toBe(true);
  });

  it("does not re-latch when both controls remain held across two updates", () => {
    const buffer = createInputEdgeBuffer();

    updateInputEdgeBuffer(buffer, { jump: true, mine: true });
    consumeBufferedInputs(buffer);

    updateInputEdgeBuffer(buffer, { jump: true, mine: true });
    expect(buffer.latchedJump).toBe(false);
    expect(buffer.latchedMine).toBe(false);

    const tick = consumeBufferedInputs(buffer);
    // Still held, so consumed result reflects the held state
    expect(tick.jumpHeld).toBe(true);
    expect(tick.mineHeld).toBe(true);
  });

  it("reports false for both when controls are released via updateInputEdgeBuffer", () => {
    const buffer = createInputEdgeBuffer();

    updateInputEdgeBuffer(buffer, { jump: true, mine: true });
    consumeBufferedInputs(buffer);

    updateInputEdgeBuffer(buffer, { jump: false, mine: false });
    const tick = consumeBufferedInputs(buffer);
    expect(tick.jumpHeld).toBe(false);
    expect(tick.mineHeld).toBe(false);
  });
});
