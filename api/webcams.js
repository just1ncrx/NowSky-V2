// Vercel Serverless Function
// Fetches webcam markers from meteopool.org, filters to renderMethod === "img",
// and returns a simplified JSON array with lat, lon, url, name, id.

const SOURCE_URL =
  "https://www.meteopool.org/lm-wfs.php?l=webcamMarkers&ak=a08c64145c56ee00fe18226232bc2531&lang=de";

module.exports = async (req, res) => {
  // CORS - allow any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
      throw new Error(`Upstream request failed with status ${response.status}`);
    }
    const geojson = await response.json();

    const features = Array.isArray(geojson.features) ? geojson.features : [];

    const cams = features
      .filter((f) => f?.properties?.renderMethod === "img")
      .map((f) => {
        const props = f.properties || {};
        const geometries = f.geometry?.geometries || [];
        const point = geometries.find((g) => g.type === "Point");
        const lon = point?.coordinates?.[0] ?? null;
        const lat = point?.coordinates?.[1] ?? null;

        return {
          id: props.id ?? null,
          name: props.name ?? null,
          state: props.state ?? null,
          status: props.status ?? null,
          live: props.live ?? null,
          renderMethod: props.renderMethod ?? null,
          url: props.url ?? null,
          lat,
          lon,
        };
      });

    // optional query params: limit, state, live
    const { limit, state, live } = req.query || {};
    let result = cams;

    if (state !== undefined) {
      result = result.filter((c) => String(c.state) === String(state));
    }
    if (live !== undefined) {
      result = result.filter((c) => String(c.live) === String(live));
    }
    if (limit !== undefined) {
      const n = parseInt(limit, 10);
      if (!Number.isNaN(n) && n > 0) {
        result = result.slice(0, n);
      }
    }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
    res.status(200).json({
      count: result.length,
      total: cams.length,
      webcams: result,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch or process webcam data", detail: String(err) });
  }
};
