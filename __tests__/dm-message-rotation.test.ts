import { describe, it, expect, afterEach, vi } from "vitest";
import { pickDmMessage } from "@/lib/queue/dm-worker";

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
