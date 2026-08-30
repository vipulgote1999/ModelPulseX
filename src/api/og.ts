import { Hono } from "hono";
import type { Env } from "../types";

/** CRC-32 IEEE table */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = u32be(data.length);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crc = u32be(crc32(crcInput));
  const out = new Uint8Array(4 + 4 + data.length + 4);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  out.set(crc, 8 + data.length);
  return out;
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== "undefined") {
    const cs = new CompressionStream("deflate");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    // cast to any to satisfy BufferSource union (ArrayBuffer vs SharedArrayBuffer)
    writer.write(data as unknown as Uint8Array<ArrayBuffer>);
    writer.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value as Uint8Array);
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require("node:zlib") as typeof import("node:zlib");
  return zlib.deflateSync(data);
}

export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) throw new Error("rgba length mismatch");
  const stride = width * 4;
  const scanlines = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + stride)] = 0;
    scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const compressed = await deflateZlib(scanlines);
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = chunk("IHDR", ihdr);
  const c2 = chunk("IDAT", compressed);
  const c3 = chunk("IEND", new Uint8Array(0));
  const out = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let off = 0;
  out.set(sig, off); off += sig.length;
  out.set(c1, off); off += c1.length;
  out.set(c2, off); off += c2.length;
  out.set(c3, off);
  return out;
}

const FONT_5X7: Record<string, number[]> = {
  "A": [0x0E,0x11,0x11,0x1F,0x11,0x11,0x11],
  "B": [0x1E,0x11,0x1E,0x11,0x11,0x11,0x1E],
  "C": [0x0E,0x11,0x10,0x10,0x10,0x11,0x0E],
  "D": [0x1E,0x11,0x11,0x11,0x11,0x11,0x1E],
  "E": [0x1F,0x10,0x1E,0x10,0x10,0x10,0x1F],
  "F": [0x1F,0x10,0x1E,0x10,0x10,0x10,0x10],
  "G": [0x0E,0x11,0x10,0x17,0x11,0x11,0x0F],
  "H": [0x11,0x11,0x11,0x1F,0x11,0x11,0x11],
  "I": [0x0E,0x04,0x04,0x04,0x04,0x04,0x0E],
  "J": [0x07,0x02,0x02,0x02,0x02,0x12,0x0C],
  "K": [0x11,0x12,0x14,0x18,0x14,0x12,0x11],
  "L": [0x10,0x10,0x10,0x10,0x10,0x10,0x1F],
  "M": [0x11,0x1B,0x15,0x15,0x11,0x11,0x11],
  "N": [0x11,0x19,0x15,0x13,0x11,0x11,0x11],
  "O": [0x0E,0x11,0x11,0x11,0x11,0x11,0x0E],
  "P": [0x1E,0x11,0x11,0x1E,0x10,0x10,0x10],
  "Q": [0x0E,0x11,0x11,0x11,0x15,0x12,0x0D],
  "R": [0x1E,0x11,0x11,0x1E,0x14,0x12,0x11],
  "S": [0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E],
  "T": [0x1F,0x04,0x04,0x04,0x04,0x04,0x04],
  "U": [0x11,0x11,0x11,0x11,0x11,0x11,0x0E],
  "V": [0x11,0x11,0x11,0x11,0x11,0x0A,0x04],
  "W": [0x11,0x11,0x11,0x15,0x15,0x1B,0x11],
  "X": [0x11,0x11,0x0A,0x04,0x0A,0x11,0x11],
  "Y": [0x11,0x11,0x0A,0x04,0x04,0x04,0x04],
  "Z": [0x1F,0x01,0x02,0x04,0x08,0x10,0x1F],
  "0": [0x0E,0x11,0x13,0x15,0x19,0x11,0x0E],
  "1": [0x04,0x0C,0x04,0x04,0x04,0x04,0x0E],
  "2": [0x0E,0x11,0x01,0x02,0x04,0x08,0x1F],
  "3": [0x1F,0x02,0x04,0x02,0x01,0x11,0x0E],
  "4": [0x02,0x06,0x0A,0x12,0x1F,0x02,0x02],
  "5": [0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E],
  "6": [0x06,0x08,0x10,0x1E,0x11,0x11,0x0E],
  "7": [0x1F,0x01,0x02,0x04,0x08,0x08,0x08],
  "8": [0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E],
  "9": [0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C],
  ".": [0x00,0x00,0x00,0x00,0x00,0x0C,0x0C],
  ":": [0x00,0x0C,0x0C,0x00,0x0C,0x0C,0x00],
  "/": [0x01,0x02,0x04,0x08,0x10,0x10,0x10],
  "-": [0x00,0x00,0x00,0x1F,0x00,0x00,0x00],
  "%": [0x18,0x19,0x02,0x04,0x08,0x13,0x03],
  "+": [0x00,0x04,0x04,0x1F,0x04,0x04,0x00],
  " ": [0x00,0x00,0x00,0x00,0x00,0x00,0x00],
};

function glyphFor(ch: string): number[] {
  if (FONT_5X7[ch]) return FONT_5X7[ch]!;
  const up = ch.toUpperCase();
  if (FONT_5X7[up]) return FONT_5X7[up]!;
  return FONT_5X7[" "]!;
}

function fillRect(rgba: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const idx = (py * width + px) * 4;
      rgba[idx] = r; rgba[idx + 1] = g; rgba[idx + 2] = b; rgba[idx + 3] = a;
    }
  }
}

function drawText(rgba: Uint8Array, width: number, height: number, text: string, x: number, y: number, scale: number, r: number, g: number, b: number) {
  let cx = x;
  for (const ch of text) {
    const glyph = glyphFor(ch);
    for (let gy = 0; gy < 7; gy++) {
      const row = glyph[gy] ?? 0;
      for (let gx = 0; gx < 5; gx++) {
        if ((row >> (4 - gx)) & 1) {
          fillRect(rgba, width, height, cx + gx * scale, y + gy * scale, scale, scale, r, g, b, 255);
        }
      }
    }
    cx += (5 * scale + scale);
  }
}

export async function renderOgCard(rows: Array<{ rank: number; name: string; provider: string; tps: number | null }>): Promise<Uint8Array> {
  const W = 1200, H = 630;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = 10; rgba[i * 4 + 1] = 10; rgba[i * 4 + 2] = 15; rgba[i * 4 + 3] = 255;
  }
  fillRect(rgba, W, H, 0, 0, W, 8, 139, 92, 246, 255);
  drawText(rgba, W, H, "ModelPulseX", 40, 40, 3, 232, 232, 239);
  drawText(rgba, W, H, "Top free models by throughput", 40, 100, 2, 161, 161, 170);
  let y = 160;
  const display = rows.slice(0, 5);
  if (display.length === 0) {
    drawText(rgba, W, H, "data unavailable", 40, y, 2, 161, 161, 170);
  } else {
    for (const r of display) {
      const tpsLabel = r.tps != null ? `${r.tps.toFixed(1)} TPS` : "--";
      const line = `${r.rank}. ${r.name.slice(0, 36)}  ${r.provider}  ${tpsLabel}`;
      drawText(rgba, W, H, line, 40, y, 2, 212, 212, 216);
      fillRect(rgba, W, H, 40, y + 36, W - 80, 1, 39, 39, 42, 255);
      y += 50;
    }
  }
  const footer = `measured ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  drawText(rgba, W, H, footer, 40, H - 40, 1, 113, 113, 122);
  return encodePng(W, H, rgba);
}

export function ogRoutes(env: Env) {
  const r = new Hono<{ Bindings: Env }>();
  r.get("/og.png", async (_c) => {
    try {
      let top: Array<{ rank: number; name: string; provider: string; tps: number | null }> = [];
      try {
        const rows = await env.DB.prepare(
          `SELECT m.display_name as name, p.name as provider, br.tps FROM benchmark_runs br JOIN models m ON m.id=br.model_id JOIN providers p ON p.id=m.provider_id WHERE br.status='SUCCESS' AND m.free_status='FREE' ORDER BY br.tps DESC LIMIT 5`
        ).all<{ name: string; provider: string; tps: number | null }>();
        top = (rows.results ?? []).map((r, i) => ({ rank: i + 1, name: r.name, provider: r.provider, tps: r.tps }));
      } catch {
        // pre-migration — ignore
      }
      const png = await renderOgCard(top);
      return new Response(png as unknown as BodyInit, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=300", "content-length": String(png.byteLength) },
      });
    } catch {
      const png = await renderOgCard([]);
      return new Response(png as unknown as BodyInit, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=300" },
      });
    }
  });
  return r;
}
