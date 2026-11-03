import type { ExtractedStream } from "./StrmFreeExtractor";

export class PitSportExtractor {
  /**
   * Checks if the given URL is a pitsport program play URL.
   * e.g. https://pitsport.st/programs/102395/play
   */
  static canHandle(url: string): boolean {
    return /pitsport\.(st|live|xyz|top|me)\/programs\/\d+/i.test(url);
  }

  /**
   * Extracts the underlying embed or stream URL directly via PitSport's SvelteKit JSON API.
   * Eliminates the need to load the pitsport SPA bundle in Chromium.
   */
  static async extract(targetUrl: string): Promise<ExtractedStream | null> {
    const match = targetUrl.match(/\/programs\/(\d+)/i);
    if (!match || !match[1]) {
      return null;
    }

    const programId = match[1];
    const parsed = new URL(targetUrl);
    const origin = parsed.origin;
    const apiUrl = `${origin}/api/v1/programs/${programId}/play`;

    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Referer": targetUrl,
        "Origin": origin,
        "Accept": "application/json, text/plain, */*",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      throw new Error(`PitSport API returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as any;
    const embedUrl = json?.data?.video?.embedUrl;

    if (!embedUrl) {
      throw new Error("No video embedUrl found in PitSport API response");
    }

    return {
      url: embedUrl,
      headers: {
        Referer: `${origin}/`,
        Origin: origin,
      },
    };
  }
}
