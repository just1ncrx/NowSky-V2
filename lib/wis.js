// Portierte Berechnungslogik aus dem Original-Frontend (script.js).
// Nimmt die rohen live.php-Daten und liefert nur: wisScore, wisIn30Min, history.

const BERLIN_TZ = "Europe/Berlin";

function getBerlinOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: BERLIN_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Gibt einen ISO-artigen Zeitstring MIT Berlin-Offset zurück, z.B. 2026-08-04T12:05:42+02:00
function toBerlinIso(date) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const offsetMinutes = getBerlinOffsetMinutes(date);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
}

function toPoints(historyRaw) {
  if (!Array.isArray(historyRaw)) return [];
  return historyRaw
    .map((entry) => {
      const value = typeof entry === "number" ? entry : Number(entry?.score ?? entry?.value ?? entry);
      const rawTime = entry && typeof entry === "object"
        ? (entry.time || entry.updatedAt || entry.timestamp || entry.date)
        : null;
      const timeMs = rawTime ? new Date(rawTime).getTime() : NaN;
      return {
        value: Number.isFinite(value) ? value : null,
        timeMs: Number.isFinite(timeMs) ? timeMs : null
      };
    })
    .filter((p) => p.value !== null)
    .sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function resolveCurrentWis(data, points) {
  const current = Number(data?.wisScore ?? data?.intensityScore);
  if (Number.isFinite(current)) return current;
  return points.length ? points[points.length - 1].value : 0;
}

function resolveThirtyMinutesAgo(points, current) {
  if (points.length < 2) return current;
  const timed = points.filter((p) => Number.isFinite(p.timeMs));
  if (timed.length >= 2) {
    const latestTime = timed[timed.length - 1].timeMs;
    const targetTime = latestTime - 30 * 60 * 1000;
    let best = timed[0];
    timed.forEach((p) => {
      if (p.timeMs <= targetTime) best = p;
    });
    return best.value;
  }
  return points[Math.max(0, points.length - 7)].value;
}

function historySpanMinutes(points) {
  const timed = points.filter((p) => Number.isFinite(p.timeMs));
  if (timed.length < 2) return 0;
  return Math.max(0, (timed[timed.length - 1].timeMs - timed[0].timeMs) / 60000);
}

function resolveTarget(data, current) {
  return finiteNumber(
    data?.intensityTargetScore,
    data?.targetScore,
    data?.wisTargetScore,
    data?.wisBreakdown?.target,
    data?.wisDebug?.target,
    current
  ) ?? current;
}

function projectionConfidence(data, points) {
  const span = historySpanMinutes(points);
  let confidence = 0.46 + Math.min(0.26, span / 120);
  if (points.length >= 8) confidence += 0.08;
  if (points.length >= 18) confidence += 0.06;
  if (data?.wisRadar?.stale || data?.radarPayload?.stale) confidence -= 0.06;
  if (data?.wisModel?.stale || data?.modelPotential?.stale) confidence -= 0.06;
  if (data?.wisObservations?.stale || data?.observationPayload?.stale) confidence -= 0.04;
  if (String(data?.wisWeatherMode || "").toLowerCase() === "heat_only") confidence -= 0.05;
  return clampNumber(confidence, 0.35, 0.84);
}

function projectWisScore(current, agoValue, points, data) {
  const trendDelta = Number(data?.wisTrend?.delta);
  const recentPoints = points.slice(-8);
  const recentDelta = recentPoints.length >= 2
    ? recentPoints[recentPoints.length - 1].value - recentPoints[0].value
    : current - agoValue;
  const target = resolveTarget(data, current);
  const targetDelta = clampNumber(target - current, -18, 18);
  const rawTrend = Number.isFinite(trendDelta) && Math.abs(trendDelta) >= 0.2 ? trendDelta : recentDelta;
  const confidence = projectionConfidence(data, points);
  const mode = String(data?.wisWeatherMode || "").toLowerCase();
  const primaryGroups = Number(data?.wisPrimaryGroupCount ?? data?.primaryGroupCount ?? data?.wisDebug?.counts?.primaryGroups ?? 0);
  const severeCount = Number(data?.alertCounts?.unwetter ?? data?.wisDebug?.counts?.unwetter ?? 0);
  const extremeCount = Number(data?.alertCounts?.extreme ?? data?.wisDebug?.counts?.extreme ?? 0);
  const eventBoost = finiteNumber(data?.intensityEventBoost, data?.wisBreakdown?.events, data?.wisDebug?.components?.newEventBoost, 0) ?? 0;
  const dynamicsBoost = finiteNumber(data?.intensityDynamicsBoost, data?.wisBreakdown?.dynamics, data?.wisDebug?.components?.dynamics, 0) ?? 0;

  let blendedDelta = targetDelta * 0.52 + clampNumber(rawTrend, -16, 16) * 0.34 + clampNumber(recentDelta, -14, 14) * 0.14;
  if (severeCount <= 0 && extremeCount <= 0 && targetDelta < -1 && rawTrend < -1) {
    blendedDelta = targetDelta * 0.68 + clampNumber(rawTrend, -16, 0) * 0.28 + Math.min(0, recentDelta) * 0.04;
  }
  if (Math.sign(targetDelta) !== 0 && Math.sign(rawTrend) !== 0 && Math.sign(targetDelta) !== Math.sign(rawTrend)) {
    blendedDelta *= 0.48;
  }

  let maxRise = mode === "heat_only" ? 3.2 : 5.5;
  if (primaryGroups > 0) maxRise += 1.8;
  maxRise += Math.min(4.5, eventBoost * 0.34 + dynamicsBoost * 0.28);
  const maxFall = primaryGroups > 0 ? (severeCount > 0 || extremeCount > 0 ? 6.0 : 8.5) : 9.0;
  let projectedDelta = clampNumber(blendedDelta * confidence, -maxFall, maxRise);
  if (severeCount <= 0 && extremeCount <= 0 && targetDelta <= -2 && rawTrend <= -2) {
    projectedDelta = Math.min(projectedDelta, targetDelta * 0.82);
  }

  return {
    value: clampNumber(current + projectedDelta, 0, 200),
    delta: projectedDelta,
    confidence
  };
}

function describeTrend(delta) {
  if (delta >= 4) return "steigend";
  if (delta >= 0.5) return "leicht steigend";
  if (delta <= -4) return "fallend";
  if (delta <= -0.5) return "leicht fallend";
  return "stabil";
}

function describeConfidence(confidence) {
  if (confidence >= 0.72) return "hohe Sicherheit";
  if (confidence >= 0.52) return "mittlere Sicherheit";
  return "vorsichtig";
}

function formatHistory(points) {
  return points.map((p) => ({
    time: Number.isFinite(p.timeMs) ? toBerlinIso(new Date(p.timeMs)) : null,
    score: Math.round(p.value * 10) / 10
  }));
}

function computeWis(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Ungueltige Quelldaten");
  }
  const historyRaw = raw.wisHistory || raw.intensityHistory || [];
  const points = toPoints(historyRaw);
  const current = resolveCurrentWis(raw, points);
  const agoValue = resolveThirtyMinutesAgo(points, current);
  const projection = projectWisScore(current, agoValue, points, raw);

  // updatedAt = letzter Zeitpunkt aus der History (nicht die aktuelle Serverzeit).
  const timedPoints = points.filter((p) => Number.isFinite(p.timeMs));
  const lastTimeMs = timedPoints.length
    ? timedPoints[timedPoints.length - 1].timeMs
    : Date.now();

  return {
    wisScore: Math.round(current * 10) / 10,
    wisIn30Min: {
      value: Math.round(projection.value * 10) / 10,
      delta: Math.round(projection.delta * 10) / 10,
      trend: describeTrend(projection.delta),
      confidence: Math.round(projection.confidence * 100) / 100,
      confidenceLabel: describeConfidence(projection.confidence)
    },
    history: formatHistory(points),
    updatedAt: toBerlinIso(new Date(lastTimeMs))
  };
}

module.exports = { computeWis };
