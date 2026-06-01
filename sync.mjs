// Script de sincronización standalone para GitHub Actions.
// Corre cada 20 min, llama a api-football y actualiza tournament/results
// y tournament/teamOverrides en Realtime Database.
//
// Variables de entorno requeridas:
//   API_FOOTBALL_KEY
//   FIREBASE_DATABASE_URL
//   FIREBASE_SERVICE_ACCOUNT  (el JSON completo del service account)

import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { MATCHES } from "./fixture.js";

const LEAGUE = 1;        // FIFA World Cup
const SEASON = 2026;

const TEAM_ALIASES = {
  "korea republic": "South Korea",
  "ir iran": "Iran",
  "czechia": "Czech Republic",
  "côte d'ivoire": "Ivory Coast",
  "cote d'ivoire": "Ivory Coast",
  "usa": "United States",
  "united states of america": "United States",
  "congo dr": "DR Congo",
  "dr congo": "DR Congo",
  "democratic republic of the congo": "DR Congo",
  "cape verde islands": "Cape Verde",
};

function normalizeTeam(s) {
  return (s || "").toString().toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function aliasTeam(name) {
  return TEAM_ALIASES[normalizeTeam(name)] || name;
}
const isPlaceholder = (s) => /grupo|group|winner|runner|mejor|best/i.test(s || "");

function phaseFromRound(round) {
  if (!round) return null;
  const r = round.toLowerCase();
  if (r.includes("round of 32") || r.includes("16vos")) return "round_of_32";
  if (r.includes("round of 16") || r.includes("octavos")) return "round_of_16";
  if (r.includes("quarter") || r.includes("cuartos")) return "quarterfinal";
  if (r.includes("semi")) return "semifinal";
  if (r.includes("3rd") || r.includes("third") || r.includes("tercer")) return "third_place";
  if (r.includes("final")) return "final";
  return null;
}

const VALID_STATUSES = [
  "FT", "AET", "PEN",
  "1H", "HT", "2H", "ET", "BT", "P",
  "LIVE", "INT", "SUSP"
];

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  const app = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  const db = getDatabase(app);

  // 1. Leer estado actual
  const currentResultsSnap = await db.ref("tournament/results").get();
  const currentResults = currentResultsSnap.val() || {};
  const currentOverridesSnap = await db.ref("tournament/teamOverrides").get();
  const currentOverrides = currentOverridesSnap.val() || {};

  // 2. Llamar a api-football
  const resp = await fetch(
    `https://v3.football.api-sports.io/fixtures?league=${LEAGUE}&season=${SEASON}`,
    { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY } }
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const errs = data.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
    throw new Error("API errors: " + JSON.stringify(errs));
  }
  const fixtures = data.response || [];
  console.log(`API trajo ${fixtures.length} fixtures`);

  // 3. Buckets de knockout por phase+date para mapeo posicional
  const apiKnockout = fixtures
    .filter(f => f.league?.round && !/group|grupo/i.test(f.league.round))
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
  const knockoutByPhaseDate = {};
  for (const f of apiKnockout) {
    const phase = phaseFromRound(f.league?.round);
    if (!phase) continue;
    const date = (f.fixture.date || "").split("T")[0];
    const key = `${phase}|${date}`;
    if (!knockoutByPhaseDate[key]) knockoutByPhaseDate[key] = [];
    knockoutByPhaseDate[key].push(f);
  }

  const resultUpdates = {};
  const overrideUpdates = {};

  // 4. Mapeo de equipos reales para knockout
  for (const key of Object.keys(knockoutByPhaseDate)) {
    const [phase, date] = key.split("|");
    const ours = MATCHES.filter(m => m.phase === phase && m.date === date)
                        .sort((a, b) => a.id.localeCompare(b.id));
    const theirs = knockoutByPhaseDate[key];
    const n = Math.min(ours.length, theirs.length);
    for (let i = 0; i < n; i++) {
      const myMatch = ours[i];
      const apiF = theirs[i];
      const apiHome = apiF.teams?.home?.name;
      const apiAway = apiF.teams?.away?.name;
      if (apiHome && apiAway && !isPlaceholder(apiHome) && !isPlaceholder(apiAway)) {
        const cur = currentOverrides[myMatch.id] || {};
        if (cur.home !== apiHome || cur.away !== apiAway) {
          overrideUpdates[myMatch.id] = { home: apiHome, away: apiAway };
        }
      }
    }
  }

  // 5. Resultados (grupos + knockout)
  let unmatched = 0;
  for (const f of fixtures) {
    const st = f.fixture?.status?.short;
    if (!VALID_STATUSES.includes(st)) continue;
    if (f.goals?.home == null || f.goals?.away == null) continue;
    const apiDate = (f.fixture.date || "").split("T")[0];
    const apiHome = aliasTeam(f.teams.home.name);
    const apiAway = aliasTeam(f.teams.away.name);

    let candidate = MATCHES.find(m =>
      m.date === apiDate &&
      normalizeTeam(m.homeRaw) === normalizeTeam(apiHome) &&
      normalizeTeam(m.awayRaw) === normalizeTeam(apiAway)
    );
    // Knockout: matchear por posición
    if (!candidate && f.league?.round && !/group|grupo/i.test(f.league.round)) {
      const phase = phaseFromRound(f.league.round);
      const date = (f.fixture.date || "").split("T")[0];
      const ours = MATCHES.filter(m => m.phase === phase && m.date === date)
                          .sort((a, b) => a.id.localeCompare(b.id));
      const theirs = knockoutByPhaseDate[`${phase}|${date}`] || [];
      const idx = theirs.indexOf(f);
      if (idx >= 0 && ours[idx]) candidate = ours[idx];
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
    if (existing && existing.home === f.goals.home && existing.away === f.goals.away) continue;
    resultUpdates[candidate.id] = { home: f.goals.home, away: f.goals.away };
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
