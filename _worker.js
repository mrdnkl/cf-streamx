// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 Minutes

// Global memory cache
const providerCaches = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerDomain = url.origin;

    // 1. Build dynamic providers array from environment variables (env.P1, env.P2, env.P3)
    const providers = buildProvidersFromEnv(env);

    if (providers.length === 0) {
      return new Response("Error: No provider environment variables (P1, P2, etc.) are configured.", { status: 500 });
    }

    // ==========================================
    // ROUTE 1: /playlist.m3u (Namespaced Playlist)
    // ==========================================
    if (url.pathname === "/playlist.m3u") {
      try {
        const mergedPlaylist = await buildNamespacedPlaylist(workerDomain, providers);

        return new Response(mergedPlaylist, {
          headers: {
            "Content-Type": "audio/x-mpegurl",
            "Content-Disposition": 'inline; filename="playlist.m3u"',
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          }
        });
      } catch (err) {
        return new Response(`Worker Error: ${err.message}`, { status: 500 });
      }
    }

    // ==========================================
    // ROUTE 2: /live/stream.m3u8?id=p1_101.m3u8
    // ==========================================
    if (url.pathname === "/live/stream.m3u8") {
      const rawStreamId = url.searchParams.get("id");

      if (!rawStreamId) {
        return new Response("Error: Missing 'id' parameter.", { status: 400 });
      }

      const cleanId = sanitizeStreamId(rawStreamId);
      const { prefix, targetId } = parseNamespacedId(cleanId);

      try {
        let targetStreamUrl = null;

        if (prefix) {
          targetStreamUrl = await findStreamInSpecificProvider(providers, prefix, targetId);
        } else {
          targetStreamUrl = await findStreamAcrossProviders(providers, targetId);
        }

        if (!targetStreamUrl) {
          return new Response(`Error: Stream ID '${targetId}' not found.`, { status: 404 });
        }

        const formattedUrl = convertToM3U8Url(targetStreamUrl);

        const m3u8Content = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-STREAM-INF:PROGRAM-ID=1,AVERAGE-BANDWIDTH=2200000,BANDWIDTH=2200000",
          formattedUrl
        ].join("\n");

        return new Response(m3u8Content, {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          }
        });

      } catch (err) {
        return new Response(`Worker Error: ${err.message}`, { status: 500 });
      }
    }

    return new Response("M3U8 Worker with Environment Variable configuration active.", { status: 200 });
  }
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Reads env object and dynamically extracts env.P1, env.P2, env.P3...
 */
function buildProvidersFromEnv(env) {
  const providers = [];

  // Loop through common provider keys (P1 to P10)
  for (let i = 1; i <= 10; i++) {
    const key = `P${i}`;
    const url = env[key];

    if (url && typeof url === "string" && url.trim().length > 0) {
      providers.push({
        prefix: `p${i}`,
        name: `Provider_${i}`,
        url: url.trim(),
        enabled: true,
        headers: { "User-Agent": DEFAULT_USER_AGENT }
      });
    }
  }

  return providers;
}

/**
 * Strips file extension suffixes
 */
function sanitizeStreamId(idParam) {
  return idParam.replace(/\.(m3u8|ts|mpd|m3u)$/i, "");
}

/**
 * Splits namespaced ID string into prefix and raw ID
 */
function parseNamespacedId(fullId) {
  const match = fullId.match(/^([a-zA-Z0-9]+)_(.+)$/);
  if (match) {
    return { prefix: match[1], targetId: match[2] };
  }
  return { prefix: null, targetId: fullId };
}

/**
 * Direct lookup for a stream within a specific provider using its prefix
 */
async function findStreamInSpecificProvider(providers, prefix, streamId) {
  const provider = providers.find(p => p.prefix === prefix && p.enabled);
  if (!provider) return null;

  const m3uText = await getOrFetchProviderM3U(provider);
  if (!m3uText) return null;

  return parseM3UForId(m3uText, streamId);
}

/**
 * Fallback search across all providers
 */
async function findStreamAcrossProviders(providers, streamId) {
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const m3uText = await getOrFetchProviderM3U(provider);
    if (!m3uText) continue;

    const streamUrl = parseM3UForId(m3uText, streamId);
    if (streamUrl) return streamUrl;
  }
  return null;
}

/**
 * Generates combined playlist with prefixed stream URLs
 */
async function buildNamespacedPlaylist(workerDomain, providers) {
  let combinedLines = ["#EXTM3U"];

  for (const provider of providers) {
    if (!provider.enabled) continue;

    const rawM3u = await getOrFetchProviderM3U(provider);
    if (!rawM3u) continue;

    const lines = rawM3u.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXTM3U")) continue;

      if (line.startsWith("http")) {
        const streamId = extractStreamId(line);
        if (streamId) {
          combinedLines.push(`${workerDomain}/live/stream.m3u8?id=${provider.prefix}_${streamId}.m3u8`);
        } else {
          combinedLines.push(line);
        }
      } else {
        combinedLines.push(line);
      }
    }
  }

  return combinedLines.join("\n");
}

/**
 * In-memory provider caching
 */
async function getOrFetchProviderM3U(provider) {
  const now = Date.now();
  const cacheKey = provider.name;

  if (!providerCaches[cacheKey]) {
    providerCaches[cacheKey] = { content: null, lastFetch: 0 };
  }

  const cache = providerCaches[cacheKey];

  if (cache.content && (now - cache.lastFetch < CACHE_TTL_MS)) {
    return cache.content;
  }

  const requestHeaders = {
    "User-Agent": DEFAULT_USER_AGENT,
    ...(provider.headers || {})
  };

  const response = await fetch(provider.url, { method: "GET", headers: requestHeaders });

  if (!response.ok) {
    if (cache.content) return cache.content;
    return null;
  }

  cache.content = await response.text();
  cache.lastFetch = now;
  return cache.content;
}

/**
 * Extracts raw stream ID from provider link
 */
function extractStreamId(streamUrl) {
  try {
    const parsed = new URL(streamUrl);

    if (parsed.searchParams.has("stream")) return sanitizeStreamId(parsed.searchParams.get("stream"));
    if (parsed.searchParams.has("id")) return sanitizeStreamId(parsed.searchParams.get("id"));

    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (pathSegments.length === 0) return null;

    const lastSegment = pathSegments[pathSegments.length - 1];

    if (lastSegment.toLowerCase().startsWith("index")) {
      const parentFolder = pathSegments[pathSegments.length - 2];
      return parentFolder ? sanitizeStreamId(parentFolder) : null;
    }

    const match = lastSegment.match(/([a-zA-Z0-9_-]+)(?:\.(m3u8|ts|mpd|m3u))?$/i);
    return match ? sanitizeStreamId(match[1]) : null;

  } catch (e) {
    return null;
  }
}

/**
 * Finds stream matching raw ID in playlist content
 */
function parseM3UForId(m3uContent, streamId) {
  const lines = m3uContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("http")) {
      const lineId = extractStreamId(line);
      if (lineId && lineId === streamId) {
        return line;
      }
    }
  }

  return null;
}

/**
 * Rewrites extension parameter to m3u8
 */
function convertToM3U8Url(rawUrl) {
  try {
    const parsedUrl = new URL(rawUrl);

    if (parsedUrl.searchParams.has("extension")) {
      parsedUrl.searchParams.set("extension", "m3u8");
    }

    let updatedUrl = parsedUrl.toString();

    if (parsedUrl.pathname.endsWith(".ts")) {
      updatedUrl = updatedUrl.replace(/\.ts(\?|$)/, ".m3u8$1");
    }

    return updatedUrl;
  } catch (e) {
    return rawUrl;
  }
}
