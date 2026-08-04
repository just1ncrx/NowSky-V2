const { computeWis } = require("../lib/wis");

// Passe die Quelle bei Bedarf über die Vercel-Umgebungsvariable WIS_SOURCE_URL an.
const SOURCE_URL = process.env.WIS_SOURCE_URL || "https://lewetter.com/api/live.php";
const CACHE_TTL_MS = 60 * 1000;

// Einfacher In-Memory-Cache pro warmer Serverless-Instanz.
// Verhindert, dass jeder Aufruf sofort die fremde Quelle neu abruft.
let cache = { data: null, expires: 0 };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Nur GET erlaubt" });
    return;
  }

  try {
    const now = Date.now();
    let raw;

    if (cache.data && cache.expires > now) {
      raw = cache.data;
    } else {
      const response = await fetch(`${SOURCE_URL}${SOURCE_URL.includes("?") ? "&" : "?"}ts=${now}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Quelle antwortete mit Status ${response.status}`);
      }
      raw = await response.json();
      cache = { data: raw, expires: now + CACHE_TTL_MS };
    }

    const result = computeWis(raw);

    // CDN-Caching für 60s, damit nicht jeder Request die Quelle neu belastet.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    res.status(200).json(result);
  } catch (error) {
    res.status(502).json({
      error: "WIS-Daten konnten nicht geladen werden",
      details: error.message
    });
  }
};
