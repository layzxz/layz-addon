import express from "express";
import crypto from "node:crypto";
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";
import { tracks } from "./catalogue.mjs";

// ===== Pengaturan =====
const HOSTS = (process.env.ADDON_HOSTS || "localhost")
  .split(",")
  .map((h) => h.trim().toLowerCase());
const HOST = HOSTS[0];
const MEDIA_SECRET = process.env.MEDIA_SECRET;
const app = express();
const bitchord = createBitChordAuth({ hosts: HOSTS });

// ===== Manifest (DI SINI tempatnya) =====
const MANIFEST = {
  id: "dev.layz.addon",
  name: "Layz Addon",
  version: "1.0.0",
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

// ===== Logika pemilihan kualitas =====
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

function bestTier(track) {
  const r = track.renditions;
  if (r.hires || r.lossless)
    return { format: "flac", audioQuality: "LOSSLESS" };
  if (r.high) return { format: r.high.codec, audioQuality: "HIGH" };
  return { format: "aac", audioQuality: "LOW" };
}

// ===== URL media bertanda tangan (kedaluwarsa 30 menit) =====
function signedMediaUrl(file, ttl = 1800) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = crypto
    .createHmac("sha256", MEDIA_SECRET)
    .update(`${file}.${exp}`)
    .digest("base64url");
  return `https://${HOST}/media/${encodeURIComponent(file)}?exp=${exp}&sig=${sig}`;
}

function mediaAllowed(file, exp, sig) {
  if (!/^\d+$/.test(String(exp)) || Number(exp) < Date.now() / 1000)
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

app.get("/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  const results = tracks
    .filter((t) =>
      [t.title, t.artist, t.album].join(" ").toLowerCase().includes(q),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration,
      artworkURL: t.artworkURL,
      ...bestTier(t),
    }));
  res.set("Cache-Control", "no-store").json({ tracks: results });
});

app.get("/stream/:id", (req, res) => {
  const track = tracks.find((t) => t.id === req.params.id);
  if (!track) return res.sendStatus(404);

  const r = pickRendition(
    track,
    String(req.query.quality || "hires"),
    String(req.query.atmos || "auto"),
  );
  if (!r) return res.status(404).json({ error: "No rendition available" });

  res.set("Cache-Control", "no-store").json({
    url: signedMediaUrl(r.file),
    format: r.codec,
    quality: r.label,
    codec: r.codec,
    container: r.container,
    manifest: "none",
    encrypted: false,
    ...(r.sampleRate && { sampleRate: r.sampleRate }),
    ...(r.bitDepth && { bitDepth: r.bitDepth }),
    ...(r.bitrate && { bitrate: r.bitrate }),
  });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Layz Addon jalan di port 3000"),
);
