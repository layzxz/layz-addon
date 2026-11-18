import express from "express";
import crypto from "node:crypto";
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";
import { tracks } from "./catalogue.mjs";
import { searchTidalTracks } from "./tidal.mjs";

// ===== Pengaturan =====
const HOSTS = (process.env.ADDON_HOSTS || "localhost")
  .split(",")
  .map((h) => h.trim().toLowerCase());
const HOST = HOSTS[0];
const MEDIA_SECRET = process.env.MEDIA_SECRET;
const app = express();
const bitchord = createBitChordAuth({ hosts: HOSTS });

// ===== Manifest =====
const MANIFEST = {
  id: "dev.layz.addon",
  name: "Layz Addon",
  version: "1.1.0",
  resources: ["search", "stream"],
  bitchordAuth: true,
  allowDownloads: 0,
  settings: [
    {
      key: "quality",
      type: "select",
      options: [
        { label: "Hi-Res Lossless (24-bit)", value: "hires" },
        { label: "Dolby Atmos", value: "atmos" },
        { label: "Lossless (16-bit)", value: "lossless" },
        { label: "High · 320 kbps", value: "high" },
        { label: "Low · 128 kbps", value: "low" },
      ],
    },
  ],
};

const LADDER = ["hires", "atmos", "lossless", "high", "low"];

function pickRendition(track, quality, atmos) {
  let start = LADDER.indexOf(quality);
  if (start === -1) start = 0;
  const ladder = LADDER.slice(start).filter(
    (q) => !(q === "atmos" && atmos === "off"),
  );
  for (const q of ladder) if (track.renditions[q]) return track.renditions[q];
  for (const q of LADDER) if (track.renditions[q]) return track.renditions[q];
  return null;
}

function streamQualityOf(rendition) {
  return {
    format: rendition.codec,
    label: rendition.label,
    codec: rendition.codec,
    container: rendition.container,
    ...(rendition.sampleRate && { sampleRate: rendition.sampleRate }),
    ...(rendition.bitDepth && { bitDepth: rendition.bitDepth }),
    ...(rendition.bitrate && { bitrate: rendition.bitrate }),
  };
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchLocalTrack(tidalTrack) {
  const isrc = normalize(tidalTrack.isrc);
  if (isrc) {
    const byIsrc = tracks.find((track) => normalize(track.isrc) === isrc);
    if (byIsrc) return byIsrc;
  }
  const title = normalize(tidalTrack.title);
  const artist = normalize(tidalTrack.artist);
  return tracks.find((track) =>
    normalize(track.title) === title && normalize(track.artist) === artist
  ) || null;
}

// ===== URL media bertanda tangan =====
function signedMediaUrl(file, ttl = 1800) {
  if (!MEDIA_SECRET) throw new Error("MEDIA_SECRET belum diatur");
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = crypto
    .createHmac("sha256", MEDIA_SECRET)
    .update(`${file}.${exp}`)
    .digest("base64url");
  return `https://${HOST}/media/${encodeURIComponent(file)}?exp=${exp}&sig=${sig}`;
}

function mediaAllowed(file, exp, sig) {
  if (!MEDIA_SECRET || !/^\d+$/.test(String(exp)) || Number(exp) < Date.now() / 1000)
    return false;
  const want = crypto
    .createHmac("sha256", MEDIA_SECRET)
    .update(`${file}.${exp}`)
    .digest();
  const got = Buffer.from(String(sig ?? ""), "base64url");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ===== Route publik =====
app.get("/manifest.json", (req, res) => res.json(MANIFEST));

app.get("/media/:file", (req, res) => {
  const { file } = req.params;
  if (!mediaAllowed(file, req.query.exp, req.query.sig))
    return res.sendStatus(403);
  res.sendFile(file, { root: "./media" });
});

// ===== Semua route di bawah ini wajib lolos BitChord auth =====
app.use(bitchord.express());

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ tracks: [] });

  try {
    const tidalTracks = await searchTidalTracks(q);
    const results = tidalTracks.flatMap((tidalTrack) => {
      const localTrack = matchLocalTrack(tidalTrack);
      // Hanya tampilkan hasil yang memang punya audio untuk diputar oleh addon.
      if (!localTrack) return [];

      return [{
        id: localTrack.id,
        title: tidalTrack.title || localTrack.title,
        artist: tidalTrack.artist || localTrack.artist,
        album: tidalTrack.album || localTrack.album,
        duration: tidalTrack.duration ?? localTrack.duration,
        artworkURL: tidalTrack.artworkURL || localTrack.artworkURL,
        isrc: tidalTrack.isrc,
        tidalId: tidalTrack.tidalId,
        tidalQuality: tidalTrack.tidalQuality,
        ...(tidalTrack.tidalQuality?.audioQuality && { audioQuality: tidalTrack.tidalQuality.audioQuality }),
        ...(tidalTrack.tidalQuality?.format && { format: tidalTrack.tidalQuality.format }),
        ...(tidalTrack.tidalQuality?.bitDepth != null && { bitDepth: tidalTrack.tidalQuality.bitDepth }),
        ...(tidalTrack.tidalQuality?.sampleRate != null && { sampleRate: tidalTrack.tidalQuality.sampleRate }),
        streamQuality: Object.values(localTrack.renditions).map(streamQualityOf),
      }];
    });

    res.set("Cache-Control", "no-store").json({ tracks: results });
  } catch (error) {
    console.error("TIDAL search failed:", error.message);
    res.status(502).json({ error: "tidal_unavailable", message: "Tidak dapat mengambil katalog TIDAL saat ini." });
  }
});

app.get("/stream/:id", (req, res) => {
  const track = tracks.find((t) => t.id === req.params.id);
  if (!track) return res.sendStatus(404);

  const rendition = pickRendition(
    track,
    String(req.query.quality || "hires"),
    String(req.query.atmos || "auto"),
  );
  if (!rendition) return res.status(404).json({ error: "No rendition available" });

  res.set("Cache-Control", "no-store").json({
    url: signedMediaUrl(rendition.file),
    ...streamQualityOf(rendition),
    manifest: "none",
    encrypted: false,
  });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Layz Addon jalan di port 3000"),
);
