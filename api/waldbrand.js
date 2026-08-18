const cheerio = require('cheerio');

// Bundesland Codes und Namen
const BUNDESLAENDER = {
  'BW': 'Baden-Württemberg',
  'BY': 'Bayern',
  'BE': 'Berlin',
  'BB': 'Brandenburg',
  'HB': 'Bremen',
  'HH': 'Hamburg',
  'HE': 'Hessen',
  'MV': 'Mecklenburg-Vorpommern',
  'NI': 'Niedersachsen',
  'NW': 'Nordrhein-Westfalen',
  'RP': 'Rheinland-Pfalz',
  'SL': 'Saarland',
  'SN': 'Sachsen',
  'ST': 'Sachsen-Anhalt',
  'SH': 'Schleswig-Holstein',
  'TH': 'Thüringen',
};

// CORRECTED: Manuelle Aliases für alle 34 ungematchten Stationen.
// Key = normalisierter HTML-Name (wie er von der DWD-Website kommt)
// Value = normalisierter CSV-Name (wie er in der Stationsliste vorkommt)
// Die Werte wurden mit der normalizeName()-Funktion generiert und sind alphabetisch sortiert.
const MANUAL_ALIASES = {
  'renningen': 'hofihingerrenningen',
  'flughafenstuttgart': 'echterdingenstuttgart',
  'flughafennürnberg': 'netzstallnürnberg',
  'dürnastfreising': 'dürnastweihenstephan',
  'wielenbach': 'demollstrwielenbach',
  'badkohlgrub': 'badkohlgrubrosshof',
  'sigmarszell': 'sigmarszellzeisertsweiler',
  'mittenwald': 'buckelwiesenmittenwald',
  'berlindahlem': 'berlindahlemfu',
  'berlinbrandenburgflughafen': 'berlinbrandenburg',
  'bremenflughafen': 'bremen',
  'flughafenhamburg': 'fuhlsbüttelhamburg',
  'cölbe': 'biedenkopfcölbekreismarburg',
  'flughafenfrankfurt': 'frankfurtmain',
  'hiddenseeinsel': 'hiddenseevitte',
  'borkum': 'borkumflugplatz',
  'flughafenhannover': 'hannover',
  'flughafenmünsterosnabrück': 'münsterosnabrück',
  'düsseldorfflughafen': 'düsseldorf',
  'bonnflughafenköln': 'bonnköln',
  'büchel': 'alflenbüchel',
  'manderscheid': 'manderscheidsonnenhof',
  'lerchenbergmainz': 'lerchenbergmainzzdf',
  'trier': 'trierzewen',
  'flughafensaarbrücken': 'ensheimsaarbrücken',
  'flughafenhalleleipzig': 'halleleipzig',
  'kubschütz': 'bautzenkreiskubschütz',
  'dresdenflughafenklotzsche': 'dresdenklotzsche',
  'bernburgsaale': 'bernburgnordsaale',
  'loderslebenquerfurt': 'loderslebenmühlequerfurt',
  'brodersbyschönhagen': 'ostseebadschönhagen',
  'padenstedt': 'padenstedtparkpony',
  'erfurtflughafenweimar': 'erfurtweimar',
  'jena': 'jenasternwarte',
};

// Wörter, die je nach Quelle mal ausgeschrieben, mal abgekürzt sind und
// beim Vergleich einfach ignoriert werden (Füllwörter).
const STOPWORDS = new Set([
  'v', 'd', 'vd', 'vor', 'der', 'von', 'dem', 'a', 'am', 'an', 'auf', 'bei',
  'im', 'in', 'ob', 'i',
]);

// Regex für den "erstellt DD.MM.YYYY HH:MM UTC"-Zeitstempel. Wird NICHT auf
// dem rohen HTML angewendet (zu fragil wegen verschachtelter Tags/Entities
// wie &nbsp; oder <abbr>-Elementen mitten im Satz), sondern auf dem bereits
// von cheerio extrahierten Klartext des <aside>-Footers, z.B.:
// "© Deutscher Wetterdienst, erstellt 07.08.2026 04:14 UTC."
const ERSTELLT_REGEX = /erstellt\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s*UTC/i;

// Extrahiert den Erstellungs-Zeitstempel aus einem bereits geladenen
// cheerio-Dokument. Gibt sowohl den rohen Text (z.B. "07.08.2026 04:14 UTC")
// als auch ein ISO-8601-Datum zurück (leichter für Clients zu parsen).
function extractErstelltTimestamp($) {
  // Text aller <aside>-Elemente zusammensuchen und Whitespace normalisieren
  // (verschachtelte <span>/<abbr>-Tags erzeugen sonst doppelte Leerzeichen
  // oder Zeilenumbrüche mitten im Zeitstempel).
  const asideText = $('aside').text().replace(/\s+/g, ' ').trim();

  // Fallback: falls kein <aside> existiert, im ganzen Body-Text suchen.
  const searchText = asideText || $('body').text().replace(/\s+/g, ' ').trim();

  const match = searchText.match(ERSTELLT_REGEX);
  if (!match) return null;

  const [, day, month, year, hour, minute] = match;
  const raw = `${day}.${month}.${year} ${hour}:${minute} UTC`;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:00Z`;

  return { raw, iso };
}

// WICHTIG: Die DWD-Tabellen zeigen 5 Prognosetage, beginnend mit dem Tag,
// an dem die Seite erstellt wurde ("erstellt"-Datum = Tag 0). Das ist NICHT
// immer ein Freitag! Frühere Versionen dieses Codes gingen fälschlich davon
// aus, dass Tag 0 = Freitag ist, wodurch bei Erstellung an einem anderen
// Wochentag (z.B. Samstag) alle Spalten falsch beschriftet wurden.
// Deshalb: keine Wochentagsnamen mehr, sondern ausschließlich die
// tatsächlich berechneten Kalenderdaten (YYYY-MM-DD) als Rückgabe.
function computeForecastDates(erstelltIso) {
  if (!erstelltIso) return null;

  const day0 = new Date(erstelltIso);
  if (isNaN(day0.getTime())) return null;

  const toDateString = (date) => date.toISOString().slice(0, 10); // YYYY-MM-DD

  const addDays = (date, days) => {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  };

  // Array von 5 ISO-Datumsstrings, Index 0 = Erstellungstag.
  return [0, 1, 2, 3, 4].map((offset) => toDateString(addDays(day0, offset)));
}

// Fetch mit automatischer Encoding-Erkennung: DWD-Server liefern Text-
// Dateien teils als UTF-8, teils als ISO-8859-1/Windows-1252 aus, ohne das
// korrekt im Content-Type-Header anzugeben. fetch().text() geht immer von
// UTF-8 aus -> bei falscher Kodierung werden Umlaute (ä ö ü ß) zerstört und
// tauchen als Replacement-Zeichen (U+FFFD) auf. Wir dekodieren deshalb roh
// und prüfen auf Replacement-Zeichen; falls vorhanden, erneut als
// windows-1252 dekodieren.
async function fetchTextSmart(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    return { ok: false, status: response.status, text: '' };
  }
  const buffer = await response.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.includes('\uFFFD')) {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  return { ok: true, status: response.status, text };
}

// Normalisiert Stationsnamen für robustes Matching zwischen CSV und HTML.
// klein schreiben, Satzzeichen weg, "Kr." -> "kreis", Füllwörter raus,
// in Wörter zerlegen, alphabetisch sortieren, zusammenfügen. So matcht es
// unabhängig von Wortreihenfolge, Abkürzungen und Schreibweise.
function normalizeName(name) {
  const withoutStopwords = name
    .toLowerCase()
    .replace(/\u00a0/g, ' ') // echtes nbsp-Zeichen (nach Decoding), nicht der Literal-String
    .replace(/[().,]/g, ' ')
    .replace(/\bkr\b\.?/g, 'kreis')
    .split(/[\s/\-]+/)
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word));

  return withoutStopwords.sort().join('');
}

// Lade die Stationsliste aus CSV
async function loadStationsFromCsv() {
  try {
    const csvUrl =
      'https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/woodland/forecast/recent/derived_germany_fire_danger_index_woodland_forecast_recent_v2-3--0_stations_list.txt';

    const { ok, text: csv } = await fetchTextSmart(csvUrl, {
      'User-Agent': 'Mozilla/5.0 (compatible; WaldbrandBot/1.0)',
    });
    if (!ok) return {};

    // Map: normalisierter Name -> Stationsdaten (inkl. Original-Name)
    const stationsMap = {};

    const lines = csv.split('\n');

    // Skip header
    lines.slice(1).forEach((line) => {
      if (line.trim()) {
        const parts = line.split(';');
        if (parts.length >= 6) {
          const index = parseInt(parts[0].trim());
          const hoehe = parseInt(parts[1].trim());
          const lat = parseFloat(parts[2].trim());
          const lon = parseFloat(parts[3].trim());
          const name = parts[4].trim();
          const bundesland = parts[5].trim();

          const key = normalizeName(name);
          stationsMap[key] = { index, hoehe, lat, lon, bundesland, originalName: name };
        }
      }
    });

    return stationsMap;
  } catch (error) {
    console.error('Error loading CSV:', error);
    return {};
  }
}

// Fetch und parse DWD Daten für ein Bundesland
async function fetchBundeslandData(code, bundeslandName) {
  try {
    const url = `https://www.dwd.de/DWD/warnungen/agrar/wbx/wbx_tab_alle_${code}.html`;
    const { ok, status, text: html } = await fetchTextSmart(url, {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    });

    if (!ok) {
      console.warn(`Bundesland ${bundeslandName} (${code}): HTTP ${status}`);
      return { indexData: {}, erstellt: null };
    }

    const $ = cheerio.load(html);
    const indexData = {};

    // Parse ALLE Datentabellen der Seite (manche Bundesländer haben mehrere
    // Tabellen, z.B. nach Regierungsbezirk aufgeteilt)
    $('table').each((tblIdx, table) => {
      $(table)
        .find('tbody tr')
        .each((rowIdx, row) => {
          const cells = $(row).find('td');
          // Nur echte Datenzeilen (Legende hat nur 2 Spalten)
          if (cells.length >= 6) {
            const nameCell = $(cells[0]).text().replace(/\s+/g, ' ').trim();
            // Die 5 Prognosewerte werden NICHT mehr Wochentagen zugeordnet,
            // sondern einfach sequenziell als Tag 0..4 gespeichert. Die
            // tatsächlichen Kalenderdaten kommen später aus
            // computeForecastDates() (siehe dort, warum Tag 0 != Freitag
            // sein kann).
            const values = [1, 2, 3, 4, 5].map((i) => {
              const v = parseInt($(cells[i]).text().trim());
              return isNaN(v) ? null : v;
            });

            if (nameCell && values[0] !== null) {
              indexData[nameCell] = {
                bundesland: bundeslandName,
                values,
              };
            }
          }
        });
    });

    // "erstellt"-Zeitstempel aus dem <aside>-Footer der Seite ziehen
    // (z.B. "Deutscher Wetterdienst, erstellt 07.08.2026 04:14 UTC.")
    const erstellt = extractErstelltTimestamp($);

    return { indexData, erstellt };
  } catch (error) {
    console.error(`Error fetching ${bundeslandName}:`, error);
    return { indexData: {}, erstellt: null };
  }
}

// Fetch Daten für alle Bundesländer
async function fetchAllBundeslaenderData() {
  const allIndexData = {};
  const stats = {};
  let erstellt = null;

  const promises = Object.entries(BUNDESLAENDER).map(async ([code, name]) => {
    const { indexData, erstellt: erstelltForLand } = await fetchBundeslandData(code, name);
    stats[name] = Object.keys(indexData).length;
    return { indexData, erstellt: erstelltForLand };
  });

  const results = await Promise.all(promises);

  results.forEach(({ indexData, erstellt: erstelltForLand }) => {
    Object.assign(allIndexData, indexData);
    // Ersten gefundenen Zeitstempel übernehmen (alle Bundesland-Seiten
    // werden i.d.R. zur gleichen Zeit generiert, daher reicht der erste).
    if (!erstellt && erstelltForLand) {
      erstellt = erstelltForLand;
    }
  });

  return { allIndexData, stats, erstellt };
}

module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({
      success: false,
      timestamp: new Date().toISOString(),
      count: 0,
      data: [],
      error: 'Method not allowed',
    });
    return;
  }

  try {
    // Parallel fetch - CSV + alle Bundesländer
    const [stationsMap, { allIndexData, stats, erstellt }] = await Promise.all([
      loadStationsFromCsv(),
      fetchAllBundeslaenderData(),
    ]);

    // Array mit den 5 tatsächlichen Kalenderdaten (Index 0 = Erstellungstag).
    // z.B. ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]
    const dates = erstellt ? computeForecastDates(erstellt.iso) : null;

    const stations = [];
    const unmatched = [];

    // Merge Daten über normalisierten Namen (robust gegen
    // Schreibweise-Unterschiede zwischen HTML und CSV). Falls das nicht
    // klappt, wird zusätzlich in der manuellen Alias-Tabelle nachgeschaut.
    Object.entries(allIndexData).forEach(([stationName, values]) => {
      const key = normalizeName(stationName);
      let stationInfo = stationsMap[key];

      if (!stationInfo && MANUAL_ALIASES[key]) {
        stationInfo = stationsMap[MANUAL_ALIASES[key]];
      }

      if (stationInfo) {
        // Statt fixer Wochentags-Keys ("friday" etc.) hier die echten
        // Datums-Strings als Keys verwenden, z.B. "2026-08-08": 3.
        // Falls kein "erstellt"-Zeitstempel gefunden wurde (dates === null),
        // gibt es keine verlässliche Zuordnung -> forecast bleibt null und
        // die rohen Werte landen unter "values" (Fallback für Debugging).
        const forecast = {};
        if (dates) {
          dates.forEach((dateStr, i) => {
            forecast[dateStr] = values.values[i];
          });
        }

        stations.push({
          stationsIndex: stationInfo.index,
          name: stationName,
          bundesland: values.bundesland || stationInfo.bundesland,
          hoehe: stationInfo.hoehe,
          latitude: stationInfo.lat,
          longitude: stationInfo.lon,
          // Objekt mit Datum als Key, z.B. { "2026-08-08": 3, "2026-08-09": 4, ... }
          forecast: dates ? forecast : null,
          // Fallback, falls dates aus irgendeinem Grund nicht berechnet werden konnte
          values: dates ? undefined : values.values,
        });
      } else {
        unmatched.push({ name: stationName, normalizedKey: key });
      }
    });

    // Sortiere nach Bundesland, dann Name
    stations.sort((a, b) => {
      if (a.bundesland !== b.bundesland) {
        return a.bundesland.localeCompare(b.bundesland);
      }
      return a.name.localeCompare(b.name);
    });

    res.status(200).json({
      success: true,
      // Wann der DWD die Daten laut eigenem Footer erstellt hat
      // (z.B. "07.08.2026 04:14 UTC"), plus ISO-Variante zum einfachen Parsen.
      erstellt: erstellt ? erstellt.raw : null,
      erstelltIso: erstellt ? erstellt.iso : null,
      // Die 5 tatsächlichen Kalenderdaten der Prognose, in der Reihenfolge
      // wie sie in "forecast" pro Station verwendet werden.
      dates,
      timestamp: new Date().toISOString(),
      count: stations.length,
      data: stations,
      debug: {
        stationsInCsv: Object.keys(stationsMap).length,
        stationsFoundInHtml: Object.keys(allIndexData).length,
        matched: stations.length,
        unmatchedCount: unmatched.length,
        unmatchedNames: unmatched.slice(0, 40),
        perBundesland: stats,
      },
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      timestamp: new Date().toISOString(),
      count: 0,
      data: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
