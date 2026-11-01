/**
 * Rewrites relative URIs in an HLS M3U8 playlist to absolute URLs,
 * and optionally wraps them in a proxy URL handler.
 */
export function rewriteM3u8Playlist(
  content: string,
  baseUrl: string,
  options: {
    proxySegmentUrl?: (absoluteUrl: string) => string;
  } = {},
): string {
  const lines = content.split(/\r?\n/);
  const resultLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    if (!trimmed) {
      resultLines.push(line);
      continue;
    }

    // Process tag lines that can contain URIs (e.g. #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA)
    if (
      trimmed.startsWith("#EXT-X-KEY:") ||
      trimmed.startsWith("#EXT-X-MAP:") ||
      trimmed.startsWith("#EXT-X-MEDIA:")
    ) {
      const rewrittenTag = trimmed.replace(
        /URI=["']([^"']+)["']/g,
        (match, uri) => {
          try {
            const absoluteUri = new URL(uri, baseUrl).toString();
            const finalUri = options.proxySegmentUrl
              ? options.proxySegmentUrl(absoluteUri)
              : absoluteUri;
            return `URI="${finalUri}"`;
          } catch {
            return match;
          }
        },
      );
      resultLines.push(rewrittenTag);
      continue;
    }

    // Pass through all other comments / tags untouched
    if (trimmed.startsWith("#")) {
      resultLines.push(line);
      continue;
    }

    // This is a media segment or variant playlist line
    try {
      const absoluteUrl = new URL(trimmed, baseUrl).toString();
      const finalUrl = options.proxySegmentUrl
        ? options.proxySegmentUrl(absoluteUrl)
        : absoluteUrl;
      resultLines.push(finalUrl);
    } catch {
      // If parsing fails for any reason, keep original line
      resultLines.push(line);
    }
  }

  return resultLines.join("\n");
}
