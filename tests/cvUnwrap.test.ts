import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import zlib from "node:zlib";
import { app } from "../index";
import { isPng, isWebP, needsUnwrap, unwrapChunk } from "../src/utils/cvUnwrap";

describe("cvUnwrap", () => {
  const TS_SYNC = 0x47;
  const TS_PACKET = 188;

  it("identifies PNG and WebP headers", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(isPng(png)).toBe(true);
    expect(isWebP(png)).toBe(false);

    const webp = new Uint8Array([
      82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80,
    ]);
    expect(isWebP(webp)).toBe(true);
    expect(isPng(webp)).toBe(false);
  });

  it("returns false for raw MPEG-TS segments", () => {
    // 2 valid 188-byte packets starting with 0x47
    const rawTs = new Uint8Array(TS_PACKET * 2);
    rawTs[0] = TS_SYNC;
    rawTs[TS_PACKET] = TS_SYNC;

    expect(needsUnwrap(rawTs)).toBe(false);
    const result = unwrapChunk(rawTs);
    expect(result).toBe(rawTs);
  });

  it("unwraps Cinevid TikTok-CDN disguised PNG chunk to valid MPEG-TS", () => {
    if (!fs.existsSync("/tmp/test_chunk.png")) {
      return;
    }

    const disguised = new Uint8Array(fs.readFileSync("/tmp/test_chunk.png"));
    expect(needsUnwrap(disguised)).toBe(true);

    const unwrapped = unwrapChunk(disguised);
    expect(unwrapped.length).toBeGreaterThan(0);
    expect(unwrapped[0]).toBe(TS_SYNC);
    expect(unwrapped[TS_PACKET]).toBe(TS_SYNC);
    expect(unwrapped.length % TS_PACKET).toBe(0);

    // If expected file exists, verify exact match
    if (fs.existsSync("/tmp/test_unwrapped.ts")) {
      const expected = new Uint8Array(fs.readFileSync("/tmp/test_unwrapped.ts"));
      expect(unwrapped.length).toBe(expected.length);
      expect(Buffer.from(unwrapped).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it("leaves normal PNG image untouched if it contains no video", () => {
    // A minimal 1x1 valid PNG image
    const minimalPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const pngBytes = new Uint8Array(minimalPng);
    const result = unwrapChunk(pngBytes);
    // Should be returned as-is (not corrupted)
    expect(Buffer.from(result).equals(minimalPng)).toBe(true);
  });

  it("unwraps disguised chunks through /proxy-chunk endpoint", async () => {
    if (!fs.existsSync("/tmp/test_chunk.png")) {
      return;
    }

    // Mock an upstream server delivering the disguised PNG chunk
    const testChunk = fs.readFileSync("/tmp/test_chunk.png");
    const mockServer = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(testChunk, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": testChunk.length.toString(),
          },
        });
      },
    });

    try {
      const chunkUrl = `http://localhost:${mockServer.port}/segment-0.png`;
      const res = await app.handle(
        new Request(
          `http://localhost/proxy-chunk?url=${encodeURIComponent(chunkUrl)}`,
        ),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("video/mp2t");

      const body = new Uint8Array(await res.arrayBuffer());
      expect(body[0]).toBe(TS_SYNC);
      expect(body[TS_PACKET]).toBe(TS_SYNC);
      expect(body.length % TS_PACKET).toBe(0);
    } finally {
      mockServer.stop();
    }
  });

  it("unwraps Matchora disguised PNG chunk using iTXt compressed metadata into MPEG-TS", () => {
    // Build a mock TS buffer of 2 packets
    const mockTs = new Uint8Array(TS_PACKET * 2);
    mockTs[0] = TS_SYNC;
    mockTs[1] = 0x10;
    mockTs[TS_PACKET] = TS_SYNC;
    mockTs[TS_PACKET + 1] = 0x20;

    const base64Ts = Buffer.from(mockTs).toString("base64");
    const compressedText = zlib.deflateSync(Buffer.from(base64Ts, "utf8"));

    // Construct valid PNG with IHDR, iTXt, and IEND
    const keyword = Buffer.from("payload-0001\0", "utf8");
    const itxtData = Buffer.concat([
      keyword,
      Buffer.from([1, 0, 0]), // compFlag=1, compMethod=0, langTag="" (null)
      Buffer.from([0]), // transKeyword="" (null)
      compressedText,
    ]);

    // PNG signature (8) + IHDR (25) + iTXt chunk + IEND (12)
    const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.from([
      0, 0, 0, 13, // length 13
      73, 72, 68, 82, // IHDR
      0, 0, 0, 1, // w=1
      0, 0, 0, 1, // h=1
      8, 6, 0, 0, 0, // 8-bit RGBA
      0x1f, 0x15, 0xc4, 0x89, // CRC
    ]);

    const itxtLen = Buffer.alloc(4);
    itxtLen.writeUInt32BE(itxtData.length, 0);
    const itxtTag = Buffer.from("iTXt", "ascii");
    const itxtCrc = Buffer.alloc(4); // Dummy CRC

    const iend = Buffer.from([
      0, 0, 0, 0,
      73, 69, 78, 68,
      0xae, 0x42, 0x60, 0x82,
    ]);

    const pngWithItxt = Buffer.concat([
      pngSig,
      ihdr,
      itxtLen,
      itxtTag,
      itxtData,
      itxtCrc,
      iend,
    ]);

    const result = unwrapChunk(new Uint8Array(pngWithItxt));
    expect(result.length).toBe(mockTs.length);
    expect(result[0]).toBe(TS_SYNC);
    expect(result[TS_PACKET]).toBe(TS_SYNC);
    expect(Buffer.from(result).equals(Buffer.from(mockTs))).toBe(true);
  });
});
