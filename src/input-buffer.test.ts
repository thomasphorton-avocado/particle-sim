import { describe, expect, it } from "vitest";
import { consumeBufferedInputs, createInputEdgeBuffer, setInputEdgeBufferHeld } from "./input-buffer";

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
