export interface ExtractedStream {
  url: string;
  headers?: Record<string, string>;
}

export class StrmFreeExtractor {
  /**
   * Check if the given URL is supported by this extractor.
   */
  static canHandle(url: string): boolean {
    return /strmfree\.(st|top|link|shop|me)\/embed\//i.test(url);
  }

  /**
   * Extract m3u8 stream URL directly via HTTP without launching a browser.
   */
  static async extract(embedUrl: string): Promise<ExtractedStream> {
    const parsedUrl = new URL(embedUrl);
    const origin = parsedUrl.origin;

    const userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    // 1. Fetch embed page HTML
    const pageRes = await fetch(embedUrl, {
      headers: {
        "User-Agent": userAgent,
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!pageRes.ok) {
      throw new Error(`Failed to load strmfree embed: HTTP ${pageRes.status}`);
    }

    const html = await pageRes.text();

    // 2. Extract tokens dictionary (_0x)
    const tokenMatch = html.match(/const\s+_0x\s*=\s*(\{.+?\});/s);
    if (!tokenMatch || !tokenMatch[1]) {
      throw new Error("Failed to extract _0x token dictionary from strmfree page");
    }

    let tokens: Record<string, { _e: number; _n: string; _t: string }>;
    try {
      tokens = JSON.parse(tokenMatch[1]);
    } catch (err) {
      throw new Error(
        `Invalid JSON in strmfree tokens: ${(err as Error).message}`,
      );
    }

    // 3. Extract quality, slug, variant
    const qualityMatch = html.match(/const\s+QUALITY\s*=\s*['"]([^'"]+)['"]/);
    const quality = qualityMatch?.[1] || "1080p";

    const suffixMatch = html.match(
      /const\s+SOURCE_SUFFIX\s*=\s*['"]([^'"]*)['"]/,
    );
    const sourceSuffix = suffixMatch?.[1] || "";

    const slugMatch = html.match(/\/get-stream-key\/([a-zA-Z0-9_\-]+)/);
    if (!slugMatch || !slugMatch[1]) {
      throw new Error("Failed to extract stream key slug from strmfree page");
    }
    const slug = slugMatch[1];

    let variant = `${slug}${quality}${sourceSuffix}`;
    const directVariantMatch = html.match(
      /const\s+VARIANT\s*=\s*['"]([a-zA-Z0-9_\-]+)['"];/,
    );
    if (directVariantMatch && directVariantMatch[1]) {
      variant = directVariantMatch[1];
    }

    // 4. Query stream key API
    const keyEndpoint = `${origin}/get-stream-key/${slug}`;
    const keyRes = await fetch(keyEndpoint, {
      headers: {
        "User-Agent": userAgent,
        "Referer": embedUrl,
        "Accept": "application/json, text/plain, */*",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!keyRes.ok) {
      throw new Error(`Failed to query stream key: HTTP ${keyRes.status}`);
    }

    const keyData = (await keyRes.json()) as {
      server_name?: string;
      server_domain?: string;
      is_external?: boolean;
      external_url?: string;
    };

    if (keyData.is_external && keyData.external_url) {
      return { url: keyData.external_url };
    }

    // 5. Build base path & token parameters
    const serverName = keyData.server_name || "origin";
    let basePath: string;
    if (serverName === "externalcdn") {
      basePath = `/live-externalcdn/${variant}/index.m3u8`;
    } else if (serverName !== "origin") {
      basePath = `/live-cdn/${variant}/index.m3u8`;
    } else {
      basePath = `/live/${variant}/index.m3u8`;
    }

    const p = tokens[quality] || Object.values(tokens)[0];
    let streamUrl = `${origin}${basePath}`;
    if (p) {
      streamUrl += `?_t=${p._t}&_e=${p._e}&_n=${p._n}`;
    }

    return {
      url: streamUrl,
      headers: {
        Referer: embedUrl,
        "User-Agent": userAgent,
      },
    };
  }
}
