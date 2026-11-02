import { logger } from "../logger";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Resolves the public origin of the incoming request, taking into account
 * reverse proxy headers (e.g. Nginx, Cloudflare, Traefik) and optional PUBLIC_URL override.
 */
export function getRequestOrigin(request: Request): string {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL.replace(/\/+$/, "");
  }
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = request.headers.get("host")?.split(",")[0]?.trim();

  const targetHost = forwardedHost || host;
  if (targetHost) {
    const proto =
      forwardedProto ||
      (targetHost.includes("localhost") || targetHost.includes("127.0.0.1")
        ? "http"
        : "https");
    return `${proto}://${targetHost}`;
  }
  return new URL(request.url).origin;
}

/**
 * Case-insensitive lookup for headers stored in a Record<string, string>.
 */
export function getHeader(
  headers?: Record<string, string>,
  name?: string,
): string | undefined {
  if (!headers || !name) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

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
      headers[key.toLowerCase()] = value;
    });
  } else if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      headers[key.toLowerCase()] = value;
    }
  }

  // Ensure default browser user-agent is present so upstream CDNs don't reject Bun/curl
  if (!headers["user-agent"]) {
    headers["user-agent"] = DEFAULT_USER_AGENT;
  }

  const isM3u8 = url.toLowerCase().includes(".m3u8");
  if (isM3u8) {
    // For HLS playlists, force uncompressed response and strip Range headers.
    // Upstream CDNs often return HTTP 206 Partial Content with gzip compression when
    // Range is sent for .m3u8 playlists, causing Bun's zlib to fail with
    // 'Decompression error: ZlibError'.
    headers["accept-encoding"] = "identity";
    delete headers["range"];
  } else if (options.range) {
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
