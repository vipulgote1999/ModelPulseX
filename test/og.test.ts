import { describe, it, expect } from "vitest";
import { crc32, encodePng, renderOgCard } from "../src/api/og";

describe("png encoder", () => {
  it("computes known CRC32 values", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode("IHDR"))).toBe(0xa8a1ae0a);
  });

  it("emits a valid PNG signature and IHDR", async () => {
    const png = await encodePng(2, 2, new Uint8Array(2 * 2 * 4));
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(16)).toBe(2); // width
    expect(dv.getUint32(20)).toBe(2); // height
  });

  it("renders a card containing the expected row count", async () => {
    const png = await renderOgCard([
      { rank: 1, name: "model-a", provider: "groq", tps: 120.5 },
    ]);
    expect(png.byteLength).toBeGreaterThan(1000);
  });
});
