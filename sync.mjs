// Script de sincronización standalone para GitHub Actions.
// Corre cada 20 min, llama a football-data.org y actualiza
// tournament/results y tournament/teamOverrides en Realtime Database.
//
// football-data.org: el Mundial está en el tier GRATIS (forever).
// Límite: 10 requests/minuto. Este script usa 1 request por corrida.
//
// Variables de entorno requeridas:
//   FOOTBALL_DATA_KEY          (token de football-data.org)
//   FIREBASE_DATABASE_URL
//   FIREBASE_SERVICE_ACCOUNT   (el JSON completo del service account)

import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { MATCHES } from "./fixture.js";

const COMPETITION = "WC";   // FIFA World Cup

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
const isPlaceholder = (s) => !s || /grupo|group|winner|runner|mejor|best|tbd|tba/i.test(s);

// football-data.org v4 usa "stage": GROUP_STAGE, LAST_32, LAST_16,
// QUARTER_FINALS, SEMI_FINALS, THIRD_PLACE, FINAL.
const STAGE_TO_PHASE = {
  GROUP_STAGE: "group",
  LAST_32: "round_of_32",
  ROUND_OF_32: "round_of_32",
  LAST_16: "round_of_16",
  ROUND_OF_16: "round_of_16",
  QUARTER_FINALS: "quarterfinal",
  SEMI_FINALS: "semifinal",
  THIRD_PLACE: "third_place",
  FINAL: "final",
};

// Estados con score válido (en vivo o terminado)
const LIVE_OR_DONE = new Set(["IN_PLAY", "PAUSED", "EXTRA_TIME", "PENALTY_SHOOTOUT", "FINISHED"]);

async function main() {
  if (!process.env.FOOTBALL_DATA_KEY) {
    throw new Error("Falta FOOTBALL_DATA_KEY (secret de GitHub). Registrarse gratis en football-data.org");
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

  // 2. Llamar a football-data.org (1 request: todos los partidos del Mundial)
  const url = `https://api.football-data.org/v4/competitions/${COMPETITION}/matches`;
  const resp = await fetch(url, { headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_KEY } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`football-data.org HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  const rawMatches = data.matches || [];
  console.log(`football-data.org trajo ${rawMatches.length} partidos`);

  // Forma común
  const events = rawMatches.map(m => ({
    date: (m.utcDate || "").slice(0, 10),
    ts: Date.parse(m.utcDate || 0) || 0,
    home: m.homeTeam?.name || "",
    homeShort: m.homeTeam?.shortName || "",
    away: m.awayTeam?.name || "",
    awayShort: m.awayTeam?.shortName || "",
    phase: STAGE_TO_PHASE[m.stage] || null,
    status: m.status || "",
    goalsHome: m.score?.fullTime?.home,
    goalsAway: m.score?.fullTime?.away,
  }));

  const sameTeam = (mine, e, side) => {
    const raw = normalizeTeam(mine);
    return raw === normalizeTeam(side === "home" ? e.home : e.away)
        || raw === normalizeTeam(side === "home" ? e.homeShort : e.awayShort);
  };
  const hasResult = (e) => LIVE_OR_DONE.has(e.status) && e.goalsHome != null && e.goalsAway != null;

  // 3. Buckets de knockout (por phase+date, ordenados por hora)
  const knockoutByPhaseDate = {};
  for (const e of events) {
    if (!e.phase || e.phase === "group") continue;
    const key = `${e.phase}|${e.date}`;
    (knockoutByPhaseDate[key] ||= []).push(e);
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
      if (!isPlaceholder(apiHome) && !isPlaceholder(apiAway)) {
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
    const homeScore = parseInt(e.goalsHome, 10);
    const awayScore = parseInt(e.goalsAway, 10);

    let candidate = MATCHES.find(m =>
      m.date === e.date && sameTeam(m.homeRaw, e, "home") && sameTeam(m.awayRaw, e, "away")
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
      const alts = MATCHES.filter(m => sameTeam(m.homeRaw, e, "home") && sameTeam(m.awayRaw, e, "away"));
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
