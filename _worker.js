// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 Minutes Cache

// Global memory cache for provider M3U content
const providerCaches = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerDomain = url.origin;

    // 1. Optional API Key check (if env.API_KEY is defined)
    const authError = verifyApiKey(url, env);
    if (authError) {
      return authError;
    }

    const apiKeyParam = env.API_KEY && env.API_KEY.trim() !== "" ? `&key=${encodeURIComponent(env.API_KEY)}` : "";

    // 2. Build provider list from environment variables (env.P1, env.P2, env.P3...)
    const providers = buildProvidersFromEnv(env);

    if (providers.length === 0) {
      return new Response("Error: No provider environment variables (P1, P2, etc.) configured.", { status: 500 });
    }

    // ==========================================
    // ROUTE 1: Split Playlist by Provider (/playlist_p1.m3u)
    // ==========================================
    const splitMatch = url.pathname.match(/^\/playlist_([a-zA-Z0-9]+)\.m3u$/);

    if (splitMatch) {
      const requestedPrefix = splitMatch[1].toLowerCase();
      const targetProvider = providers.find(p => p.prefix === requestedPrefix);

      if (!targetProvider) {
        return new Response(`Error: Provider playlist '${requestedPrefix}' not found.`, { status: 404 });
      }

      try {
        const singlePlaylist = await buildSingleProviderPlaylist(workerDomain, targetProvider, apiKeyParam, env);

        return new Response(singlePlaylist, {
          headers: {
            "Content-Type": "audio/x-mpegurl",
            "Content-Disposition": `inline; filename="playlist_${requestedPrefix}.m3u"`,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
          }
        });
      } catch (err) {
        return new Response(`Worker Error: ${err.message}`, { status: 500 });
      }
    }

    // ==========================================
    // ROUTE 2: /playlist.m3u (Merged All-in-One Playlist)
    // ==========================================
    if (url.pathname === "/playlist.m3u") {
      try {
        const mergedPlaylist = await buildNamespacedPlaylist(workerDomain, providers, apiKeyParam, env);

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
    // ROUTE 3: /live/stream?id=p1_101.m3u8 (Stream Proxy)
    // ==========================================
    if (url.pathname === "/live/stream") {
      const rawStreamId = url.searchParams.get("id");

      if (!rawStreamId) {
        return new Response("Error: Missing 'id' parameter.", { status: 400 });
      }

      const cleanId = sanitizeStreamId(rawStreamId);
      const { prefix, targetId } = parseNamespacedId(cleanId);

      try {
        let targetStreamUrl = null;

        if (prefix) {
          targetStreamUrl = await findStreamInSpecificProvider(providers, prefix, targetId, env);
        } else {
          targetStreamUrl = await findStreamAcrossProviders(providers, targetId, env);
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

   // return new Response("Active!.", { status: 200 });
    return new Response(await nginx(), {
				headers: {
					'Content-Type': 'text/html; charset=UTF-8',
				},
			});
  }
};

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Validates API key if configured
 */
function verifyApiKey(url, env) {
  if (!env.API_KEY || env.API_KEY.trim() === "") {
    return null;
  }

  const clientKey = url.searchParams.get("key");

  if (!clientKey || clientKey !== env.API_KEY) {
    return new Response("401 Unauthorized: Invalid or missing API key.", {
      status: 401,
      headers: { "Content-Type": "text/plain" }
    });
  }

  return null;
}

/**
 * Builds array of providers from env.P1, env.P2, env.P3...
 */
function buildProvidersFromEnv(env) {
  const providers = [];

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
 * Fetches and caches M3U content, injecting GitHub Token headers for raw.githubusercontent.com
 */
async function getOrFetchProviderM3U(provider, env) {
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

  // If fetching from GitHub and GITHUB_TOKEN is available, attach Bearer token
  if (isGitHubUrl(provider.url) && env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "") {
    requestHeaders["Authorization"] = `Bearer ${env.GITHUB_TOKEN.trim()}`;
  }

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
 * Helper: Checks if URL targets GitHub raw content or API
 */
function isGitHubUrl(urlStr) {
  return urlStr.includes("githubusercontent.com") || urlStr.includes("github.com");
}

/**
 * Generates playlist for a SINGLE provider
 */
async function buildSingleProviderPlaylist(workerDomain, provider, apiKeyParam, env) {
  let linesOutput = ["#EXTM3U"];

  const rawM3u = await getOrFetchProviderM3U(provider, env);
  if (!rawM3u) return "#EXTM3U\n";

  const lines = rawM3u.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXTM3U")) continue;

    if (line.startsWith("http")) {
      const streamId = extractStreamId(line);
      if (streamId) {
        linesOutput.push(`${workerDomain}/live/stream?id=${provider.prefix}_${streamId}.m3u8${apiKeyParam}`);
      } else {
        linesOutput.push(line);
      }
    } else {
      linesOutput.push(line);
    }
  }

  return linesOutput.join("\n");
}

/**
 * Generates combined playlist for ALL providers
 */
async function buildNamespacedPlaylist(workerDomain, providers, apiKeyParam, env) {
  let combinedLines = ["#EXTM3U"];

  for (const provider of providers) {
    if (!provider.enabled) continue;

    const rawM3u = await getOrFetchProviderM3U(provider, env);
    if (!rawM3u) continue;

    const lines = rawM3u.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXTM3U")) continue;

      if (line.startsWith("http")) {
        const streamId = extractStreamId(line);
        if (streamId) {
          combinedLines.push(`${workerDomain}/live/stream?id=${provider.prefix}_${streamId}.m3u8${apiKeyParam}`);
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
 * Direct lookup for a stream within a specific provider
 */
async function findStreamInSpecificProvider(providers, prefix, streamId, env) {
  const provider = providers.find(p => p.prefix === prefix && p.enabled);
  if (!provider) return null;

  const m3uText = await getOrFetchProviderM3U(provider, env);
  if (!m3uText) return null;

  return parseM3UForId(m3uText, streamId);
}

/**
 * Fallback search across all providers
 */
async function findStreamAcrossProviders(providers, streamId, env) {
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const m3uText = await getOrFetchProviderM3U(provider, env);
    if (!m3uText) continue;

    const streamUrl = parseM3UForId(m3uText, streamId);
    if (streamUrl) return streamUrl;
  }
  return null;
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
