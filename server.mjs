import express from "express";
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";
import { searchTidalTracks } from "./tidal.mjs";

// ===== Pengaturan =====
const HOSTS = (process.env.ADDON_HOSTS || "localhost")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

const app = express();
const bitchord = createBitChordAuth({ hosts: HOSTS });

// TIDAL dipakai sebagai katalog dan sumber metadata.
// Pemutaran audio TIDAL harus dilakukan melalui TIDAL Player SDK resmi;
// addon HTTP ini tidak mengekstrak atau mem-proxy stream TIDAL.
const MANIFEST = {
  id: "dev.layz.addon",
  name: "Layz Addon",
  version: "1.2.0",
  resources: ["search", "stream"],
  bitchordAuth: true,
  allowDownloads: 0,
  settings: [
    {
      key: "quality",
      type: "select",
      options: [
        { label: "Hi-Res Lossless", value: "hires" },
        { label: "Dolby Atmos", value: "atmos" },
        { label: "Lossless", value: "lossless" },
        { label: "High", value: "high" },
        { label: "Low", value: "low" },
      ],
    },
  ],
};

app.get("/manifest.json", (req, res) => res.json(MANIFEST));

// Semua route katalog dan stream wajib lolos autentikasi BitChord.
app.use(bitchord.express());

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ tracks: [] });

  try {
    const tidalTracks = await searchTidalTracks(query);
    const results = tidalTracks
      .filter((track) => track.tidalId != null)
      .map((track) => {
        const quality = track.tidalQuality || {};
        return {
          // ID yang dipakai BitChord adalah ID track asli dari TIDAL.
          id: String(track.tidalId),
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          artworkURL: track.artworkURL,
          isrc: track.isrc,
          tidalId: String(track.tidalId),
          ...(quality.audioQuality && { audioQuality: quality.audioQuality }),
          ...(quality.format && { format: quality.format }),
          ...(quality.bitDepth != null && { bitDepth: quality.bitDepth }),
          ...(quality.sampleRate != null && { sampleRate: quality.sampleRate }),
          tidalQuality: quality,
        };
      });

    res.set("Cache-Control", "no-store").json({ tracks: results });
  } catch (error) {
    console.error("TIDAL search failed:", error.message);
    res.status(502).json({
      error: "tidal_unavailable",
      message: "Tidak dapat mengambil katalog TIDAL saat ini.",
    });
  }
});

// TIDAL Track ID bukan URL audio. Jangan mengarang URL stream atau
// mengambil manifest terlindungi. BitChord dapat menangani 404 sebagai
// kegagalan sumber ini; pemutaran TIDAL memerlukan integrasi Player SDK.
app.get("/stream/:id", (req, res) => {
  res.set("Cache-Control", "no-store").sendStatus(404);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Layz Addon berjalan di port 3000");
});
