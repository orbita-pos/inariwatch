import { describe, it, expect } from "vitest";
import { formatMs } from "../format-time";

describe("formatMs", () => {
  it("formats zero as 0:00.000", () => {
    expect(formatMs(0)).toBe("0:00.000");
  });

  it("formats sub-second values", () => {
    expect(formatMs(42)).toBe("0:00.042");
    expect(formatMs(999)).toBe("0:00.999");
  });

  it("formats seconds with padding", () => {
    expect(formatMs(1000)).toBe("0:01.000");
    expect(formatMs(9000)).toBe("0:09.000");
    expect(formatMs(10_000)).toBe("0:10.000");
  });

  it("formats minutes", () => {
    expect(formatMs(60_000)).toBe("1:00.000");
    expect(formatMs(65_500)).toBe("1:05.500");
    expect(formatMs(125_123)).toBe("2:05.123");
  });

  it("pads milliseconds with leading zeros", () => {
    expect(formatMs(1005)).toBe("0:01.005");
    expect(formatMs(1050)).toBe("0:01.050");
  });

  it("handles negative and NaN input gracefully", () => {
    expect(formatMs(-1)).toBe("0:00.000");
    expect(formatMs(NaN)).toBe("0:00.000");
    expect(formatMs(Infinity)).toBe("0:00.000");
  });

  it("truncates fractional ms", () => {
    expect(formatMs(1234.9)).toBe("0:01.234");
  });
});
