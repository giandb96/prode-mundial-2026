// Script de sincronización standalone para GitHub Actions.
// Corre cada 20 min, llama a TheSportsDB y actualiza tournament/results
// y tournament/teamOverrides en Realtime Database.
//
// TheSportsDB es gratis sin clave (usa la key publica "3").
//
// Variables de entorno requeridas:
//   FIREBASE_DATABASE_URL
//   FIREBASE_SERVICE_ACCOUNT  (el JSON completo del service account)

import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { MATCHES } from "./fixture.js";

const TSDB_KEY = "3";          // free key pública
const LEAGUE_ID = 4429;        // FIFA World Cup
const SEASON = "2026";

const TEAM_ALIASES = {
  "korea republic": "South Korea",
  "south korea": "South Korea",
  "ir iran": "Iran",
  "iran": "Iran",
  "czechia": "Czech Republic",
  "czech republic": "Czech Republic",
  "côte d'ivoire": "Ivory Coast",
  "cote d'ivoire": "Ivory Coast",
  "ivory coast": "Ivory Coast",
  "usa": "United States",
  "united states of america": "United States",
  "united states": "United States",
  "congo dr": "DR Congo",
  "dr congo": "DR Congo",
  "democratic republic of the congo": "DR Congo",
  "cape verde islands": "Cape Verde",
  "cape verde": "Cape Verde",
};

function normalizeTeam(s) {
  return (s || "").toString().toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function aliasTeam(name) {
  return TEAM_ALIASES[normalizeTeam(name)] || name;
}
const isPlaceholder = (s) => /grupo|group|winner|runner|mejor|best|tbd|tba/i.test(s || "");

// TheSportsDB usa strings de "intRound" o "strGroup". Mapeo a nuestras fases.
function phaseFromRound(round, group) {
  const r = (round || "").toString().toLowerCase();
  const g = (group || "").toString().toLowerCase();
  // En group stage, strGroup tiene "A".."L" y intRound puede ser 1, 2, 3
  if (g && /^[a-l]$/i.test(g)) return "group";
  // Para knockout, strRound puede tener texto descriptivo
  if (r.includes("32") || r.includes("round of 32")) return "round_of_32";
  if (r.includes("16") || r.includes("round of 16") || r.includes("octav")) return "round_of_16";
  if (r.includes("quarter") || r.includes("cuart")) return "quarterfinal";
  if (r.includes("semi")) return "semifinal";
  if (r.includes("3rd") || r.includes("third") || r.includes("tercer")) return "third_place";
  if (r.includes("final")) return "final";
  // Fallback por número de round (TheSportsDB usa 125+ para knockout en algunos torneos)
  const n = parseInt(r, 10);
  if (n >= 125 && n < 200) return "round_of_32";
  if (n >= 200 && n < 250) return "round_of_16";
  if (n >= 250 && n < 300) return "quarterfinal";
  if (n >= 300 && n < 400) return "semifinal";
  if (n >= 400 && n < 500) return "third_place";
  if (n >= 500) return "final";
  return null;
}

// Determina si un evento tiene resultado (terminado o en curso con scores)
function hasResult(evt) {
  return evt.intHomeScore != null && evt.intAwayScore != null
    && evt.intHomeScore !== "" && evt.intAwayScore !== "";
}

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const app = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  const db = getDatabase(app);

  // 1. Leer estado actual
  const currentResults = (await db.ref("tournament/results").get()).val() || {};
  const currentOverrides = (await db.ref("tournament/teamOverrides").get()).val() || {};

  // 2. Llamar a TheSportsDB
  const url = `https://www.thesportsdb.com/api/v1/json/${TSDB_KEY}/eventsseason.php?id=${LEAGUE_ID}&s=${SEASON}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const events = data.events || [];
  console.log(`TheSportsDB trajo ${events.length} eventos`);

  // 3. Buckets de knockout
  const knockoutEvents = events
    .filter(e => phaseFromRound(e.intRound, e.strGroup) && phaseFromRound(e.intRound, e.strGroup) !== "group")
    .sort((a, b) => new Date(`${a.dateEvent}T${a.strTime || "00:00:00"}`) - new Date(`${b.dateEvent}T${b.strTime || "00:00:00"}`));
  const knockoutByPhaseDate = {};
  for (const e of knockoutEvents) {
    const phase = phaseFromRound(e.intRound, e.strGroup);
    const date = e.dateEvent;
    const key = `${phase}|${date}`;
    if (!knockoutByPhaseDate[key]) knockoutByPhaseDate[key] = [];
    knockoutByPhaseDate[key].push(e);
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
      const apiHome = theirs[i].strHomeTeam;
      const apiAway = theirs[i].strAwayTeam;
      if (apiHome && apiAway && !isPlaceholder(apiHome) && !isPlaceholder(apiAway)) {
        const cur = currentOverrides[myMatch.id] || {};
        if (cur.home !== apiHome || cur.away !== apiAway) {
          overrideUpdates[myMatch.id] = { home: apiHome, away: apiAway };
        }
      }
    }
  }

  // 5. Resultados de TODOS los partidos con score
  let unmatched = 0;
  for (const e of events) {
    if (!hasResult(e)) continue;
    const apiDate = e.dateEvent;
    const apiHome = aliasTeam(e.strHomeTeam);
    const apiAway = aliasTeam(e.strAwayTeam);
    const homeScore = parseInt(e.intHomeScore, 10);
    const awayScore = parseInt(e.intAwayScore, 10);

    let candidate = MATCHES.find(m =>
      m.date === apiDate &&
      normalizeTeam(m.homeRaw) === normalizeTeam(apiHome) &&
      normalizeTeam(m.awayRaw) === normalizeTeam(apiAway)
    );
    if (!candidate) {
      // Knockout: matchear por posición
      const phase = phaseFromRound(e.intRound, e.strGroup);
      if (phase && phase !== "group") {
        const ours = MATCHES.filter(m => m.phase === phase && m.date === apiDate)
                            .sort((a, b) => a.id.localeCompare(b.id));
        const theirs = knockoutByPhaseDate[`${phase}|${apiDate}`] || [];
        const idx = theirs.indexOf(e);
        if (idx >= 0 && ours[idx]) candidate = ours[idx];
      }
    }
    if (!candidate) {
      const alts = MATCHES.filter(m =>
        normalizeTeam(m.homeRaw) === normalizeTeam(apiHome) &&
        normalizeTeam(m.awayRaw) === normalizeTeam(apiAway)
      );
      if (alts.length === 1) candidate = alts[0];
    }
    if (!candidate) { unmatched++; continue; }

    const existing = currentResults[candidate.id];
    if (existing && existing.home === homeScore && existing.away === awayScore) continue;
    resultUpdates[candidate.id] = { home: homeScore, away: awayScore };
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
