const API_BASE = (process.env.TIDAL_API_BASE || "https://openapi.tidal.com/v2").replace(/\/$/, "");
const TOKEN_URL = process.env.TIDAL_TOKEN_URL || "https://auth.tidal.com/v1/oauth2/token";

let cachedToken = null;
let tokenExpiresAt = 0;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const clientId = requiredEnv("TIDAL_CLIENT_ID");
  const clientSecret = requiredEnv("TIDAL_CLIENT_SECRET");
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`TIDAL token request failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const token = await response.json();
  if (!token.access_token) throw new Error("TIDAL token response did not contain access_token");
  cachedToken = token.access_token;
  tokenExpiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  return cachedToken;
}

async function tidalGet(path) {
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.api+json",
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`TIDAL API request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

function parseDuration(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value));
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return undefined;
  return Math.round(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
}

function relationshipResource(resource, name, included) {
  const linkage = resource.relationships?.[name]?.data;
  const first = Array.isArray(linkage) ? linkage[0] : linkage;
  if (!first) return null;
  return included.find((item) => item.type === first.type && item.id === first.id) || null;
}

function artworkUrl(artwork) {
  const files = artwork?.attributes?.files;
  if (!Array.isArray(files) || !files.length) return undefined;
  const file = files.find((item) => item.width >= 300) || files[0];
  return file.href || file.url;
}

function qualityFrom(track) {
  const attrs = track.attributes || {};
  const metadata = attrs.mediaMetadata || {};
  const audioQuality = attrs.audioQuality || metadata.audioQuality || null;
  const bitDepth = attrs.bitDepth ?? metadata.bitDepth ?? null;
  const sampleRate = attrs.sampleRate ?? metadata.sampleRate ?? null;
  const format = attrs.format || metadata.format || null;

  if (!audioQuality && bitDepth == null && sampleRate == null && !format) return null;
  return {
    ...(audioQuality && { audioQuality }),
    ...(bitDepth != null && { bitDepth }),
    ...(sampleRate != null && { sampleRate }),
    ...(format && { format }),
  };
}

export async function searchTidalTracks(query, {
  countryCode = process.env.TIDAL_COUNTRY_CODE || "ID",
  limit = 25,
} = {}) {
  // Search is a collection endpoint: query is a query parameter, not a resource ID.
  // JSON:API include paths bring back track, artist, album and cover-art metadata.
  const params = new URLSearchParams({
    query,
    countryCode,
    "page[limit]": String(Math.min(Math.max(Number(limit) || 25, 1), 50)),
    include: "tracks,tracks.artists,tracks.albums,tracks.albums.coverArt",
  });
  const payload = await tidalGet(`/searchResults?${params.toString()}`);
  const included = payload.included || [];
  const searchResult = (payload.data || []).find((item) => item.type === "searchResults")
    || payload.data?.[0];
  if (!searchResult) return [];

  const linkedTracks = searchResult.relationships?.tracks?.data || [];
  const trackIds = new Set(linkedTracks.map((item) => String(item.id)));
  const tracks = included.filter((item) =>
    item.type === "tracks" && trackIds.has(String(item.id))
  );

  return tracks.slice(0, limit).map((track) => {
    const attrs = track.attributes || {};
    const album = relationshipResource(track, "albums", included);
    const artist = relationshipResource(track, "artists", included);
    const cover = album && relationshipResource(album, "coverArt", included);

    return {
      tidalId: String(track.id),
      isrc: attrs.isrc || null,
      title: attrs.title || "",
      artist: artist?.attributes?.name || attrs.artistName || attrs.artists?.[0]?.name || "",
      album: album?.attributes?.title || attrs.albumTitle || "",
      duration: parseDuration(attrs.duration),
      artworkURL: artworkUrl(cover) || attrs.coverUrl || attrs.artworkUrl || null,
      tidalQuality: qualityFrom(track),
    };
  }).filter((track) => track.title);
}
