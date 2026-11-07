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
 * Builds a /proxy-chunk URL whose PATH carries a cosmetic media extension.
 * Upstreams disguise segments as .xml/.js/.txt (and the disguise often IS
 * the real extension now), but strict HLS clients — ffmpeg/libmpv-based
 * players enforce an allowed_extensions list — refuse to load a segment
 * whose URL ends in a non-media extension even when the bytes are valid
 * fMP4/TS. The filename itself is ignored by the /proxy-chunk/:filename
 * handler; only the extension matters. .m4s is missing from older ffmpeg
 * allowlists, so everything non-.ts is normalized to .mp4.
 */
/**
 * Flattens a nested master chain (master → variant master → media playlist,
 * as served by the oneroom/megacloud families) into a single-level master
 * whose variant URIs point directly at the final media playlists. VLC's
 * adaptive demuxer — unlike ffmpeg/lavf and hls.js — does not re-parse a
 * representation that turns out to be another master playlist: it finds no
 * segments and stalls forever ("Waiting sync reference"). Promotes any
 * EXT-X-MEDIA AUDIO renditions declared at the inner level to the top.
 *
 * `getVariantBody` supplies the (harvest-cached) body of a variant URL.
 * Returns a plain master text, or null when the input isn't a nested master
 * (caller keeps its existing behavior).
 */
export function flattenMasterChain(
  body: string,
  baseUrl: string,
  getVariantBody: (url: string) => string | undefined,
): string | null {
  if (!body.includes("#EXT-X-STREAM-INF")) return null;

  const out: string[] = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const audioLines = new Set<string>();
  const entries: string[] = [];
  let pendingInf: string | null = null;
  let flattenedAny = false;

  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/i.test(t)) {
      audioLines.add(t);
      continue;
    }
    if (t.startsWith("#EXT-X-STREAM-INF:")) {
      pendingInf = t;
      continue;
    }
    if (t.startsWith("#") || !t) continue;

    let resolved: string;
    try {
      resolved = resolveUrlWithBaseParams(t, baseUrl);
    } catch {
      return null;
    }

    const child = getVariantBody(resolved);
    if (child && child.includes("#EXT-X-STREAM-INF")) {
      // Nested variant master: splice its qualities up one level.
      let childInf: string | null = null;
      for (const l2 of child.split(/\r?\n/)) {
        const t2 = l2.trim();
        if (t2.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/i.test(t2)) {
          try {
            const uri2 = t2.match(/URI="([^"]+)"/i)?.[1];
            const abs2 = uri2
              ? resolveUrlWithBaseParams(uri2, resolved)
              : undefined;
            audioLines.add(
              abs2 ? t2.replace(/URI="[^"]+"/i, `URI="${abs2}"`) : t2,
            );
          } catch {
            audioLines.add(t2);
          }
          continue;
        }
        if (t2.startsWith("#EXT-X-STREAM-INF:")) {
          childInf = t2;
          continue;
        }
        if (t2.startsWith("#") || !t2) continue;
        let mediaUrl: string;
        try {
          mediaUrl = resolveUrlWithBaseParams(t2, resolved);
        } catch {
          continue;
        }
        entries.push(`${childInf ?? "#EXT-X-STREAM-INF:BANDWIDTH=2000000"}\n${mediaUrl}`);
        flattenedAny = true;
        childInf = null;
      }
    } else {
      // Variant is already a media playlist — keep the outer pairing.
      if (!pendingInf) return null;
      entries.push(`${pendingInf}\n${resolved}`);
    }
    pendingInf = null;
  }

  if (!flattenedAny || entries.length === 0) return null;
  for (const a of audioLines) out.push(a);
  for (const e of entries) out.push(e);
  return out.join("\n");
}

/**
 * Builds a /proxy-chunk URL whose PATH carries a cosmetic media extension.
 * Upstreams disguise segments as .xml/.js/.txt (and the disguise often IS
 * the real extension now), but strict HLS clients — ffmpeg/libmpv-based
 * players enforce an allowed_extensions list — refuse to load a segment
 * whose URL ends in a non-media extension even when the bytes are valid
 * fMP4/TS. The filename itself is ignored by the /proxy-chunk/:filename
 * handler; only the extension matters. .m4s is missing from older ffmpeg
 * allowlists, so everything non-.ts is normalized to .mp4.
 */
export function proxyChunkUrl(
  requestOrigin: string,
  targetUrl: string,
  query: string,
): string {
  // % also terminates the match: wrapped URLs (megacloud ts-proxy) carry the
  // real extension URL-encoded inside the query (…seg-1.ts%26headers=…), and
  // TS content should keep the .ts name rather than fall back to .mp4.
  // .m3u8 keeps nested-playlist children semantically named (ffmpeg's hls
  // demuxer re-parses those by content, and the extension is allowlisted).
  const m = targetUrl.match(/\.(ts|m4s|mp4|m3u8)(\?|%|$)/i);
  const raw = m?.[1]?.toLowerCase();
  const ext = raw === "ts" ? "ts" : raw === "m3u8" ? "m3u8" : "mp4";
  return `${requestOrigin}/proxy-chunk/segment.${ext}?${query}`;
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
      format: "m3u8",
      isRendition: true,
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
  const isExistingMaster = Boolean(
    options.videoBody && options.videoBody.includes("#EXT-X-STREAM-INF:"),
  );

  // Collect existing subtitle languages from upstream master
  const upstreamSubLangs = new Set<string>();
  if (isExistingMaster && options.videoBody) {
    for (const line of options.videoBody.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#EXT-X-MEDIA:") && /TYPE=SUBTITLES/i.test(trimmed)) {
        const lang = extMediaAttr(trimmed, "LANGUAGE").toLowerCase();
        if (lang) upstreamSubLangs.add(lang);
      }
    }
  }

  // Filter out injected subtitles whose languages are already provided by upstream master
  const effectiveSubs =
    isExistingMaster && upstreamSubLangs.size > 0
      ? subtitles.filter((t) => !upstreamSubLangs.has(t.language.toLowerCase()))
      : subtitles;

  const hasSubtitles = effectiveSubs && effectiveSubs.length > 0;
  const subMediaLines = hasSubtitles
    ? effectiveSubs
        .map(
          (t) =>
            `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${t.label.replace(/"/g, "")}",DEFAULT=${t.default ? "YES" : "NO"},AUTOSELECT=YES,FORCED=NO,LANGUAGE="${t.language}",URI="${t.proxyUrl}&playlist=1"`,
        )
        .join("\n")
    : "";

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

      // Header block: #EXTM3U, #EXT-X-VERSION, #EXT-X-INDEPENDENT-SEGMENTS.
      // RFC 8216 requires EXT-X-INDEPENDENT-SEGMENTS to precede every Master
      // Playlist Tag (EXT-X-MEDIA included), so subtitle lines must wait
      // until the whole header has passed.
      if (trimmed === "#EXTM3U" && !/^#EXT-X-VERSION/m.test(options.videoBody)) {
        resultLines.push(line);
        // fMP4/CODECS renditions need ≥6; 7 is safe for everything we emit.
        resultLines.push("#EXT-X-VERSION:7");
        continue;
      }
      const isHeaderTag =
        trimmed.startsWith("#EXTM3U") ||
        trimmed.startsWith("#EXT-X-VERSION") ||
        trimmed.startsWith("#EXT-X-INDEPENDENT-SEGMENTS");

      // Insert subtitle media lines after header/version tags
      if (
        !insertedSubs &&
        hasSubtitles &&
        !isHeaderTag
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

      // I-frame preview playlists: same treatment as variants so players
      // that support scrub previews fetch them through strix too.
      if (trimmed.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
        const uri = trimmed.match(/URI="([^"]+)"/i)?.[1];
        if (uri && options.proxySegmentUrl) {
          try {
            const absoluteUrl = resolveUrlWithBaseParams(uri, videoUrl);
            resultLines.push(
              trimmed.replace(/URI="([^"]+)"/i, `URI="${options.proxySegmentUrl(absoluteUrl)}"`),
            );
            continue;
          } catch {}
        }
        resultLines.push(line);
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

      // Upstream subtitle rendition playlists route through strix as well.
      // When external subtitles are injected into GROUP-ID="subs", align upstream subtitle
      // GROUP-ID to "subs" as well so both upstream and injected subtitles remain in the
      // same active rendition group referenced by EXT-X-STREAM-INF.
      if (trimmed.startsWith("#EXT-X-MEDIA:") && /TYPE=SUBTITLES/i.test(trimmed)) {
        let tag = trimmed;
        if (hasSubtitles) {
          tag = tag.replace(/GROUP-ID=["'][^"']*["']/i, 'GROUP-ID="subs"');
          if (effectiveSubs.some((t) => t.default)) {
            tag = tag.replace(/DEFAULT=YES/i, "DEFAULT=NO");
          }
        }
        const uri = extMediaAttr(tag, "URI");
        if (uri && options.proxySegmentUrl) {
          try {
            const wrappedUri = options.proxySegmentUrl(
              resolveUrlWithBaseParams(uri, videoUrl),
            );
            resultLines.push(tag.replace(/URI="([^"]+)"/i, `URI="${wrappedUri}"`));
            continue;
          } catch {}
        }
        resultLines.push(tag);
        continue;
      }

      // Upstream audio rendition playlists route through strix
      if (trimmed.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/i.test(trimmed)) {
        const uri = extMediaAttr(trimmed, "URI");
        if (uri && options.proxySegmentUrl) {
          try {
            const wrappedUri = options.proxySegmentUrl(
              resolveUrlWithBaseParams(uri, videoUrl),
            );
            resultLines.push(trimmed.replace(/URI="([^"]+)"/i, `URI="${wrappedUri}"`));
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

