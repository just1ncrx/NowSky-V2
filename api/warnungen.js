// api/warnungen.js
//
// Aufruf:   /api/warnungen?lat=49.64&lon=8.47
// Optional: &max_dist=50000   (Suchradius für die Station in Metern, Default 50000)
//
// Datenquelle: Bright Sky (https://brightsky.dev) – ein freier Layer über den
// DWD-Rohdaten. Es wird IMMER die nächstgelegene Station verwendet und nur
// Zeitpunkte ab "jetzt" (Europe/Berlin) betrachtet.
//
// Ausgegeben werden NUR Warnungen mit Beginn (onset) HEUTE. Beginnt eine
// Warnung erst MORGEN, wird sie als Vorabinformation markiert
// (vorabinformation: true, Headline-Präfix, angepasste urgency/certainty) –
// analog zum echten DWD-Rhythmus, wo Vorabinformationen für den Folgetag
// typischerweise gegen 19 Uhr herausgegeben werden. Warnungen, die weder
// heute noch morgen beginnen, werden verworfen.
//
// "effective" ist bewusst NICHT die exakte Aufrufzeit, sondern ein fester
// Ausstellungszeitpunkt pro Tag (heute 06:00 für reguläre Warnungen, heute
// 19:00 für Vorabinformationen) – ändert sich also nicht bei jedem Request,
// sondern nur einmal täglich.
//
// WICHTIG: Das hier sind KEINE echten amtlichen DWD-Warnungen (die gäbe es
// über Bright Skys /alarms-Endpoint, mit von DWD verfassten Texten). Das
// sind selbst berechnete Warnungen auf Basis der Wetterwerte, mit eigenen
// Texten – im gleichen Feld-Format wie eine amtliche CAP-Warnung, damit sie
// sich leicht wie eine "echte" Warnung weiterverarbeiten lassen. Das Feld
// "status" ist deshalb bewusst "custom" statt "actual", und "quelle" macht
// die Herkunft explizit.

const BRIGHTSKY_BASE = "https://api.brightsky.dev/weather";

export default async function handler(req, res) {
  const { lat, lon } = req.query;
  const maxDist = clampInt(req.query.max_dist, 1000, 200000, 50000);

  if (!lat || !lon) {
    return res.status(400).json({
      error: "Parameter 'lat' und 'lon' sind erforderlich, z.B. ?lat=49.64&lon=8.47",
    });
  }

  const latitude = Number(lat);
  const longitude = Number(lon);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: "lat/lon müssen Zahlen sein" });
  }

  try {
    // 3 Tage Puffer holen: heute + morgen + übermorgen, damit z.B. eine
    // Tropennacht, die morgen um 22 Uhr beginnt, bis zu ihrem Ende
    // (übermorgen früh) vollständig in den Rohdaten vorhanden ist.
    const { entries, station } = await fetchNearestStationForecast(latitude, longitude, 3, maxDist);

    const now = new Date();
    const todayKey = berlinDateKey(now);
    const tomorrowKey = berlinDateKey(addDays(now, 1));

    const rawWarnungen = WARNING_CHECKS.flatMap((check) => check(entries, now, station));
    const warnungen = rawWarnungen
      .map((w) => finalizeWarnung(w, now, todayKey, tomorrowKey))
      .filter(Boolean);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    return res.status(200).json(warnungen);
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Wetterdaten konnten nicht geladen werden", detail: String(err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Filterung auf heute/morgen + Vorabinformation-Kennzeichnung
// ---------------------------------------------------------------------------

/**
 * Behält nur Warnungen mit Onset heute oder morgen. "Morgen"-Warnungen
 * werden als Vorabinformation markiert und entsprechend angepasst.
 * Alles andere (weiter in der Zukunft) wird verworfen (-> null).
 */
function finalizeWarnung(w, now, todayKey, tomorrowKey) {
  const onsetDateKey = w.onset.slice(0, 10); // w.onset ist bereits Berlin-lokal formatiert

  let vorab;
  if (onsetDateKey === todayKey) {
    vorab = false;
  } else if (onsetDateKey === tomorrowKey) {
    vorab = true;
  } else {
    return null;
  }

  // Fester Ausstellungszeitpunkt statt exakter Aufrufzeit: reguläre
  // Warnungen "seit heute 06:00", Vorabinformationen "seit heute 19:00"
  // (wie beim echten DWD-Vorabinformations-Rhythmus).
  const effective = fixedBerlinTimestamp(todayKey, vorab ? 19 : 6, now);

  return {
    ...w,
    effective,
    vorabinformation: vorab,
    response_type: vorab ? "monitor" : w.response_type,
    urgency: vorab ? "future" : w.urgency,
    certainty: vorab ? "possible" : w.certainty,
    headline_de: vorab ? `Vorabinformation: ${w.headline_de}` : w.headline_de,
    status: vorab ? "custom-vorab" : "custom",
  };
}

// ---------------------------------------------------------------------------
// Datenabruf: Bright Sky, nächste Station, nur Zukunft
// ---------------------------------------------------------------------------

async function fetchNearestStationForecast(latitude, longitude, days, maxDist) {
  const today = berlinDateKey(new Date());
  const lastDate = berlinDateKey(addDays(new Date(), days));

  const url = new URL(BRIGHTSKY_BASE);
  url.searchParams.set("date", today);
  url.searchParams.set("last_date", lastDate);
  url.searchParams.set("lat", latitude);
  url.searchParams.set("lon", longitude);
  url.searchParams.set("max_dist", maxDist);
  url.searchParams.set("units", "dwd");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Bright Sky Fehler: ${response.status}`);
  }
  const data = await response.json();

  if (!data.sources || data.sources.length === 0) {
    throw new Error("Keine Station in der Nähe gefunden (max_dist erhöhen?)");
  }

  // Immer die nächstgelegene Station nehmen, auch wenn Bright Sky wegen
  // Datenlücken mehrere Stationen im Zeitraum kombiniert hätte.
  const nearest = data.sources.reduce((a, b) => (a.distance <= b.distance ? a : b));

  const now = new Date();
  const entries = (data.weather || [])
    .filter((w) => w.source_id === nearest.id)
    .filter((w) => new Date(w.timestamp) >= now)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return {
    entries,
    station: {
      id: nearest.id,
      name: nearest.station_name,
      dwdStationId: nearest.dwd_station_id,
      wmoStationId: nearest.wmo_station_id,
      distanceMeters: nearest.distance,
      lat: nearest.lat,
      lon: nearest.lon,
    },
  };
}

// ---------------------------------------------------------------------------
// Warnungs-Regeln
// ---------------------------------------------------------------------------

const WARNING_CHECKS = [checkTropennacht, checkHitze, checkFrost];

/** Tropennacht: 22–6 Uhr lokal, Temperatur bleibt bei/über 20°C. */
function checkTropennacht(entries, now, station) {
  const nights = groupByLocalWindow(entries, (hour) => hour >= 22 || hour < 6);
  const warnungen = [];

  for (const night of nights) {
    if (night.temps.length === 0) continue;
    const minTemp = Math.min(...night.temps);
    if (minTemp < 20) continue;

    const stufe = minTemp >= 22 ? "moderate" : "minor";

    warnungen.push(
      buildWarnung({
        type: "tropennacht",
        eventCode: 9001,
        eventDe: stufe === "moderate" ? "TROPENNACHT (deutlich)" : "TROPENNACHT",
        category: "health",
        severity: stufe,
        urgency: hoursUntil(night.onset, now) <= 12 ? "immediate" : "expected",
        onset: night.onset,
        expires: night.expires,
        now,
        station,
        headline: `Warnung vor einer Tropennacht`,
        description: `In der kommenden Nacht sinkt die Temperatur laut Vorhersage voraussichtlich nicht unter etwa ${round1(
          minTemp
        )}°C. Das erschwert dem Körper die nächtliche Erholung, besonders für Kinder, Ältere und Menschen mit Vorerkrankungen.`,
        instruction: `Räume tagsüber abdunkeln und ab dem Abend gut lüften, wenn es draußen kühler ist als drinnen. Ausreichend trinken und schwere Mahlzeiten am Abend eher meiden.`,
      })
    );
  }

  return warnungen;
}

/** Hitze: Tageshöchstwert, dreistufig grob an DWD-Logik angelehnt. */
function checkHitze(entries, now, station) {
  const days = groupByLocalWindow(entries, (hour) => hour >= 6 && hour < 22, true);
  const warnungen = [];

  for (const day of days) {
    if (day.temps.length === 0) continue;
    const maxTemp = Math.max(...day.temps);
    if (maxTemp < 32) continue;

    const stufe = maxTemp >= 38 ? "severe" : maxTemp >= 36 ? "moderate" : "minor";
    const label = maxTemp >= 38 ? "EXTREME HITZE" : maxTemp >= 36 ? "STARKE HITZE" : "HITZE";

    warnungen.push(
      buildWarnung({
        type: "hitze",
        eventCode: 9002,
        eventDe: label,
        category: "health",
        severity: stufe,
        urgency: hoursUntil(day.onset, now) <= 12 ? "immediate" : "expected",
        onset: day.onset,
        expires: day.expires,
        now,
        station,
        headline: `Warnung vor ${stufe === "severe" ? "extremer" : stufe === "moderate" ? "starker" : ""} Hitze`.replace(
          "  ",
          " "
        ),
        description: `Für diesen Tag wird eine Höchsttemperatur von ungefähr ${round1(
          maxTemp
        )}°C erwartet. Das bedeutet eine spürbare Belastung für den Kreislauf, vor allem bei körperlicher Anstrengung im Freien.`,
        instruction: `Anstrengende Tätigkeiten wenn möglich in die kühleren Morgen- oder Abendstunden legen, viel trinken und direkte Sonne in der Mittagszeit meiden.`,
      })
    );
  }

  return warnungen;
}

/** Frost: Tagestiefstwert unter 0°C. */
function checkFrost(entries, now, station) {
  const days = groupByLocalWindow(entries, () => true, true);
  const warnungen = [];

  for (const day of days) {
    if (day.temps.length === 0) continue;
    const minTemp = Math.min(...day.temps);
    if (minTemp > 0) continue;

    const stufe = minTemp <= -5 ? "moderate" : "minor";

    warnungen.push(
      buildWarnung({
        type: "frost",
        eventCode: 9003,
        eventDe: stufe === "moderate" ? "STRENGER FROST" : "FROST",
        category: "met",
        severity: stufe,
        urgency: hoursUntil(day.onset, now) <= 12 ? "immediate" : "expected",
        onset: day.onset,
        expires: day.expires,
        now,
        station,
        headline: `Warnung vor Frost`,
        description: `Die Temperatur fällt an diesem Tag laut Vorhersage auf rund ${round1(
          minTemp
        )}°C. Auf Straßen und Wegen können sich Glätte oder gefrierende Nässe bilden.`,
        instruction: `Fahrweise und Kleidung anpassen, frostempfindliche Pflanzen schützen, Wasserleitungen im Freien bei Bedarf absperren.`,
      })
    );
  }

  return warnungen;
}

// ---------------------------------------------------------------------------
// Aufbau eines Warnungs-Objekts im DWD-CAP-ähnlichen Schema (eigene Inhalte)
// ---------------------------------------------------------------------------

function buildWarnung({
  type,
  eventCode,
  eventDe,
  category,
  severity,
  urgency,
  onset,
  expires,
  now,
  station,
  headline,
  description,
  instruction,
}) {
  const id = hashToInt(`${type}-${onset}-${expires}-${station.id}`);
  return {
    id,
    alert_id: `custom.${type}.${station.id}.${id}`,
    effective: toBerlinISOString(now),
    onset: toBerlinISOString(new Date(onset)),
    expires: toBerlinISOString(new Date(expires)),
    category,
    response_type: "prepare",
    urgency,
    severity,
    certainty: "likely",
    event_code: eventCode,
    event_de: eventDe,
    headline_de: headline,
    description_de: description,
    instruction_de: instruction,
    status: "custom",
    quelle: "Eigene Berechnung aus Bright-Sky-/DWD-Wettervorhersage – keine amtliche DWD-Warnung",
    station: {
      name: station.name,
      dwd_station_id: station.dwdStationId,
      wmo_station_id: station.wmoStationId,
      distance_m: station.distanceMeters,
    },
  };
}

// ---------------------------------------------------------------------------
// Zeit- und Gruppierungs-Hilfsfunktionen (Zeitzone: Europe/Berlin)
// ---------------------------------------------------------------------------

/** Gruppiert Einträge nach lokalem Kalendertag (00–24 Uhr) oder nach einem Stundenfenster (z.B. Nacht 22–6). */
function groupByLocalWindow(entries, hourPredicate, byCalendarDay = false) {
  const groups = new Map();
  let openGroup = null;

  for (const entry of entries) {
    const { dateKey, hour } = berlinParts(entry.timestamp);
    const inWindow = hourPredicate(hour);

    if (byCalendarDay) {
      if (!inWindow) continue;
      if (!groups.has(dateKey)) {
        groups.set(dateKey, { onset: entry.timestamp, expires: entry.timestamp, temps: [] });
      }
      const g = groups.get(dateKey);
      g.expires = entry.timestamp;
      g.temps.push(entry.temperature);
    } else {
      // Fenster, das über Mitternacht läuft (z.B. Nacht 22–6): fortlaufend gruppieren
      if (inWindow) {
        if (!openGroup) openGroup = { onset: entry.timestamp, expires: entry.timestamp, temps: [] };
        openGroup.expires = entry.timestamp;
        openGroup.temps.push(entry.temperature);
      } else if (openGroup) {
        groups.set(openGroup.onset, openGroup);
        openGroup = null;
      }
    }
  }
  if (openGroup) groups.set(openGroup.onset, openGroup);

  return [...groups.values()];
}

function berlinParts(isoString) {
  const date = new Date(isoString);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") === "24" ? "0" : get("hour")),
  };
}

function berlinDateKey(date) {
  return berlinParts(date.toISOString()).dateKey;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function toBerlinISOString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const offsetMin = berlinOffsetMinutes(date);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get(
    "second"
  )}${sign}${oh}:${om}`;
}

/** Baut einen ISO-Zeitstempel für ein gegebenes Berlin-Datum + feste Stunde, z.B. "2026-08-03" + 19 -> "2026-08-03T19:00:00+02:00". */
function fixedBerlinTimestamp(dateKey, hour, referenceDate) {
  const offsetMin = berlinOffsetMinutes(referenceDate);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return `${dateKey}T${hh}:00:00${sign}${oh}:${om}`;
}

function berlinOffsetMinutes(date) {
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const berlin = new Date(date.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  return Math.round((berlin - utc) / 60000);
}

function hoursUntil(isoString, now) {
  return (new Date(isoString) - now) / (1000 * 60 * 60);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function hashToInt(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}
