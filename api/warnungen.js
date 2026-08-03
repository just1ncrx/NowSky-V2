// api/warnungen.js
//
// Aufruf:  /api/warnungen?lat=49.5&lon=8.6
// Antwort: [{ type, onset, expires, text }, ...]
//
// Holt stündliche Wetterdaten von Open-Meteo (kein API-Key nötig) und
// prüft sie gegen ein paar einfache Regeln ("Warnungen"). Neue
// Warnungstypen kannst du unten einfach als weitere Funktion in
// WARNING_CHECKS eintragen.

export default async function handler(req, res) {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({
      error: "Parameter 'lat' und 'lon' sind erforderlich, z.B. ?lat=49.5&lon=8.6",
    });
  }

  const latitude = Number(lat);
  const longitude = Number(lon);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: "lat/lon müssen Zahlen sein" });
  }

  try {
    const weather = await fetchWeather(latitude, longitude);
    const warnungen = WARNING_CHECKS.flatMap((check) => check(weather));

    // Cache kurz zwischenspeichern, spart Open-Meteo-Requests bei häufigen Aufrufen
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    return res.status(200).json(warnungen);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Wetterdaten konnten nicht geladen werden" });
  }
}

// ---------------------------------------------------------------------------
// Datenabruf
// ---------------------------------------------------------------------------

async function fetchWeather(latitude, longitude) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", latitude);
  url.searchParams.set("longitude", longitude);
  url.searchParams.set("hourly", "temperature_2m,precipitation");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "7");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Open-Meteo Fehler: ${response.status}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Warnungs-Regeln
// Jede Funktion bekommt die rohen Open-Meteo-Daten und gibt ein Array von
// Warnungen ({ type, onset, expires, text }) zurück, ggf. leer.
// ---------------------------------------------------------------------------

const WARNING_CHECKS = [checkTropennacht, checkHitze, checkFrost];

/**
 * Tropennacht: Temperatur fällt zwischen 22:00 und 06:00 nicht unter 20°C.
 */
function checkTropennacht(weather) {
  const nights = groupIntoNights(weather.hourly, 22, 6);
  const warnungen = [];

  for (const night of nights) {
    if (night.temps.length === 0) continue;
    const minTemp = Math.min(...night.temps);

    if (minTemp >= 20) {
      warnungen.push({
        type: "tropennacht",
        onset: night.onset,
        expires: night.expires,
        text: `Tropennacht: Die Temperatur sinkt voraussichtlich nicht unter 20°C (Minimum ca. ${minTemp.toFixed(
          1
        )}°C).`,
      });
    }
  }

  return warnungen;
}

/**
 * Hitzewarnung: Tageshöchsttemperatur über 32°C.
 */
function checkHitze(weather) {
  const days = groupIntoDays(weather.hourly);
  const warnungen = [];

  for (const day of days) {
    if (day.temps.length === 0) continue;
    const maxTemp = Math.max(...day.temps);

    if (maxTemp >= 32) {
      warnungen.push({
        type: "hitze",
        onset: day.onset,
        expires: day.expires,
        text: `Hitzewarnung: Höchsttemperatur von ca. ${maxTemp.toFixed(1)}°C erwartet.`,
      });
    }
  }

  return warnungen;
}

/**
 * Frostwarnung: Temperatur fällt unter 0°C.
 */
function checkFrost(weather) {
  const days = groupIntoDays(weather.hourly);
  const warnungen = [];

  for (const day of days) {
    if (day.temps.length === 0) continue;
    const minTemp = Math.min(...day.temps);

    if (minTemp <= 0) {
      warnungen.push({
        type: "frost",
        onset: day.onset,
        expires: day.expires,
        text: `Frostwarnung: Temperatur sinkt auf ca. ${minTemp.toFixed(1)}°C.`,
      });
    }
  }

  return warnungen;
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Gruppiert stündliche Werte in Kalendertage (00:00–24:00 lokal). */
function groupIntoDays(hourly) {
  const byDay = new Map();

  hourly.time.forEach((iso, i) => {
    const dayKey = iso.slice(0, 10); // YYYY-MM-DD
    if (!byDay.has(dayKey)) {
      byDay.set(dayKey, {
        onset: `${dayKey}T00:00`,
        expires: `${dayKey}T23:59`,
        temps: [],
      });
    }
    byDay.get(dayKey).temps.push(hourly.temperature_2m[i]);
  });

  return [...byDay.values()];
}

/**
 * Gruppiert stündliche Werte in "Nächte": von startHour eines Tages
 * bis endHour des Folgetages (z.B. 22:00 bis 06:00).
 */
function groupIntoNights(hourly, startHour, endHour) {
  const nights = [];
  let current = null;

  hourly.time.forEach((iso, i) => {
    const hour = Number(iso.slice(11, 13));
    const temp = hourly.temperature_2m[i];

    const isNightHour = hour >= startHour || hour < endHour;

    if (isNightHour) {
      if (!current) {
        current = { onset: iso, expires: iso, temps: [] };
      }
      current.expires = iso;
      current.temps.push(temp);
    } else if (current) {
      nights.push(current);
      current = null;
    }
  });

  if (current) nights.push(current);
  return nights;
}
