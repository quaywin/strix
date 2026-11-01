import { logger } from "../logger";

/**
 * Enhanced fetch helper that automatically falls back to system curl if
 * standard fetch gets blocked by upstream anti-bot/TLS-fingerprint systems
 * (e.g. Iron Dome / JA3 checks returning 403 on Bun/Node TLS ClientHello).
 */
export async function smartFetch(
  url: string,
  options: {
    headers?: Record<string, string> | Headers;
    signal?: AbortSignal;
    range?: string | null;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.headers instanceof Headers) {
    options.headers.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (options.headers) {
    Object.assign(headers, options.headers);
  }

  if (options.range) {
    headers["range"] = options.range;
  }

  try {
    const res = await fetch(url, {
      headers,
      signal: options.signal,
    });
    // If upstream returns 2xx or 3xx, return immediately
    if (res.ok || (res.status >= 300 && res.status < 400)) {
      return res;
    }
    // If upstream returned something other than 403 / 502, don't fallback to curl
    if (res.status !== 403 && res.status !== 502) {
      return res;
    }
  } catch (e) {
    if (options.signal?.aborted) {
      throw e;
    }
  }

  // Fallback: spawn curl which uses native OS TLS stack (passes JA3/Iron Dome checks)
  try {
    const args = ["curl", "-s", "-i", "-L", "--max-time", "30"];
    for (const [k, v] of Object.entries(headers)) {
      args.push("-H", `${k}: ${v}`);
    }
    args.push(url);

    const proc = Bun.spawn(args);

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          try {
            proc.kill();
          } catch (_) {}
        },
        { once: true },
      );
    }

    const rawBuffer = await new Response(proc.stdout).arrayBuffer();
    const rawUint8 = new Uint8Array(rawBuffer);

    // Parse HTTP response header and body boundaries from curl output.
    // When curl follows redirects (-L), it outputs multiple header blocks (e.g. 302 then 200).
    // We iterate through them to extract the final response headers and final body.
    let offset = 0;
    let finalHeaderStart = 0;
    let finalHeaderEnd = -1;

    while (offset < rawUint8.length - 3) {
      let splitIdx = -1;
      for (let i = offset; i < rawUint8.length - 3; i++) {
        if (
          rawUint8[i] === 13 &&
          rawUint8[i + 1] === 10 &&
          rawUint8[i + 2] === 13 &&
          rawUint8[i + 3] === 10
        ) {
          splitIdx = i;
          break;
        }
      }
      if (splitIdx === -1) break;

      finalHeaderStart = offset;
      finalHeaderEnd = splitIdx;
      offset = splitIdx + 4;

      // Check if another header block follows (e.g. HTTP/1.1 or HTTP/2 redirect)
      const nextSlice = new TextDecoder().decode(
        rawUint8.subarray(offset, Math.min(offset + 10, rawUint8.length)),
      );
      if (!nextSlice.startsWith("HTTP/")) {
        break;
      }
    }

    if (finalHeaderEnd === -1) {
      return new Response("Upstream error via curl fallback", { status: 502 });
    }

    const headerText = new TextDecoder().decode(
      rawUint8.subarray(finalHeaderStart, finalHeaderEnd),
    );
    const bodyPart = rawUint8.subarray(finalHeaderEnd + 4);

    const headerLines = headerText.split("\r\n");
    const statusLine = headerLines[0] || "HTTP/1.1 200 OK";
    const statusCode = parseInt(statusLine.split(" ")[1] || "200", 10);

    const resHeaders = new Headers();
    for (let i = 1; i < headerLines.length; i++) {
      const line = headerLines[i];
      if (!line) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const k = line.slice(0, colonIdx).trim().toLowerCase();
        const v = line.slice(colonIdx + 1).trim();
        // Skip hop-by-hop headers
        if (
          k !== "connection" &&
          k !== "transfer-encoding" &&
          k !== "content-length"
        ) {
          resHeaders.set(k, v);
        }
      }
    }

    return new Response(bodyPart, {
      status: statusCode,
      headers: resHeaders,
    });
  } catch (err) {
    logger.error("Curl fallback failed", "HttpUtil", err);
    return new Response("Upstream fetch failed", { status: 502 });
  }
}
