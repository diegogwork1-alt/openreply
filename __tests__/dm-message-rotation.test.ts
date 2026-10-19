import { describe, it, expect, afterEach, vi } from "vitest";
import { pickDmMessage, pickOpeningDmMessage } from "@/lib/queue/dm-worker";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickDmMessage", () => {
  it("falls back to the single field when there are no variants", () => {
    expect(pickDmMessage({ dmMessage: "only one", dmMessages: [] })).toBe(
      "only one"
    );
  });

  it("falls back for a row written before the column existed", () => {
    // Prisma returns the default [] for migrated rows, but a caller typing the
    // field as optional must not blow up on undefined either.
    expect(pickDmMessage({ dmMessage: "legacy" })).toBe("legacy");
  });

  it("only ever returns a message from the pool", () => {
    const pool = ["a", "b", "c", "d"];
    for (let i = 0; i < 200; i++) {
      expect(pool).toContain(pickDmMessage({ dmMessage: "unused", dmMessages: pool }));
    }
  });

  it("ignores the single field once variants exist", () => {
    expect(
      pickDmMessage({ dmMessage: "stale", dmMessages: ["fresh"] })
    ).toBe("fresh");
  });

  it("spreads across the whole pool rather than sticking to the first", () => {
    const pool = ["a", "b", "c", "d"];
    // Drive the index directly: 0.0 -> first, 0.99 -> last. A pick that
    // silently clamped to one end would fail here.
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickDmMessage({ dmMessage: "x", dmMessages: pool })).toBe("a");
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(pickDmMessage({ dmMessage: "x", dmMessages: pool })).toBe("d");
  });
});

describe("pickOpeningDmMessage", () => {
  it("falls back to the single field when there are no variants", () => {
    expect(
      pickOpeningDmMessage({ openingDmMessage: "only one", openingDmMessages: [] })
    ).toBe("only one");
  });

  it("returns null when the campaign has no opening at all", () => {
    // The opening is optional, unlike the reveal DM — the gate in the worker
    // relies on this to decide whether to send a button message.
    expect(pickOpeningDmMessage({})).toBeNull();
    expect(pickOpeningDmMessage({ openingDmMessage: null })).toBeNull();
  });

  it("only ever returns a message from the pool", () => {
    const pool = ["a", "b", "c"];
    for (let i = 0; i < 200; i++) {
      expect(pool).toContain(
        pickOpeningDmMessage({ openingDmMessage: "unused", openingDmMessages: pool })
      );
    }
  });

  it("ignores blank variants rather than sending an empty opening", () => {
    // An empty row left behind in the builder must not win the draw and send
    // a button message with no text.
    expect(
      pickOpeningDmMessage({
        openingDmMessage: "fallback",
        openingDmMessages: ["", "   "],
      })
    ).toBe("fallback");
  });

  it("spreads across the whole pool", () => {
    const pool = ["a", "b", "c", "d"];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickOpeningDmMessage({ openingDmMessages: pool })).toBe("a");
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(pickOpeningDmMessage({ openingDmMessages: pool })).toBe("d");
  });
});
