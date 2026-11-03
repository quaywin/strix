import zlib from "node:zlib";

// Markers used by Cinevid / TikTok-CDN packing
const MARKER_TIKTIKPX = new Uint8Array([84, 73, 75, 84, 73, 75, 80, 88]); // "TIKTIKPX"
const MARKER_TIKTIKRAW = new Uint8Array([84, 73, 75, 84, 73, 75, 82, 65, 87]); // "TIKTIKRAW"
const MARKER_TIKTIKTSGZ = new Uint8Array([84, 73, 75, 84, 73, 75, 84, 83, 71, 90]); // "TIKTIKTSGZ"

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const TS_SYNC_BYTE = 0x47;
export const TS_PACKET_SIZE = 188;

/**
 * Big-endian 32-bit unsigned integer reader (zero-allocation).
 */
export function readUInt32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) >>> 0) +
    (buf[offset + 1]! << 16) +
    (buf[offset + 2]! << 8) +
    buf[offset + 3]!
  );
}

/**
 * Little-endian 32-bit unsigned integer reader (zero-allocation).
 */
export function readUInt32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      ((buf[offset + 3]! << 24) >>> 0)) >>> 0
  );
}

/**
 * Checks if a byte buffer starts with the PNG file signature.
 */
export function isPng(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Checks if a byte buffer starts with the WebP (RIFF....WEBP) signature.
 */
export function isWebP(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  return (
    buf[0] === 82 && // 'R'
    buf[1] === 73 && // 'I'
    buf[2] === 70 && // 'F'
    buf[3] === 70 && // 'F'
    buf[8] === 87 && // 'W'
    buf[9] === 69 && // 'E'
    buf[10] === 66 && // 'B'
    buf[11] === 80 // 'P'
  );
}

/**
 * Robustly checks if a byte buffer represents a valid MPEG-TS stream by verifying
 * sync bytes across consecutive 188-byte packets (up to 4 packets).
 */
export function isMpegTsStream(buf: Uint8Array, offset: number = 0): boolean {
  if (buf.length - offset < TS_PACKET_SIZE || buf[offset] !== TS_SYNC_BYTE) {
    return false;
  }
  const availablePackets = Math.floor((buf.length - offset) / TS_PACKET_SIZE);
  const checkCount = Math.min(availablePackets, 4);
  for (let p = 1; p < checkCount; p++) {
    if (buf[offset + p * TS_PACKET_SIZE] !== TS_SYNC_BYTE) {
      return false;
    }
  }
  return true;
}

/**
 * Trims a TS payload to the nearest complete 188-byte packet boundary.
 */
export function trimToTsPackets(buf: Uint8Array): Uint8Array {
  const remainder = buf.length % TS_PACKET_SIZE;
  if (remainder === 0) return buf;
  return buf.subarray(0, buf.length - remainder);
}

/**
 * Searches for a subarray needle inside a haystack buffer.
 */
function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * PNG Paeth predictor filter reversal.
 */
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Inspects raw PNG chunks (IDAT, eXIf, etc.) for direct uncompressed MPEG-TS payloads.
 * Supports single and split IDAT chunks.
 */
function unwrapPngChunks(data: Uint8Array): Uint8Array | null {
  if (!isPng(data) || data.length < 16) return null;

  let offset = 8;
  const idatChunks: Uint8Array[] = [];
  let totalIdatLength = 0;

  while (offset + 8 <= data.length) {
    const size = readUInt32BE(data, offset);
    if (offset + 12 + size > data.length) break;

    const tag = String.fromCharCode(
      data[offset + 4]!,
      data[offset + 5]!,
      data[offset + 6]!,
      data[offset + 7]!,
    );
    const payload = data.subarray(offset + 8, offset + 8 + size);

    if (tag === "IDAT") {
      idatChunks.push(payload);
      totalIdatLength += payload.length;
    } else if (tag.toLowerCase() === "exif") {
      if (isMpegTsStream(payload, 0)) {
        return trimToTsPackets(payload);
      }
    }

    offset += 12 + size; // 4 (len) + 4 (type) + size + 4 (crc)
  }

  // If IDAT chunks contain uncompressed raw MPEG-TS
  if (idatChunks.length === 1) {
    if (isMpegTsStream(idatChunks[0]!, 0)) {
      return trimToTsPackets(idatChunks[0]!);
    }
  } else if (idatChunks.length > 1) {
    if (idatChunks[0]![0] === TS_SYNC_BYTE) {
      const combined = new Uint8Array(totalIdatLength);
      let pos = 0;
      for (const chunk of idatChunks) {
        combined.set(chunk, pos);
        pos += chunk.length;
      }
      if (isMpegTsStream(combined, 0)) {
        return trimToTsPackets(combined);
      }
    }
  }

  return null;
}

/**
 * Extracts and defilters pixel bytes from a PNG's IDAT chunks.
 */
function defilterPngIdat(pngData: Uint8Array): Uint8Array | null {
  if (!isPng(pngData)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  const idatChunks: Uint8Array[] = [];
  let totalIdatLength = 0;

  while (offset + 8 <= pngData.length) {
    const chunkLength = readUInt32BE(pngData, offset);
    if (offset + 12 + chunkLength > pngData.length) break;

    const chunkType = String.fromCharCode(
      pngData[offset + 4]!,
      pngData[offset + 5]!,
      pngData[offset + 6]!,
      pngData[offset + 7]!,
    );

    const chunkData = pngData.subarray(offset + 8, offset + 8 + chunkLength);
    offset += 12 + chunkLength; // 4 (len) + 4 (type) + chunkLength + 4 (crc)

    if (chunkType === "IHDR") {
      width = readUInt32BE(chunkData, 0);
      height = readUInt32BE(chunkData, 4);
      bitDepth = chunkData[8]!;
      colorType = chunkData[9]!;
      interlaceMethod = chunkData[12]!;
    } else if (chunkType === "IDAT") {
      idatChunks.push(chunkData);
      totalIdatLength += chunkData.length;
    } else if (chunkType === "IEND") {
      break;
    }
  }

  // Support 8-bit RGB (2) and RGBA (6) non-interlaced
  if (
    !width ||
    !height ||
    bitDepth !== 8 ||
    interlaceMethod !== 0 ||
    (colorType !== 2 && colorType !== 6)
  ) {
    return null;
  }

  // Concatenate all IDAT chunks
  const compressedIdat = new Uint8Array(totalIdatLength);
  let pos = 0;
  for (const chunk of idatChunks) {
    compressedIdat.set(chunk, pos);
    pos += chunk.length;
  }

  // Decompress IDAT with zlib deflate
  let inflated: Uint8Array;
  try {
    inflated = zlib.inflateSync(compressedIdat);
  } catch (_) {
    return null;
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const expectedLength = height * (1 + stride);
  if (inflated.length < expectedLength) {
    return null;
  }

  const outPixels = new Uint8Array(width * height * 3);
  let inPos = 0;
  let outPos = 0;
  let prevRow = new Uint8Array(stride);

  for (let row = 0; row < height; row++) {
    const filterType = inflated[inPos++]!;
    const currRow = new Uint8Array(stride);

    for (let x = 0; x < stride; x++) {
      const val = inflated[inPos + x]!;
      const a = x >= bpp ? currRow[x - bpp]! : 0;
      const b = prevRow[x]!;
      const c = x >= bpp ? prevRow[x - bpp]! : 0;

      let filt: number;
      switch (filterType) {
        case 0: // None
          filt = val;
          break;
        case 1: // Sub
          filt = val + a;
          break;
        case 2: // Up
          filt = val + b;
          break;
        case 3: // Average
          filt = val + ((a + b) >> 1);
          break;
        case 4: // Paeth
          filt = val + paethPredictor(a, b, c);
          break;
        default:
          return null;
      }
      currRow[x] = filt & 0xff;
    }
    inPos += stride;
    prevRow = currRow;

    if (colorType === 2) {
      // Direct copy for RGB
      outPixels.set(currRow, outPos);
      outPos += stride;
    } else {
      // RGBA: strip alpha channel
      for (let x = 0; x < stride; x += 4) {
        outPixels[outPos++] = currRow[x]!;
        outPixels[outPos++] = currRow[x + 1]!;
        outPixels[outPos++] = currRow[x + 2]!;
      }
    }
  }

  return outPixels;
}

/**
 * Extracts payload packed via TIKTIKPX inside PNG IDAT pixels.
 */
function extractTikTikPx(pngData: Uint8Array): Uint8Array | null {
  const pixels = defilterPngIdat(pngData);
  if (!pixels || pixels.length < 12) return null;

  for (let i = 0; i < 8; i++) {
    if (pixels[i] !== MARKER_TIKTIKPX[i]) return null;
  }

  const payloadLen = readUInt32BE(pixels, 8);
  if (payloadLen <= 0 || 12 + payloadLen > pixels.length) return null;

  const payload = pixels.subarray(12, 12 + payloadLen);
  // Verify gzip magic bytes (0x1f, 0x8b)
  if (payload[0] !== 0x1f || payload[1] !== 0x8b) return null;

  try {
    const decompressed = zlib.gunzipSync(payload);
    if (isMpegTsStream(decompressed, 0)) {
      return trimToTsPackets(decompressed);
    }
  } catch (_) {}

  return null;
}

/**
 * Extracts MPEG-TS segments disguised in PNG compressed international text chunks (iTXt).
 * Seen on Matchora / TikTok CDN repackers where TS packets are base64-encoded, zlib-compressed,
 * and chunked into sequential `iTXt` metadata records (e.g. payload-0001 ... payload-0NNN).
 */
function unwrapPngITXt(pngData: Uint8Array): Uint8Array | null {
  if (!isPng(pngData) || pngData.length < 16) return null;

  let offset = 8;
  const parts: Uint8Array[] = [];
  let totalPartsLength = 0;

  while (offset + 8 <= pngData.length) {
    const size = readUInt32BE(pngData, offset);
    if (offset + 12 + size > pngData.length) break;

    const tag = String.fromCharCode(
      pngData[offset + 4]!,
      pngData[offset + 5]!,
      pngData[offset + 6]!,
      pngData[offset + 7]!,
    );

    if (tag === "iTXt") {
      const payload = pngData.subarray(offset + 8, offset + 8 + size);
      // Format: keyword (null-terminated), compFlag (1), compMethod (1),
      // langTag (null-terminated), transKeyword (null-terminated), text
      let p = 0;
      while (p < payload.length && payload[p] !== 0) p++;
      p++; // Skip null byte
      if (p + 2 <= payload.length) {
        const compFlag = payload[p++]!;
        p++; // Skip compMethod
        while (p < payload.length && payload[p] !== 0) p++;
        p++; // Skip null byte for langTag
        while (p < payload.length && payload[p] !== 0) p++;
        p++; // Skip null byte for transKeyword

        const textBytes = payload.subarray(p);
        if (compFlag === 1) {
          try {
            const decompressed = zlib.inflateSync(textBytes);
            parts.push(decompressed);
            totalPartsLength += decompressed.length;
          } catch (_) {}
        } else {
          parts.push(textBytes);
          totalPartsLength += textBytes.length;
        }
      }
    }

    offset += 12 + size; // 4 (len) + 4 (type) + size + 4 (crc)
  }

  if (parts.length === 0 || totalPartsLength === 0) {
    return null;
  }

  try {
    const combined = new Uint8Array(totalPartsLength);
    let cur = 0;
    for (const part of parts) {
      combined.set(part, cur);
      cur += part.length;
    }

    // Combined payload may be raw MPEG-TS or Base64-encoded MPEG-TS
    if (isMpegTsStream(combined, 0)) {
      return trimToTsPackets(combined);
    }

    // Attempt Base64 decoding
    const base64String = new TextDecoder().decode(combined);
    const decodedTs = Buffer.from(base64String, "base64");
    if (decodedTs.length >= TS_PACKET_SIZE) {
      const tsArray = new Uint8Array(
        decodedTs.buffer,
        decodedTs.byteOffset,
        decodedTs.byteLength,
      );
      if (isMpegTsStream(tsArray, 0)) {
        return trimToTsPackets(tsArray);
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Unwraps MPEG-TS embedded in WebP chunks.
 */
function unwrapWebP(data: Uint8Array): Uint8Array | null {
  if (!isWebP(data) || data.length < 16) return null;

  let offset = 12;
  while (offset + 8 <= data.length) {
    const tag = String.fromCharCode(
      data[offset]!,
      data[offset + 1]!,
      data[offset + 2]!,
      data[offset + 3]!,
    );
    const size = readUInt32LE(data, offset + 4);
    offset += 8;

    if (offset + size > data.length) return null;

    if (tag.toUpperCase() === "EXIF") {
      const payload = data.subarray(offset, offset + size);
      if (isMpegTsStream(payload, 0)) {
        return trimToTsPackets(payload);
      }
    }

    offset += size + (size & 1); // Pad to even byte boundary
  }

  return null;
}

/**
 * Tests whether a chunk likely needs unwrapping (disguised as image or marker-wrapped).
 */
export function needsUnwrap(data: Uint8Array): boolean {
  if (data.length === 0) return false;
  // If it already starts with MPEG-TS sync byte 0x47 and has valid packets, it's raw TS
  if (isMpegTsStream(data, 0)) {
    return false;
  }
  return (
    isPng(data) ||
    isWebP(data) ||
    indexOfSubarray(data, MARKER_TIKTIKRAW) >= 0 ||
    indexOfSubarray(data, MARKER_TIKTIKTSGZ) >= 0
  );
}

/**
 * Unwraps an obfuscated or disguised chunk into valid MPEG-TS packets.
 * Returns the unwrapped MPEG-TS buffer, or the original data if not obfuscated.
 */
export function unwrapChunk(data: Uint8Array): Uint8Array {
  if (!needsUnwrap(data)) {
    return data;
  }

  try {
    // 1. Try WebP container
    if (isWebP(data)) {
      const webpTs = unwrapWebP(data);
      if (webpTs) return webpTs;
    }

    // 2. Try PNG container
    if (isPng(data)) {
      // 2a. Raw TS in PNG chunks (e.g. IDAT or eXIf containing raw TS)
      const pngChunkTs = unwrapPngChunks(data);
      if (pngChunkTs) return pngChunkTs;

      // 2b. PNG iTXt compressed text chunks (Matchora / Base64-encoded TS)
      const pngITXtTs = unwrapPngITXt(data);
      if (pngITXtTs) return pngITXtTs;

      // 2c. PNG IDAT pixel steganography (TIKTIKPX)
      const pngPxTs = extractTikTikPx(data);
      if (pngPxTs) return pngPxTs;
    }

    // 3. Raw marker search (TIKTIKRAW)
    const rawIdx = indexOfSubarray(data, MARKER_TIKTIKRAW);
    if (rawIdx >= 0) {
      const payload = data.subarray(rawIdx + MARKER_TIKTIKRAW.length);
      if (isMpegTsStream(payload, 0)) {
        return trimToTsPackets(payload);
      }
    }

    // 4. Gzip marker search (TIKTIKTSGZ)
    const gzIdx = indexOfSubarray(data, MARKER_TIKTIKTSGZ);
    if (gzIdx >= 0) {
      const payload = data.subarray(gzIdx + MARKER_TIKTIKTSGZ.length);
      try {
        const decompressed = zlib.gunzipSync(payload);
        if (isMpegTsStream(decompressed, 0)) {
          return trimToTsPackets(decompressed);
        }
      } catch (_) {}
    }

    // 5. Scan for MPEG-TS sync byte repeating at 188-byte intervals
    for (let i = 0; i + TS_PACKET_SIZE <= data.length; i++) {
      if (isMpegTsStream(data, i)) {
        return trimToTsPackets(data.subarray(i));
      }
    }
  } catch (_) {
    // If unwrapping fails for any reason, return the original data safely
  }

  return data;
}
