// Script de sincronización standalone para GitHub Actions.
// Corre cada 20 min, llama a API-Football (api-sports.io) y actualiza
// tournament/results y tournament/teamOverrides en Realtime Database.
//
// API-Football free tier: 100 requests/día. Este script usa 1 request por
// corrida (todos los fixtures del Mundial en una sola llamada), así que con
// el cron de */20 (72 corridas/día) entra cómodo.
//
// Variables de entorno requeridas:
//   API_FOOTBALL_KEY           (key de dashboard.api-football.com)
//   FIREBASE_DATABASE_URL
//   FIREBASE_SERVICE_ACCOUNT   (el JSON completo del service account)

import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { MATCHES } from "./fixture.js";

const LEAGUE_ID = 1;     // FIFA World Cup en API-Football
const SEASON = "2026";

const TEAM_ALIASES = {
  "korea republic": "south korea",
  "ir iran": "iran",
  "czechia": "czech republic",
  "cote d ivoire": "ivory coast",
  "usa": "united states",
  "united states of america": "united states",
  "congo dr": "dr congo",
  "democratic republic of the congo": "dr congo",
  "cape verde islands": "cape verde",
};

// Normaliza para comparar: minúsculas, sin acentos, guiones/& y "and" → espacio.
// Así "Bosnia-Herzegovina", "Bosnia & Herzegovina" y "Bosnia and Herzegovina"
// terminan todas en "bosnia herzegovina".
function normalizeTeam(s) {
  let t = (s || "").toString().toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’.]/g, " ")
    .replace(/[-–&]/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ").trim();
  return TEAM_ALIASES[t] || t;
}
const isPlaceholder = (s) => /grupo|group|winner|runner|mejor|best|tbd|tba|\d[a-l]\b/i.test(s || "");

// API-Football usa league.round tipo "Group Stage - 1", "Round of 32",
// "Quarter-finals", "Semi-finals", "Third-place Play-off", "Final".
function phaseFromRound(round) {
  const r = (round || "").toString().toLowerCase();
  if (r.includes("group")) return "group";
  if (r.includes("32")) return "round_of_32";
  if (r.includes("16")) return "round_of_16";
  if (r.includes("quarter")) return "quarterfinal";
  if (r.includes("semi")) return "semifinal";
  if (r.includes("third") || r.includes("3rd")) return "third_place";
  if (r.includes("final")) return "final";
  return null;
}

// Tiene resultado si los goles no son null (en vivo ya vienen 0-0, FT final).
// goals incluye tiempo extra pero NO penales (igual que antes con TheSportsDB).
function hasResult(f) {
  return f.goals && f.goals.home != null && f.goals.away != null;
}

async function main() {
  if (!process.env.API_FOOTBALL_KEY) {
    throw new Error("Falta API_FOOTBALL_KEY (secret de GitHub). Crear key en dashboard.api-football.com");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const app = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  const db = getDatabase(app);

  // 1. Leer estado actual
  const currentResults = (await db.ref("tournament/results").get()).val() || {};
  const currentOverrides = (await db.ref("tournament/teamOverrides").get()).val() || {};

  // 2. Llamar a API-Football (1 sola request: todos los fixtures del torneo, en UTC)
  const url = `https://v3.football.api-sports.io/fixtures?league=${LEAGUE_ID}&season=${SEASON}&timezone=UTC`;
  const resp = await fetch(url, { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }
  const fixtures = data.response || [];
  console.log(`API-Football trajo ${fixtures.length} fixtures (requests hoy: ${JSON.stringify(data?.paging || {})})`);

  // Forma común: { date (YYYY-MM-DD UTC), ts, home, away, goals, phase, status }
  const events = fixtures.map(f => ({
    date: (f.fixture?.date || "").slice(0, 10),
    ts: f.fixture?.timestamp || 0,
    home: f.teams?.home?.name || "",
    away: f.teams?.away?.name || "",
    goals: f.goals,
    phase: phaseFromRound(f.league?.round),
    status: f.fixture?.status?.short || "",
  }));

  // 3. Buckets de knockout (por phase+date, ordenados por hora, igual que antes)
  const knockoutByPhaseDate = {};
  for (const e of events) {
    if (!e.phase || e.phase === "group") continue;
    const key = `${e.phase}|${e.date}`;
    if (!knockoutByPhaseDate[key]) knockoutByPhaseDate[key] = [];
    knockoutByPhaseDate[key].push(e);
  }
  for (const key of Object.keys(knockoutByPhaseDate)) {
    knockoutByPhaseDate[key].sort((a, b) => a.ts - b.ts);
  }

  const resultUpdates = {};
  const overrideUpdates = {};

  // 4. Mapeo de equipos reales para knockout (cuando ya están definidos los cruces)
  for (const key of Object.keys(knockoutByPhaseDate)) {
    const [phase, date] = key.split("|");
    const ours = MATCHES.filter(m => m.phase === phase && m.date === date)
                        .sort((a, b) => a.id.localeCompare(b.id));
    const theirs = knockoutByPhaseDate[key];
    const n = Math.min(ours.length, theirs.length);
    for (let i = 0; i < n; i++) {
      const myMatch = ours[i];
      const apiHome = theirs[i].home;
      const apiAway = theirs[i].away;
      if (apiHome && apiAway && !isPlaceholder(apiHome) && !isPlaceholder(apiAway)) {
        const cur = currentOverrides[myMatch.id] || {};
        if (cur.home !== apiHome || cur.away !== apiAway) {
          overrideUpdates[myMatch.id] = { home: apiHome, away: apiAway };
        }
      }
    }
  }

  // 5. Resultados de TODOS los partidos con score (en vivo y terminados)
  let unmatched = 0;
  for (const e of events) {
    if (!hasResult(e)) continue;
    const homeScore = parseInt(e.goals.home, 10);
    const awayScore = parseInt(e.goals.away, 10);

    let candidate = MATCHES.find(m =>
      m.date === e.date &&
      normalizeTeam(m.homeRaw) === normalizeTeam(e.home) &&
      normalizeTeam(m.awayRaw) === normalizeTeam(e.away)
    );
    if (!candidate) {
      // Knockout: matchear por posición
      if (e.phase && e.phase !== "group") {
        const ours = MATCHES.filter(m => m.phase === e.phase && m.date === e.date)
                            .sort((a, b) => a.id.localeCompare(b.id));
        const theirs = knockoutByPhaseDate[`${e.phase}|${e.date}`] || [];
        const idx = theirs.indexOf(e);
        if (idx >= 0 && ours[idx]) candidate = ours[idx];
      }
    }
    if (!candidate) {
      // Último recurso: por equipos sin fecha (si el cruce es único)
      const alts = MATCHES.filter(m =>
        normalizeTeam(m.homeRaw) === normalizeTeam(e.home) &&
        normalizeTeam(m.awayRaw) === normalizeTeam(e.away)
      );
      if (alts.length === 1) candidate = alts[0];
    }
    if (!candidate) {
      unmatched++;
      console.log(`  ⚠ sin match: ${e.date} ${e.home} vs ${e.away} (${e.status})`);
      continue;
    }

    const existing = currentResults[candidate.id];
    if (existing && existing.home === homeScore && existing.away === awayScore) continue;
    resultUpdates[candidate.id] = { home: homeScore, away: awayScore };
    console.log(`  ${candidate.id}: ${e.home} ${homeScore}-${awayScore} ${e.away} (${e.status})`);
  }

  // 6. Aplicar updates
  if (Object.keys(resultUpdates).length) {
    await db.ref("tournament/results").update(resultUpdates);
  }
  if (Object.keys(overrideUpdates).length) {
    await db.ref("tournament/teamOverrides").update(overrideUpdates);
  }
  await db.ref("tournament/lastApiSync").set(Date.now());

  console.log(`✅ ${Object.keys(resultUpdates).length} resultados, ${Object.keys(overrideUpdates).length} llaves, ${unmatched} no matcheados`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("❌ Error:", e); process.exit(1); });
