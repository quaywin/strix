import type { RawSubtitleCandidate, SubtitleTrack } from "./subtitles";

/**
 * Resolves a URI relative to baseUrl, preserving query parameters
 * (such as session or expiry tokens) from baseUrl if the resolved URI lacks query parameters.
 */
export function resolveUrlWithBaseParams(uri: string, baseUrl: string): string {
  const baseObj = new URL(baseUrl);
  const resolved = new URL(uri, baseUrl);

  if (!resolved.search && baseObj.search) {
    const isRelative =
      !uri.startsWith("http://") &&
      !uri.startsWith("https://") &&
      !uri.startsWith("//");
    const isSameHost = resolved.host === baseObj.host;
    if (isRelative || isSameHost) {
      resolved.search = baseObj.search;
    }
  }
  return resolved.toString();
}

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

    // Process tag lines that can contain URIs (e.g. #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-PART)
    if (
      trimmed.startsWith("#EXT-X-KEY:") ||
      trimmed.startsWith("#EXT-X-MAP:") ||
      trimmed.startsWith("#EXT-X-MEDIA:") ||
      trimmed.startsWith("#EXT-X-PART:") ||
      trimmed.startsWith("#EXT-X-PRELOAD-HINT:")
    ) {
      const rewrittenTag = trimmed.replace(
        /URI=["']([^"']+)["']/g,
        (match, uri) => {
          try {
            const absoluteUri = resolveUrlWithBaseParams(uri, baseUrl);
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
      const absoluteUrl = resolveUrlWithBaseParams(trimmed, baseUrl);
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

/**
 * Reads a single NAME/URI/... attribute out of an #EXT-X-MEDIA tag line.
 * Handles both quoted and unquoted values.
 */
function extMediaAttr(tagLine: string, name: string): string {
  const match = tagLine.match(new RegExp(`${name}=("([^"]*)"|([^,]*))`, "i"));
  return (match?.[2] ?? match?.[3] ?? "").trim();
}

/**
 * Extracts all #EXT-X-MEDIA:TYPE=SUBTITLES renditions from an HLS master
 * playlist body, resolving their URIs against the master URL (preserving
 * base query params such as session tokens). Zero network cost — the body
 * was already captured during the scrape.
 */
export function parseHlsSubtitleRenditions(
  masterBody: string,
  masterUrl: string,
): RawSubtitleCandidate[] {
  if (!masterBody || !masterBody.includes("#EXT-X-MEDIA")) return [];

  const candidates: RawSubtitleCandidate[] = [];
  for (const line of masterBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXT-X-MEDIA:")) continue;
    if (!/TYPE=SUBTITLES/i.test(trimmed)) continue;

    const uri = extMediaAttr(trimmed, "URI");
    if (!uri) continue;

    let absolute = uri;
    try {
      absolute = resolveUrlWithBaseParams(uri, masterUrl);
    } catch {}

    candidates.push({
      url: absolute,
      label: extMediaAttr(trimmed, "NAME") || undefined,
      language: extMediaAttr(trimmed, "LANGUAGE") || undefined,
      isDefault: /^YES$/i.test(extMediaAttr(trimmed, "DEFAULT")),
    });
  }
  return candidates;
}

/**
 * Builds or augments an RFC 8216 HLS Master Playlist combining a video stream with subtitle tracks.
 */
export function buildMasterPlaylistWithSubtitles(
  videoUrl: string,
  subtitles: SubtitleTrack[],
  options: {
    videoBody?: string;
    proxySegmentUrl?: (url: string) => string;
  } = {},
): string {
  const hasSubtitles = subtitles && subtitles.length > 0;
  const subMediaLines = hasSubtitles
    ? subtitles
        .map(
          (t) =>
            `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${t.label.replace(/"/g, "")}",DEFAULT=${t.default ? "YES" : "NO"},AUTOSELECT=YES,FORCED=NO,LANGUAGE="${t.language}",URI="${t.proxyUrl}&playlist=1"`,
        )
        .join("\n")
    : "";

  const isExistingMaster = Boolean(
    options.videoBody && options.videoBody.includes("#EXT-X-STREAM-INF:"),
  );

  if (isExistingMaster && options.videoBody) {
    const lines = options.videoBody.split(/\r?\n/);
    const resultLines: string[] = [];
    let insertedSubs = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const trimmed = line.trim();

      if (!trimmed) {
        resultLines.push(line);
        continue;
      }

      // Insert subtitle media lines after header/version tags
      if (
        !insertedSubs &&
        hasSubtitles &&
        !trimmed.startsWith("#EXTM3U") &&
        !trimmed.startsWith("#EXT-X-VERSION")
      ) {
        resultLines.push(subMediaLines);
        insertedSubs = true;
      }

      // Augment variant lines with SUBTITLES="subs"
      if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
        let streamInf = trimmed;
        if (hasSubtitles) {
          if (/SUBTITLES=["'][^"']*["']/i.test(streamInf)) {
            streamInf = streamInf.replace(
              /SUBTITLES=["'][^"']*["']/i,
              'SUBTITLES="subs"',
            );
          } else {
            streamInf = `${streamInf},SUBTITLES="subs"`;
          }
        }
        resultLines.push(streamInf);
        continue;
      }

      // Handle variant URI lines
      if (!trimmed.startsWith("#")) {
        try {
          const absoluteUrl = resolveUrlWithBaseParams(trimmed, videoUrl);
          const finalUrl = options.proxySegmentUrl
            ? options.proxySegmentUrl(absoluteUrl)
            : absoluteUrl;
          resultLines.push(finalUrl);
        } catch {
          resultLines.push(line);
        }
        continue;
      }

      // Upstream subtitle rendition tags: make their URI absolute so the
      // browser resolves them against the CDN, not against our origin.
      // Deliberately NOT wrapped in /proxy-sub — that endpoint returns a
      // converted WebVTT file, which would corrupt a rendition *playlist*.
      if (trimmed.startsWith("#EXT-X-MEDIA:") && /TYPE=SUBTITLES/i.test(trimmed)) {
        const uri = extMediaAttr(trimmed, "URI");
        if (uri) {
          try {
            const absoluteUri = resolveUrlWithBaseParams(uri, videoUrl);
            resultLines.push(trimmed.replace(/URI="([^"]+)"/i, `URI="${absoluteUri}"`));
            continue;
          } catch {}
        }
      }

      resultLines.push(line);
    }

    if (!insertedSubs && hasSubtitles) {
      resultLines.push(subMediaLines);
    }

    return resultLines.join("\n");
  }

  // Fallback / Media Playlist / Direct Video: synthesize a clean Master Playlist
  const finalVideoUrl = options.proxySegmentUrl
    ? options.proxySegmentUrl(videoUrl)
    : videoUrl;

  const streamInfLine = hasSubtitles
    ? '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="subs"'
    : "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080";

  const playlistParts = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];

  if (hasSubtitles) {
    playlistParts.push(subMediaLines);
  }

  playlistParts.push(streamInfLine);
  playlistParts.push(finalVideoUrl);

  return playlistParts.join("\n");
}

