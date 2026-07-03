// api/kratzprognose.js
//
// Gibt fuer die naechsten Tage jeweils eine Kratzprognose fuer 6 Uhr morgens
// zurueck. Datenquelle: Bright Sky API (https://brightsky.dev)
//
// Aufruf z.B.:
//   /api/kratzprognose?lat=49.8783&lon=8.4567
//
// Falls lat/lon fehlen, wird ein Standardort (Buerstadt) verwendet.

const DEFAULT_LAT = 49.6435;
const DEFAULT_LON = 8.46;
const ZIEL_STUNDE = 6; // Uhrzeit, fuer die die Prognose ausgewertet wird
const TIMEZONE = "Europe/Berlin";

// Liefert ein Datum als YYYY-MM-DD String, verschoben um `offsetDays` Tage,
// unter Beruecksichtigung der Zielzeitzone.
function isoDate(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  // toLocaleDateString mit "sv-SE" liefert zuverlaessig YYYY-MM-DD
  return now.toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
}

// Klassifiziert eine einzelne Stundenmessung in eine Kratz-Stufe (0-4)
// und liefert eine sprechende Bedeutung dazu.
function kratzStufe(entry) {
  const {
    temperature: t,
    dew_point: taupunkt,
    cloud_cover: wolken,
    wind_speed: wind,
    precipitation: niederschlag,
    condition,
    visibility,
  } = entry;

  const naheTaupunkt = t !== null && taupunkt !== null && t - taupunkt < 2;
  const windarm = wind !== null && wind < 10; // km/h
  const klarerHimmel = wolken !== null && wolken < 40;
  const starkBewoelkt = wolken !== null && wolken > 70;
  const neblig = visibility !== null && visibility < 1000;

  // Glätte-/Eisregen-Gefahr: Niederschlag bei Temperaturen um/unter 0 Grad
  if (
    t !== null &&
    t <= 0.5 &&
    niederschlag !== null &&
    niederschlag > 0 &&
    (condition === "rain" || condition === "sleet" || condition === "snow")
  ) {
    return {
      stufe: 4,
      label: "Glätte-/Eisregengefahr",
      beschreibung:
        "Vorsicht: Niederschlag bei Temperaturen um den Gefrierpunkt. Straße und Scheibe können vereist sein.",
    };
  }

  // Stark vereist: kalt, klarer Himmel, feucht, windstill -> starke Reifbildung
  if (t !== null && t <= 0 && klarerHimmel && naheTaupunkt && windarm) {
    return {
      stufe: 3,
      label: "Stark vereist",
      beschreibung:
        "Kräftiges Kratzen nötig, dicke Reif-/Eisschicht auf der Scheibe wahrscheinlich.",
    };
  }

  // Reif wahrscheinlich: kühl, klar, feucht oder windstill
  if (t !== null && t <= 2 && klarerHimmel && windarm) {
    return {
      stufe: 2,
      label: "Kratzen nötig",
      beschreibung:
        "Reifbildung wahrscheinlich – Windschutzscheibe muss vermutlich freigekratzt werden.",
    };
  }

  // Leichter Belag / Tau möglich
  if (t !== null && t <= 3 && (naheTaupunkt || !starkBewoelkt)) {
    return {
      stufe: 1,
      label: "Leichter Belag möglich",
      beschreibung:
        "Leichter Tau- oder Reifbelag denkbar, meist reicht kurzes Freiwischen.",
    };
  }

  // Nebel als eigener Hinweis, unabhängig von Temperatur
  if (neblig) {
    return {
      stufe: 1,
      label: "Sichtbehinderung durch Nebel",
      beschreibung:
        "Kein Kratzen nötig, aber Nebel kann die Sicht am Morgen einschränken.",
    };
  }

  return {
    stufe: 0,
    label: "Alles frei!",
    beschreibung: "Kein Kratzen nötig, die Scheibe sollte frei sein.",
  };
}

// Sucht in den stündlichen Wetterdaten eines Tages den Eintrag,
// der der Zielstunde am nächsten kommt.
function findeMorgenEintrag(eintraege, datum) {
  const kandidaten = eintraege.filter((e) =>
    e.timestamp.startsWith(datum)
  );
  if (kandidaten.length === 0) return null;

  return kandidaten.reduce((beste, aktuell) => {
    const stundeAktuell = new Date(aktuell.timestamp).getHours();
    const stundeBeste = new Date(beste.timestamp).getHours();
    const diffAktuell = Math.abs(stundeAktuell - ZIEL_STUNDE);
    const diffBeste = Math.abs(stundeBeste - ZIEL_STUNDE);
    return diffAktuell < diffBeste ? aktuell : beste;
  });
}

export default async function handler(req, res) {
  // CORS: Zugriff von jeder Origin erlauben
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight-Request direkt beantworten
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const lat = parseFloat(req.query.lat) || DEFAULT_LAT;
    const lon = parseFloat(req.query.lon) || DEFAULT_LON;

    const date = isoDate(0);
    const lastDate = isoDate(5);

    const url =
      `https://api.brightsky.dev/weather` +
      `?date=${date}&last_date=${lastDate}` +
      `&lat=${lat}&lon=${lon}&max_dist=5000` +
      `&tz=${encodeURIComponent(TIMEZONE)}&units=dwd`;

    const response = await fetch(url);
    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: "Fehler beim Abrufen der Wetterdaten von Bright Sky" });
    }

    const data = await response.json();
    const eintraege = data.weather || [];

    // Alle Tage im Zeitraum ermitteln (date bis lastDate)
    const tage = [];
    let cursor = new Date(date);
    const ende = new Date(lastDate);
    while (cursor <= ende) {
      tage.push(cursor.toLocaleDateString("sv-SE", { timeZone: TIMEZONE }));
      cursor.setDate(cursor.getDate() + 1);
    }

    const prognosen = tage
      .map((tag) => {
        const eintrag = findeMorgenEintrag(eintraege, tag);
        if (!eintrag) return null;

        const bewertung = kratzStufe(eintrag);

        return {
          datum: tag,
          uhrzeit: eintrag.timestamp,
          temperatur: eintrag.temperature,
          taupunkt: eintrag.dew_point,
          wolken: eintrag.cloud_cover,
          wind: eintrag.wind_speed,
          bedingung: eintrag.condition,
          icon: eintrag.icon,
          ...bewertung,
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      ort: { lat, lon },
      abgefragt_am: new Date().toISOString(),
      prognosen,
    });
  } catch (err) {
    return res.status(500).json({ error: "Interner Fehler", details: String(err) });
  }
}
