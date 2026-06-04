// Prode Mundial 2026 — lógica principal
// Stack: Firebase Auth (Google) + Realtime Database en tiempo real.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getDatabase, ref, set, update, get, onValue, off, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

import { FIREBASE_CONFIG, ADMIN_EMAILS, TOURNAMENT_NAME, TOURNAMENT_START_UTC } from "./config.js";
import { GROUPS, MATCHES, ALL_TEAMS } from "./fixture.js";

// ===================== INIT =====================
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getDatabase(app);
const provider = new GoogleAuthProvider();

// Estado en memoria
const state = {
  user: null,            // { uid, email, name, photoURL, isAdmin }
  results: {},           // { matchId: { home, away } } — resultados oficiales
  finals: { champion: null, topScorer: null }, // oficiales
  teamOverrides: {},     // { matchId: { home, away } } — equipos reales de knockout
  myPicks: {},           // { matchId: { home, away } }
  myExtras: { champion: null, topScorer: null },
  allUsers: [],          // [{ uid, email, name, ... }]
  allPicks: {},          // { uid: { matchId: { home, away } } }
  allExtras: {},         // { uid: { champion, topScorer } }
  view: "picks",
  unsubs: []
};

// Helper: nombre real del equipo (override si existe, sino del fixture)
function matchHome(m) {
  return state.teamOverrides[m.id]?.home || m.home;
}
function matchAway(m) {
  return state.teamOverrides[m.id]?.away || m.away;
}

// ===================== SCORING =====================
function scoreMatch(officialHome, officialAway, predHome, predAway) {
  // Reglas:
  // - Sin resultado oficial → 0
  // - Pleno (marcador exacto): max(home+away, 3)
  // - Resultado correcto (gana local / empate / gana visitante): 1
  // - Si no, 0
  if (officialHome == null || officialAway == null) return { pts: 0, kind: "pending" };
  if (predHome == null || predAway == null) return { pts: 0, kind: "miss" };
  const oH = +officialHome, oA = +officialAway, pH = +predHome, pA = +predAway;
  if (oH === pH && oA === pA) {
    const total = oH + oA;
    return { pts: total > 3 ? total : 3, kind: "pleno" };
  }
  const oSign = Math.sign(oH - oA);
  const pSign = Math.sign(pH - pA);
  if (oSign === pSign) return { pts: 1, kind: "correct" };
  return { pts: 0, kind: "miss" };
}

function totalPointsForUser(uid) {
  const picks = state.allPicks[uid] || {};
  const extras = state.allExtras[uid] || {};
  let pts = 0, plenos = 0;
  for (const m of MATCHES) {
    const r = state.results[m.id];
    const p = picks[m.id];
    if (!r || !p) continue;
    const s = scoreMatch(r.home, r.away, p.home, p.away);
    pts += s.pts;
    if (s.kind === "pleno") plenos++;
  }
  if (state.finals.champion && extras.champion === state.finals.champion) pts += 10;
  if (state.finals.topScorer && extras.topScorer && normalize(extras.topScorer) === normalize(state.finals.topScorer)) pts += 10;
  return { pts, plenos };
}

function normalize(s) {
  return (s || "").toString().trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ===================== DEADLINE =====================
function dayDeadline(dateStr) {
  const matchesOfDay = MATCHES.filter(m => m.date === dateStr);
  const times = matchesOfDay
    .map(m => m.datetime ? new Date(m.datetime).getTime() : null)
    .filter(t => t != null);
  if (times.length === 0) return new Date(dateStr + "T03:00:00Z").getTime();
  return Math.min(...times);
}

function isDayLocked(dateStr) {
  return Date.now() >= dayDeadline(dateStr);
}

function isExtrasLocked() {
  return Date.now() >= new Date(TOURNAMENT_START_UTC).getTime();
}

// ===================== AUTH =====================
$("loginBtn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    toast("Error al loguearse: " + e.message, "err");
  }
});

// Login con email + contraseña
let signupMode = false;
$("toggleSignup").addEventListener("click", (e) => {
  e.preventDefault();
  signupMode = !signupMode;
  $("nameField").classList.toggle("hidden", !signupMode);
  $("emailLoginBtn").textContent = signupMode ? "Crear cuenta" : "Iniciar sesión";
  $("toggleSignup").textContent = signupMode
    ? "¿Ya tenés cuenta? Iniciar sesión"
    : "¿No tenés cuenta? Registrate";
  $("emailError").textContent = "";
});

$("emailLoginBtn").addEventListener("click", async () => {
  const email = $("emailField").value.trim();
  const password = $("passwordField").value;
  const name = $("nameField").value.trim();
  const err = $("emailError");
  err.textContent = "";

  if (!email || !password) {
    err.textContent = "Completá email y contraseña";
    return;
  }
  if (password.length < 6) {
    err.textContent = "La contraseña tiene que tener al menos 6 caracteres";
    return;
  }

  try {
    if (signupMode) {
      if (!name) { err.textContent = "Completá tu nombre"; return; }
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (e) {
    // Errores comunes en español
    const map = {
      "auth/invalid-email": "Email inválido",
      "auth/email-already-in-use": "Ese email ya está registrado. Probá iniciar sesión.",
      "auth/wrong-password": "Contraseña incorrecta",
      "auth/user-not-found": "No existe una cuenta con ese email. Registrate primero.",
      "auth/invalid-credential": "Email o contraseña incorrectos",
      "auth/weak-password": "La contraseña es muy débil",
      "auth/too-many-requests": "Demasiados intentos. Esperá unos minutos."
    };
    err.textContent = map[e.code] || ("Error: " + (e.message || e.code));
  }
});

// Permitir Enter para enviar el formulario
["emailField", "passwordField", "nameField"].forEach(id => {
  $(id).addEventListener("keypress", (ev) => {
    if (ev.key === "Enter") $("emailLoginBtn").click();
  });
});

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    state.user = null;
    cleanupSubscriptions();
    showView("login");
    $("nav").classList.add("hidden");
    $("userbox").classList.add("hidden");
    return;
  }
  state.user = {
    uid: user.uid,
    email: user.email,
    name: user.displayName,
    photoURL: user.photoURL,
    isAdmin: ADMIN_EMAILS.includes(user.email)
  };
  // Crear/actualizar doc del usuario
  await update(ref(db, `users/${user.uid}`), {
    email: user.email,
    name: user.displayName || user.email,
    photoURL: user.photoURL || "",
    lastLogin: serverTimestamp()
  });

  // Avatar de la topbar: probar CARAS primero, fallback a foto de Google
  const tbInfo = avatarUrl(user.email, user.photoURL, user.displayName);
  const photo = $("userPhoto");
  photo.src = tbInfo.initial;
  photo.dataset.username = tbInfo.username || "";
  photo.dataset.fallback = user.photoURL || initialsDataUrl(user.displayName);
  photo.dataset.finalFallback = initialsDataUrl(user.displayName);
  photo.dataset.email = user.email || "";
  photo.dataset.name = user.displayName || user.email || "";
  photo.dataset.tries = "0";
  photo.onerror = () => tryAvatar(photo);
  photo.classList.add("avatar", "clickable");
  $("userName").textContent = user.displayName || user.email;
  $("userbox").classList.remove("hidden");
  $("nav").classList.remove("hidden");
  if (state.user.isAdmin) $("adminTab").classList.remove("hidden");
  else $("adminTab").classList.add("hidden");

  await loadInitialData();
  startSubscriptions();
  showView("picks");
  // Auto-sync de resultados al entrar (solo admin)
  maybeAutoSync();
});

// ===================== DATA LOAD =====================
async function loadInitialData() {
  const snap = await get(ref(db, `picks/${state.user.uid}`));
  const data = snap.val() || {};
  state.myPicks = data.matches || {};
  state.myExtras = {
    champion: data.champion || null,
    topScorer: data.topScorer || null
  };
}

function startSubscriptions() {
  // Resultados oficiales + extras oficiales + team overrides
  const r1 = ref(db, "tournament");
  const h1 = onValue(r1, (snap) => {
    const v = snap.val() || {};
    state.results = v.results || {};
    state.teamOverrides = v.teamOverrides || {};
    state.finals = {
      champion: v.champion || null,
      topScorer: v.topScorer || null
    };
    renderCurrentView();
  });
  // Todos los usuarios
  const r2 = ref(db, "users");
  const h2 = onValue(r2, (snap) => {
    const v = snap.val() || {};
    state.allUsers = Object.entries(v).map(([uid, data]) => ({ uid, ...data }));
    renderCurrentView();
  });
  // Todos los picks
  const r3 = ref(db, "picks");
  const h3 = onValue(r3, (snap) => {
    const v = snap.val() || {};
    state.allPicks = {};
    state.allExtras = {};
    for (const [uid, data] of Object.entries(v)) {
      state.allPicks[uid] = data.matches || {};
      state.allExtras[uid] = {
        champion: data.champion || null,
        topScorer: data.topScorer || null
      };
    }
    if (state.allPicks[state.user.uid]) state.myPicks = state.allPicks[state.user.uid];
    if (state.allExtras[state.user.uid]) state.myExtras = state.allExtras[state.user.uid];
    renderCurrentView();
  });
  state.unsubs = [
    () => off(r1, "value", h1),
    () => off(r2, "value", h2),
    () => off(r3, "value", h3)
  ];
}

function cleanupSubscriptions() {
  state.unsubs.forEach(u => { try { u(); } catch(e){} });
  state.unsubs = [];
}

// ===================== VIEW ROUTING =====================
document.querySelectorAll(".nav button").forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

function showView(view) {
  state.view = view;
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $(view + "View").classList.remove("hidden");
  document.querySelectorAll(".nav button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  renderCurrentView();
}

function renderCurrentView() {
  if (!state.user) return;
  if (state.view === "picks") renderPicks();
  if (state.view === "standings") renderStandings();
  if (state.view === "others") renderOthers();
  if (state.view === "stats") renderStats();
  if (state.view === "extras") renderExtras();
  if (state.view === "admin") renderAdmin();
}

// ===================== PICKS VIEW =====================
const phaseFilter = $("phaseFilter");
const hideLocked = $("hideLocked");
phaseFilter.addEventListener("change", renderPicks);
hideLocked.addEventListener("change", renderPicks);

function renderPicks() {
  const container = $("matchList");
  container.innerHTML = "";
  const filterPhase = phaseFilter.value;
  const hideLockedOn = hideLocked.checked;

  const filtered = MATCHES.filter(m =>
    (filterPhase === "all" || m.phase === filterPhase)
  );

  const byDate = {};
  for (const m of filtered) {
    if (!byDate[m.date]) byDate[m.date] = [];
    byDate[m.date].push(m);
  }

  const sortedDates = Object.keys(byDate).sort();
  for (const date of sortedDates) {
    const locked = isDayLocked(date);
    if (hideLockedOn && locked) continue;

    const dayMatches = byDate[date];
    const header = el("div", "day-header" + (locked ? " locked" : ""));
    header.textContent = formatDate(date) +
      (locked ? " · CERRADO" : ` · cierre ${formatTime(dayDeadline(date))}`);
    container.appendChild(header);

    for (const m of dayMatches) {
      container.appendChild(renderMatchCard(m, locked));
    }
  }
  if (container.children.length === 0) {
    container.innerHTML = `<p class="hint">No hay partidos para mostrar con este filtro.</p>`;
  }
}

function renderMatchCard(m, dayLocked) {
  const card = el("div", "match-card");

  const pick = state.myPicks[m.id] || {};
  const result = state.results[m.id] || {};
  const hasResult = result.home != null && result.away != null;
  // Si ya hay resultado oficial cargado, el pick no se puede editar más (aunque el día siga abierto)
  const locked = dayLocked || hasResult;
  if (locked) card.classList.add("locked");

  const score = hasResult ? scoreMatch(result.home, result.away, pick.home, pick.away) : null;
  if (score) {
    if (score.kind === "pleno") card.classList.add("pleno");
    else if (score.kind === "correct") card.classList.add("correct");
  }

  const meta = el("div", "match-meta");
  const left = el("span"); left.textContent = `${m.phaseLabel}${m.group ? ` · Grupo ${m.group}` : ""}`;
  const right = el("span"); right.textContent = matchMetaLabel(m);
  meta.appendChild(left); meta.appendChild(right);

  const homeTeam = el("div", "team home"); homeTeam.textContent = matchHome(m);
  const awayTeam = el("div", "team away"); awayTeam.textContent = matchAway(m);

  const homeInput = el("input", "score-input");
  homeInput.type = "number"; homeInput.min = "0"; homeInput.max = "20";
  homeInput.value = pick.home != null ? pick.home : "";
  homeInput.placeholder = hasResult ? result.home : "·";
  homeInput.disabled = locked;

  const awayInput = el("input", "score-input");
  awayInput.type = "number"; awayInput.min = "0"; awayInput.max = "20";
  awayInput.value = pick.away != null ? pick.away : "";
  awayInput.placeholder = hasResult ? result.away : "·";
  awayInput.disabled = locked;

  const vs = el("div", "vs"); vs.textContent = "vs";

  const pointsBox = el("div", "points " + (score ? score.kind : "miss"));
  if (hasResult) {
    pointsBox.textContent = `${score.pts}`;
    pointsBox.title = `Oficial: ${result.home}-${result.away}`;
  } else {
    pointsBox.textContent = "-";
    pointsBox.classList.add("miss");
  }

  const saveState = el("div", "save-state");
  if (hasResult) {
    saveState.textContent = "Cerrado (resultado cargado)";
    saveState.classList.add("locked");
  } else if (dayLocked) {
    saveState.textContent = "Cerrado";
    saveState.classList.add("locked");
  } else if (pick.home != null && pick.away != null) {
    saveState.textContent = "Guardado";
    saveState.classList.add("saved");
  }

  card.appendChild(meta);
  card.appendChild(homeTeam);
  card.appendChild(homeInput);
  card.appendChild(vs);
  card.appendChild(awayInput);
  card.appendChild(awayTeam);
  card.appendChild(pointsBox);
  card.appendChild(saveState);

  let saveTimer;
  function onChange() {
    if (locked) return;
    saveState.textContent = "Guardando…";
    saveState.className = "save-state saving";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePick(m.id, homeInput.value, awayInput.value, saveState), 500);
  }
  homeInput.addEventListener("input", onChange);
  awayInput.addEventListener("input", onChange);

  return card;
}

async function savePick(matchId, home, away, saveState) {
  try {
    const h = home === "" ? null : Math.max(0, parseInt(home, 10));
    const a = away === "" ? null : Math.max(0, parseInt(away, 10));

    const matchRef = ref(db, `picks/${state.user.uid}/matches/${matchId}`);
    if (h == null && a == null) {
      await set(matchRef, null);
    } else {
      await set(matchRef, { home: h, away: a });
    }
    await update(ref(db, `picks/${state.user.uid}`), {
      lastUpdate: serverTimestamp()
    });

    saveState.textContent = "Guardado";
    saveState.className = "save-state saved";
  } catch (e) {
    saveState.textContent = "Error";
    saveState.className = "save-state locked";
    toast("Error al guardar: " + e.message, "err");
  }
}

// ===================== STANDINGS =====================
const ENTRY_FEE = 50000;     // pesos argentinos por persona
const THIRD_PRIZE = 50000;   // premio fijo para el 3ro si llega

function computePrizes(numPlayers) {
  const pot = numPlayers * ENTRY_FEE;
  // intento 1: 3° = 50k, 2° = 20% del resto, 1° = 80% del resto
  const remaining = pot - THIRD_PRIZE;
  const secondTentative = remaining * 0.20;
  if (secondTentative > THIRD_PRIZE) {
    return {
      pot,
      first: remaining * 0.80,
      second: secondTentative,
      third: THIRD_PRIZE
    };
  }
  // intento 2: 3° no cobra, split 80/20 del pozo entero
  return {
    pot,
    first: pot * 0.80,
    second: pot * 0.20,
    third: 0
  };
}

function formatARS(n) {
  return "$" + Math.round(n).toLocaleString("es-AR");
}

function renderStandings() {
  const tbody = document.querySelector("#standingsTable tbody");
  tbody.innerHTML = "";
  const rows = state.allUsers.map(u => {
    const { pts, plenos } = totalPointsForUser(u.uid);
    return { ...u, pts, plenos };
  });
  rows.sort((a, b) => b.pts - a.pts || b.plenos - a.plenos);

  const total = rows.length;
  const prizes = computePrizes(total);

  // Banner de pozo arriba de la tabla
  const potInfo = document.getElementById("potInfo");
  if (potInfo) {
    if (total === 0) {
      potInfo.innerHTML = "";
    } else {
      potInfo.innerHTML = `
        <div class="pot-card">
          <div class="pot-row">
            <span>Pozo total</span>
            <strong>${formatARS(prizes.pot)}</strong>
            <span class="muted">(${total} × ${formatARS(ENTRY_FEE)})</span>
          </div>
          <div class="pot-prizes">
            <div class="pot-prize p1"><span>🏆 1°</span><strong>${formatARS(prizes.first)}</strong></div>
            <div class="pot-prize p2"><span>🥈 2°</span><strong>${formatARS(prizes.second)}</strong></div>
            <div class="pot-prize p3"><span>🥉 3°</span><strong>${prizes.third > 0 ? formatARS(prizes.third) : "—"}</strong></div>
          </div>
          ${prizes.third === 0 ? `<p class="pot-note">⚠️ Con ${total} jugador${total !== 1 ? "es" : ""} el pozo no alcanza para que el 3° cobre $50.000, así que el premio va completo al 1° y 2°.</p>` : ""}
        </div>
      `;
    }
  }

  rows.forEach((r, i) => {
    const tr = el("tr");
    const pos = i + 1;
    let label = "";
    let prize = "";
    if (pos === 1) {
      tr.classList.add("row-champ"); label = "🏆 Campeón";
      prize = formatARS(prizes.first);
    } else if (pos === 2) {
      tr.classList.add("row-sub"); label = "🥈 Subcampeón";
      prize = formatARS(prizes.second);
    } else if (pos === 3) {
      label = "🥉 Tercero";
      prize = prizes.third > 0 ? formatARS(prizes.third) : "—";
    } else if (total >= 5 && pos >= total - 2 && pos <= total - 1) {
      tr.classList.add("row-prom"); label = "Promoción";
    } else if (total >= 4 && pos === total) {
      tr.classList.add("row-desc"); label = "Descenso";
    }

    const displayName = r.nickname || r.name || r.email;
    const avatarSmall = avatarHtml(r.email, r.photoURL, displayName, 32, true);
    tr.innerHTML = `
      <td>${pos}</td>
      <td><div class="user-cell">${avatarSmall}<span>${escapeHtml(displayName)}</span></div></td>
      <td><strong>${r.pts}</strong></td>
      <td>${r.plenos}</td>
      <td>${label}</td>
      <td><strong>${prize}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="hint" style="padding:20px;text-align:center">Todavía no hay jugadores. Compartiles el link a tus amigos para que entren con Google.</td></tr>`;
  }
}

// ===================== OTROS =====================
function renderOthers() {
  const container = $("othersList");
  container.innerHTML = "";

  const byDate = {};
  for (const m of MATCHES) {
    if (!byDate[m.date]) byDate[m.date] = [];
    byDate[m.date].push(m);
  }
  const sortedDates = Object.keys(byDate).sort();

  let any = false;
  for (const date of sortedDates) {
    const dayMatches = byDate[date];
    const locked = isDayLocked(date);
    const myPicksOfDay = dayMatches.every(m => state.myPicks[m.id]);
    const canSee = locked || myPicksOfDay;

    const dayDiv = el("div", "others-day");
    const h = el("h3");
    h.textContent = formatDate(date) + (locked ? " · cerrado" : (canSee ? " · ya cargaste tus picks" : ""));
    dayDiv.appendChild(h);

    if (!canSee) {
      const info = el("div", "locked-info");
      info.textContent = `Cargá tus pronósticos de los ${dayMatches.length} partidos del día para poder ver los del resto.`;
      dayDiv.appendChild(info);
      container.appendChild(dayDiv);
      any = true;
      continue;
    }

    const grid = el("div", "others-grid");
    for (const m of dayMatches) {
      const card = el("div", "other-match");
      const title = el("div", "om-title");
      const tAR = matchTimeAR(m);
      title.textContent = (tAR ? `${tAR} hs \u00B7 ` : "") + `${matchHome(m)} vs ${matchAway(m)}` + (state.results[m.id] ? ` (${state.results[m.id].home}-${state.results[m.id].away})` : "");
      card.appendChild(title);
      const tbl = el("table");
      for (const u of state.allUsers) {
        const p = (state.allPicks[u.uid] || {})[m.id];
        const tr = el("tr");
        const displayName = u.nickname || u.name || u.email;
        const nameTd = el("td");
        nameTd.innerHTML = `<div class="user-cell">${avatarHtml(u.email, u.photoURL, displayName, 24, true)}<span>${escapeHtml(displayName)}</span></div>`;
        const pickTd = el("td");
        if (p) pickTd.textContent = `${p.home}-${p.away}`;
        else { pickTd.textContent = "—"; pickTd.style.color = "var(--muted)"; }
        tr.appendChild(nameTd); tr.appendChild(pickTd);
        tbl.appendChild(tr);
      }
      card.appendChild(tbl);
      grid.appendChild(card);
    }
    dayDiv.appendChild(grid);
    container.appendChild(dayDiv);
    any = true;
  }
  if (!any) {
    container.innerHTML = `<p class="hint">Todavía no hay días para mostrar.</p>`;
  }
}

// ===================== STATS / COMPARACIÓN =====================
// Calcula stats detalladas para un usuario
function computeStats(uid) {
  const picks = state.allPicks[uid] || {};
  const extras = state.allExtras[uid] || {};
  let total = 0, plenos = 0, signCorrect = 0, picksLoaded = 0, picksScored = 0;
  const byPhase = {};
  const byDate = {};
  for (const m of MATCHES) {
    const p = picks[m.id];
    const r = state.results[m.id];
    if (p) picksLoaded++;
    if (!r || !p) continue;
    const s = scoreMatch(r.home, r.away, p.home, p.away);
    if (s.kind === "pending") continue;
    picksScored++;
    total += s.pts;
    if (s.kind === "pleno") plenos++;
    if (s.kind === "correct") signCorrect++;
    if (!byPhase[m.phase]) byPhase[m.phase] = { pts: 0, plenos: 0, signCorrect: 0, scored: 0, label: m.phaseLabel };
    byPhase[m.phase].pts += s.pts;
    byPhase[m.phase].scored++;
    if (s.kind === "pleno") byPhase[m.phase].plenos++;
    if (s.kind === "correct") byPhase[m.phase].signCorrect++;
    if (!byDate[m.date]) byDate[m.date] = { pts: 0, plenos: 0, scored: 0 };
    byDate[m.date].pts += s.pts;
    byDate[m.date].scored++;
    if (s.kind === "pleno") byDate[m.date].plenos++;
  }
  // Mejor / peor día (solo días con al menos un partido scoreado)
  const dayList = Object.entries(byDate).filter(([, d]) => d.scored > 0);
  let bestDay = null, worstDay = null;
  if (dayList.length) {
    dayList.sort((a, b) => b[1].pts - a[1].pts);
    bestDay = { date: dayList[0][0], ...dayList[0][1] };
    worstDay = { date: dayList[dayList.length - 1][0], ...dayList[dayList.length - 1][1] };
  }
  // Racha activa: días consecutivos con al menos 1 punto
  const sortedDates = Object.keys(byDate).sort();
  let streak = 0;
  for (let i = sortedDates.length - 1; i >= 0; i--) {
    if (byDate[sortedDates[i]].pts > 0) streak++;
    else break;
  }
  // Extras
  let championPts = 0, scorerPts = 0;
  if (state.finals.champion && extras.champion === state.finals.champion) championPts = 10;
  if (state.finals.topScorer && extras.topScorer && normalize(extras.topScorer) === normalize(state.finals.topScorer)) scorerPts = 10;
  total += championPts + scorerPts;
  return {
    total, plenos, signCorrect, picksLoaded, picksScored,
    plenoRate: picksScored ? (plenos / picksScored * 100) : 0,
    correctRate: picksScored ? ((plenos + signCorrect) / picksScored * 100) : 0,
    byPhase, bestDay, worstDay, streak,
    extras: { champion: extras.champion, topScorer: extras.topScorer, championPts, scorerPts }
  };
}

function renderStats() {
  // Llenar selectores
  const selA = $("statsUserA"), selB = $("statsUserB");
  const userOptions = state.allUsers
    .map(u => ({ uid: u.uid, label: u.nickname || u.name || u.email }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const currentA = selA.value || state.user.uid;
  const currentB = selB.value || "";
  selA.innerHTML = userOptions.map(u => `<option value="${u.uid}">${escapeHtml(u.label)}</option>`).join("");
  selB.innerHTML = `<option value="">— sin comparar —</option>` +
    userOptions.map(u => `<option value="${u.uid}">${escapeHtml(u.label)}</option>`).join("");
  selA.value = currentA;
  selB.value = currentB;
  selA.onchange = renderStats;
  selB.onchange = renderStats;

  const uidA = selA.value;
  const uidB = selB.value;
  const userA = state.allUsers.find(u => u.uid === uidA);
  if (!userA) {
    $("statsContent").innerHTML = `<p class="hint">Elegí un jugador.</p>`;
    return;
  }
  const statsA = computeStats(uidA);

  let html = `<div class="stats-section">` +
    renderUserStatsBlock(userA, statsA) +
    `</div>`;

  if (uidB) {
    const userB = state.allUsers.find(u => u.uid === uidB);
    if (userB && uidB !== uidA) {
      const statsB = computeStats(uidB);
      html += `<div class="stats-section">` +
        renderUserStatsBlock(userB, statsB) +
        `</div>`;
      html += renderHeadToHead(userA, userB, statsA, statsB);
    }
  }
  $("statsContent").innerHTML = html;
}

function renderUserStatsBlock(user, s) {
  const displayName = user.nickname || user.name || user.email;
  const avatar = avatarHtml(user.email, user.photoURL, displayName, 56, true);
  const byPhaseRows = Object.entries(s.byPhase)
    .map(([, d]) => `<tr><td>${escapeHtml(d.label)}</td><td>${d.scored}</td><td><strong>${d.pts}</strong></td><td>${d.plenos}</td><td>${d.signCorrect}</td></tr>`)
    .join("") || `<tr><td colspan="5" class="muted">Sin datos aún</td></tr>`;

  return `
    <div class="stats-user-header">
      ${avatar}
      <div>
        <h3>${escapeHtml(displayName)}</h3>
        <p class="muted">${escapeHtml(user.email)}</p>
      </div>
    </div>
    <div class="stats-cards">
      <div class="stat-card"><span class="stat-label">Puntos totales</span><strong>${s.total}</strong></div>
      <div class="stat-card"><span class="stat-label">Plenos</span><strong>${s.plenos}</strong></div>
      <div class="stat-card"><span class="stat-label">Picks cargados</span><strong>${s.picksLoaded} / ${MATCHES.length}</strong></div>
      <div class="stat-card"><span class="stat-label">% aciertos</span><strong>${s.correctRate.toFixed(0)}%</strong></div>
      <div class="stat-card"><span class="stat-label">% plenos</span><strong>${s.plenoRate.toFixed(0)}%</strong></div>
      <div class="stat-card"><span class="stat-label">Racha activa</span><strong>${s.streak} día${s.streak !== 1 ? "s" : ""}</strong></div>
    </div>
    ${s.bestDay ? `<p class="hint">🏅 <strong>Mejor día:</strong> ${formatDate(s.bestDay.date)} con ${s.bestDay.pts} pts (${s.bestDay.plenos} plenos)</p>` : ""}
    ${s.worstDay && s.bestDay && s.worstDay.date !== s.bestDay.date ? `<p class="hint">💩 <strong>Peor día:</strong> ${formatDate(s.worstDay.date)} con ${s.worstDay.pts} pts</p>` : ""}
    ${s.extras.championPts > 0 ? `<p class="hint">🏆 Acertó campeón: <strong>${escapeHtml(s.extras.champion)}</strong> (+10 pts)</p>` : ""}
    ${s.extras.scorerPts > 0 ? `<p class="hint">⚽ Acertó goleador: <strong>${escapeHtml(s.extras.topScorer)}</strong> (+10 pts)</p>` : ""}
    <h4>Desglose por fase</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Fase</th><th>Part.</th><th>Pts</th><th>Plenos</th><th>Aciertos</th></tr></thead>
        <tbody>${byPhaseRows}</tbody>
      </table>
    </div>
  `;
}

function renderHeadToHead(userA, userB, sA, sB) {
  const picksA = state.allPicks[userA.uid] || {};
  const picksB = state.allPicks[userB.uid] || {};
  let agreed = 0, differed = 0, bothScored = 0;
  let aBeatsB = 0, bBeatsA = 0, tie = 0;
  for (const m of MATCHES) {
    const pa = picksA[m.id];
    const pb = picksB[m.id];
    if (!pa || !pb) continue;
    if (pa.home === pb.home && pa.away === pb.away) agreed++;
    else differed++;
    const r = state.results[m.id];
    if (!r) continue;
    bothScored++;
    const sa = scoreMatch(r.home, r.away, pa.home, pa.away).pts;
    const sb = scoreMatch(r.home, r.away, pb.home, pb.away).pts;
    if (sa > sb) aBeatsB++;
    else if (sb > sa) bBeatsA++;
    else tie++;
  }
  const nameA = escapeHtml(userA.nickname || userA.name || userA.email);
  const nameB = escapeHtml(userB.nickname || userB.name || userB.email);

  return `
    <div class="stats-section h2h-section">
      <h3>⚔️ Mano a mano: ${nameA} vs ${nameB}</h3>
      <div class="stats-cards">
        <div class="stat-card"><span class="stat-label">Pronósticos idénticos</span><strong>${agreed}</strong></div>
        <div class="stat-card"><span class="stat-label">Pronósticos distintos</span><strong>${differed}</strong></div>
        <div class="stat-card"><span class="stat-label">Diferencia de pts</span><strong>${sA.total - sB.total > 0 ? "+" : ""}${sA.total - sB.total}</strong></div>
      </div>
      <div class="h2h-bar">
        <div class="h2h-a" style="flex:${aBeatsB || 0.1}" title="${nameA}: ${aBeatsB}">${aBeatsB}</div>
        <div class="h2h-tie" style="flex:${tie || 0.1}" title="Empates: ${tie}">${tie}</div>
        <div class="h2h-b" style="flex:${bBeatsA || 0.1}" title="${nameB}: ${bBeatsA}">${bBeatsA}</div>
      </div>
      <p class="hint">Partidos donde cada uno superó al otro en puntos (sobre ${bothScored} partidos con resultado).</p>
    </div>
  `;
}

// ===================== EXTRAS =====================
function renderExtras() {
  const champSel = $("champSelect");
  const scorerIn = $("scorerInput");
  const deadlineP = $("extrasDeadline");
  const locked = isExtrasLocked();

  champSel.innerHTML = `<option value="">— elegí un equipo —</option>` +
    ALL_TEAMS.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  champSel.value = state.myExtras.champion || "";
  scorerIn.value = state.myExtras.topScorer || "";

  champSel.disabled = locked;
  scorerIn.disabled = locked;
  $("saveExtras").disabled = locked;

  deadlineP.textContent = locked
    ? "Cerrado. Ya arrancó el torneo."
    : `Cierre: inicio del primer partido del torneo (${formatDateTime(TOURNAMENT_START_UTC)}).`;

  $("saveExtras").onclick = async () => {
    try {
      await update(ref(db, `picks/${state.user.uid}`), {
        champion: champSel.value || null,
        topScorer: scorerIn.value.trim() || null,
        lastUpdate: serverTimestamp()
      });
      $("extrasStatus").className = "status ok";
      $("extrasStatus").textContent = "Guardado.";
    } catch (e) {
      $("extrasStatus").className = "status err";
      $("extrasStatus").textContent = "Error: " + e.message;
    }
  };
}

// ===================== ADMIN =====================
document.querySelectorAll(".admin-tabs button").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".admin-tabs button").forEach(x => x.classList.toggle("active", x === b));
    document.querySelectorAll(".admin-pane").forEach(p => p.classList.add("hidden"));
    $("admin" + cap(b.dataset.admintab)).classList.remove("hidden");
    if (b.dataset.admintab === "members") renderAdminMembers();
  });
});

function renderAdmin() {
  if (!state.user?.isAdmin) {
    $("adminView").innerHTML = `<p class="hint">No tenés permisos.</p>`;
    return;
  }
  renderAdminResults();
  renderAdminFinals();
  // Conectar botón sync (una sola vez)
  const btn = $("syncBtn");
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => syncFromAPI(true));
  }
  updateSyncStatusUI();
}

function renderAdminResults() {
  const c = $("adminMatchList");
  c.innerHTML = "";
  const byDate = {};
  for (const m of MATCHES) {
    if (!byDate[m.date]) byDate[m.date] = [];
    byDate[m.date].push(m);
  }
  Object.keys(byDate).sort().forEach(date => {
    const h = el("div", "day-header");
    h.textContent = formatDate(date);
    c.appendChild(h);
    for (const m of byDate[date]) {
      const card = el("div", "match-card");
      const meta = el("div", "match-meta");
      meta.innerHTML = `<span>${m.phaseLabel}${m.group ? ` · Grupo ${m.group}` : ""}</span><span>${m.id}</span>`;

      const home = el("div", "team home"); home.textContent = matchHome(m);
      const away = el("div", "team away"); away.textContent = matchAway(m);
      const hi = el("input", "score-input"); hi.type = "number"; hi.min = "0"; hi.max = "20";
      const ai = el("input", "score-input"); ai.type = "number"; ai.min = "0"; ai.max = "20";
      const r = state.results[m.id];
      if (r) { hi.value = r.home; ai.value = r.away; hi.classList.add("official"); ai.classList.add("official"); }
      const vs = el("div", "vs"); vs.textContent = "vs";
      const pts = el("div", "points"); pts.textContent = r ? "✓" : "—";
      const save = el("div", "save-state");

      card.appendChild(meta);
      card.appendChild(home); card.appendChild(hi); card.appendChild(vs);
      card.appendChild(ai); card.appendChild(away); card.appendChild(pts); card.appendChild(save);

      let t;
      const onChange = () => {
        save.textContent = "Guardando…"; save.className = "save-state saving";
        clearTimeout(t);
        t = setTimeout(async () => {
          try {
            const matchRef = ref(db, `tournament/results/${m.id}`);
            const h = hi.value === "" ? null : parseInt(hi.value, 10);
            const a = ai.value === "" ? null : parseInt(ai.value, 10);
            if (h == null && a == null) {
              await set(matchRef, null);
            } else {
              await set(matchRef, { home: h, away: a });
            }
            await update(ref(db, "tournament"), { lastUpdate: serverTimestamp() });
            save.textContent = "Guardado"; save.className = "save-state saved";
          } catch (e) {
            save.textContent = "Error"; save.className = "save-state locked";
            toast(e.message, "err");
          }
        }, 400);
      };
      hi.addEventListener("input", onChange);
      ai.addEventListener("input", onChange);
      c.appendChild(card);
    }
  });
}

function renderAdminFinals() {
  const champ = $("adminChamp");
  champ.innerHTML = `<option value="">—</option>` +
    ALL_TEAMS.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
  champ.value = state.finals.champion || "";
  $("adminScorer").value = state.finals.topScorer || "";
  $("adminSaveFinals").onclick = async () => {
    try {
      await update(ref(db, "tournament"), {
        champion: champ.value || null,
        topScorer: $("adminScorer").value.trim() || null,
        lastUpdate: serverTimestamp()
      });
      $("adminFinalsStatus").className = "status ok";
      $("adminFinalsStatus").textContent = "Guardado.";
    } catch (e) {
      $("adminFinalsStatus").className = "status err";
      $("adminFinalsStatus").textContent = e.message;
    }
  };
}

function renderAdminMembers() {
  const tbody = document.querySelector("#membersTable tbody");
  tbody.innerHTML = "";
  for (const u of state.allUsers) {
    const tr = el("tr");
    const avatarSmall = avatarHtml(u.email, u.photoURL, u.name || u.email, 32, true);
    tr.innerHTML = `<td><div class="user-cell">${avatarSmall}<span>${escapeHtml(u.email)}</span></div></td><td>${escapeHtml(u.name || "")}</td><td><input value="${escapeHtml(u.nickname || "")}" data-uid="${u.uid}" class="nick-input score-input" style="width:auto"></td><td><button class="btn-small" data-uid="${u.uid}">Guardar</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button").forEach(b => {
    b.onclick = async () => {
      const uid = b.dataset.uid;
      const input = tbody.querySelector(`input[data-uid="${uid}"]`);
      try {
        await update(ref(db, `users/${uid}`), { nickname: input.value.trim() });
        toast("Guardado", "ok");
      } catch (e) { toast(e.message, "err"); }
    };
  });
}

// ===================== AVATARES =====================
// Las imágenes están en CARAS/<username>.<jpeg|jpg|png>
// donde <username> es lo que va antes de @gmail.com.
// Probamos las 3 extensiones en orden; si no hay, caemos a la foto de Google;
// si tampoco hay, a un avatar generado con las iniciales.
window.tryAvatar = function(img) {
  const username = img.dataset.username;
  const fallback = img.dataset.fallback;
  const finalFallback = img.dataset.finalFallback;
  const tries = (parseInt(img.dataset.tries, 10) || 0) + 1;
  img.dataset.tries = tries;
  if (tries === 1 && username) { img.src = `CARAS/${username}.jpg`; }
  else if (tries === 2 && username) { img.src = `CARAS/${username}.png`; }
  else if (tries === 3) { img.src = fallback; }
  else { img.onerror = null; img.src = finalFallback; }
};

function avatarUrl(email, googlePhoto, name) {
  // Devuelve la URL inicial (jpeg). El onerror del <img> va probando jpg, png, fallback.
  if (email) {
    const username = email.split("@")[0];
    return { initial: `CARAS/${username}.jpeg`, username };
  }
  return { initial: googlePhoto || initialsDataUrl(name), username: null };
}

function initialsDataUrl(name) {
  const initials = (name || "?").split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
  const colors = ["#4f8cff", "#2ecc71", "#f39c12", "#e74c3c", "#9b59b6", "#1abc9c"];
  const c = colors[(initials.charCodeAt(0) || 0) % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="${c}"/><text x="32" y="40" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="700" fill="white">${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function avatarHtml(email, googlePhoto, name, size, clickable) {
  const { initial, username } = avatarUrl(email, googlePhoto, name);
  const fallback = googlePhoto || initialsDataUrl(name);
  const finalFallback = initialsDataUrl(name);
  const cls = "avatar" + (clickable ? " clickable" : "");
  const sz = size || 32;
  return `<img class="${cls}" src="${initial}"
    data-username="${username || ""}"
    data-fallback="${fallback}"
    data-final-fallback="${finalFallback}"
    data-email="${escapeHtml(email || "")}"
    data-name="${escapeHtml(name || email || "")}"
    onerror="tryAvatar(this)"
    style="width:${sz}px;height:${sz}px"
    alt="">`;
}

// Modal de avatar agrandado al hacer click
document.addEventListener("click", (ev) => {
  const img = ev.target.closest("img.avatar.clickable");
  if (img) {
    openAvatarModal(img);
    return;
  }
  if (ev.target.id === "avatarModal") {
    closeAvatarModal();
  }
});
function openAvatarModal(img) {
  const modal = $("avatarModal");
  const big = $("avatarBig");
  const cap = $("avatarCaption");
  big.src = img.src;
  big.dataset.username = img.dataset.username;
  big.dataset.fallback = img.dataset.fallback;
  big.dataset.tries = img.dataset.tries || "0";
  big.onerror = () => tryAvatar(big);
  cap.textContent = img.dataset.name || "";
  modal.classList.remove("hidden");
}
function closeAvatarModal() {
  $("avatarModal").classList.add("hidden");
}

// ===================== HELPERS =====================
function $(id) { return document.getElementById(id); }
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const TZ_AR = "America/Argentina/Buenos_Aires";
function formatDate(s) {
  const d = new Date(s + "T12:00:00Z");
  return d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}
function formatTime(ms) {
  return new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ_AR });
}
function formatDateTime(iso) {
  return new Date(iso).toLocaleString("es-AR", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ_AR
  });
}
// Hora del partido en hora argentina. Si por el huso cae en otro dia que el
// "dia FIFA" del fixture, se aclara el dia (ej: "dom 01:00").
function matchTimeAR(m) {
  if (!m.datetime) return "";
  const d = new Date(m.datetime);
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ_AR });
  const dateAR = d.toLocaleDateString("sv-SE", { timeZone: TZ_AR }); // YYYY-MM-DD
  if (dateAR !== m.date) {
    const wd = d.toLocaleDateString("es-AR", { weekday: "short", timeZone: TZ_AR });
    return `${wd} ${time}`;
  }
  return time;
}
function matchMetaLabel(m) {
  const parts = [];
  const t = matchTimeAR(m);
  if (t) parts.push(`\u{1F550} ${t} hs`);
  if (m.venue) parts.push(m.venue);
  return parts.join(" \u00B7 ");
}
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + (kind || "");
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 3000);
}

setInterval(() => { if (state.user && state.view === "picks") renderPicks(); }, 60000);

// ===================== THESPORTSDB SYNC =====================
// Usamos TheSportsDB (gratis, sin clave) porque api-football no incluye 2026 en free.
const TSDB_KEY = "3";       // free key pública
const TSDB_LEAGUE = 4429;   // FIFA World Cup
const TSDB_SEASON = "2026";

// Algunas selecciones tienen nombres ligeramente distintos. Mapeo manual.
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
function normalizeTeam(name) {
  return (name || "").toString().toLowerCase().trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function aliasTeam(apiName) {
  const k = normalizeTeam(apiName);
  return TEAM_ALIASES[k] || apiName;
}

const isPlaceholder = (s) => /grupo|group|winner|runner|mejor|best|tbd|tba/i.test(s || "");

function phaseFromRound(round, group) {
  const r = (round || "").toString().toLowerCase();
  const g = (group || "").toString().toLowerCase();
  if (g && /^[a-l]$/i.test(g)) return "group";
  if (r.includes("32") || r.includes("round of 32")) return "round_of_32";
  if (r.includes("16") || r.includes("round of 16") || r.includes("octav")) return "round_of_16";
  if (r.includes("quarter") || r.includes("cuart")) return "quarterfinal";
  if (r.includes("semi")) return "semifinal";
  if (r.includes("3rd") || r.includes("third") || r.includes("tercer")) return "third_place";
  if (r.includes("final")) return "final";
  const n = parseInt(r, 10);
  if (n >= 125 && n < 200) return "round_of_32";
  if (n >= 200 && n < 250) return "round_of_16";
  if (n >= 250 && n < 300) return "quarterfinal";
  if (n >= 300 && n < 400) return "semifinal";
  if (n >= 400 && n < 500) return "third_place";
  if (n >= 500) return "final";
  return null;
}
function hasResult(evt) {
  return evt.intHomeScore != null && evt.intAwayScore != null
    && evt.intHomeScore !== "" && evt.intAwayScore !== "";
}

let syncInProgress = false;
async function syncFromAPI(manual) {
  if (!state.user?.isAdmin) {
    if (manual) toast("Solo el admin puede sincronizar", "err");
    return;
  }
  if (syncInProgress) return;
  const lastSync = +(localStorage.getItem("lastApiSync") || 0);
  const ageMin = (Date.now() - lastSync) / 60000;
  if (!manual && ageMin < 5) return;

  syncInProgress = true;
  updateSyncStatusUI("Sincronizando…");
  try {
    const resp = await fetch(
      `https://www.thesportsdb.com/api/v1/json/${TSDB_KEY}/eventsseason.php?id=${TSDB_LEAGUE}&s=${TSDB_SEASON}`
    );
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const events = data.events || [];

    let updated = 0, skipped = 0, unmatched = [], bracketUpdates = 0;

    // Buckets de knockout por phase+date
    const knockoutEvents = events
      .filter(e => {
        const ph = phaseFromRound(e.intRound, e.strGroup);
        return ph && ph !== "group";
      })
      .sort((a, b) => new Date(`${a.dateEvent}T${a.strTime || "00:00:00"}`) - new Date(`${b.dateEvent}T${b.strTime || "00:00:00"}`));
    const knockoutByPhaseDate = {};
    for (const e of knockoutEvents) {
      const phase = phaseFromRound(e.intRound, e.strGroup);
      const key = `${phase}|${e.dateEvent}`;
      if (!knockoutByPhaseDate[key]) knockoutByPhaseDate[key] = [];
      knockoutByPhaseDate[key].push(e);
    }
    // Llaves: equipos reales para knockout
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
          const cur = state.teamOverrides[myMatch.id] || {};
          if (cur.home !== apiHome || cur.away !== apiAway) {
            await set(ref(db, `tournament/teamOverrides/${myMatch.id}`), {
              home: apiHome, away: apiAway
            });
            bracketUpdates++;
          }
        }
      }
    }

    // Resultados
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
      if (!candidate) { unmatched.push(`${apiDate} ${apiHome} vs ${apiAway}`); continue; }

      const existing = state.results[candidate.id];
      if (existing && existing.home === homeScore && existing.away === awayScore) {
        skipped++;
        continue;
      }
      await syncOneMatch(candidate.id, homeScore, awayScore);
      updated++;
    }

    localStorage.setItem("lastApiSync", String(Date.now()));
    await update(ref(db, "tournament"), { lastApiSync: Date.now() });

    const summary = `Sync OK. ${updated} resultados, ${bracketUpdates} llaves` +
      (skipped ? `, ${skipped} sin cambios` : "") +
      (unmatched.length ? `, ${unmatched.length} no matcheados` : "");
    updateSyncStatusUI(summary);
    if (manual) toast(summary, "ok");
    if (unmatched.length) console.warn("Partidos no matcheados:", unmatched);
  } catch (e) {
    updateSyncStatusUI("Error: " + e.message);
    if (manual) toast("Error: " + e.message, "err");
    console.error(e);
  } finally {
    syncInProgress = false;
  }
}

async function syncOneMatch(matchId, home, away) {
  await set(ref(db, `tournament/results/${matchId}`), { home, away });
}

function updateSyncStatusUI(msg) {
  const el = $("syncStatus");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
  } else {
    const last = +(localStorage.getItem("lastApiSync") || 0);
    if (!last) { el.textContent = "Sin sincronizar aún"; return; }
    const ageMin = Math.round((Date.now() - last) / 60000);
    el.textContent = `Última sync: hace ${ageMin} min`;
  }
}

// Auto-sync cuando el admin abre la web (con throttle de 5 min adentro de syncFromAPI)
function maybeAutoSync() {
  if (state.user?.isAdmin) syncFromAPI(false);
}
// Refrescar el status cada minuto
setInterval(() => updateSyncStatusUI(), 60000);

// Background polling: cada 20 min mientras haya una pestaña abierta como admin.
// Funciona incluso con la pestaña minimizada o en segundo plano (los timers se
// throttean a 1/min pero 20 min sigue ejecutándose). Throttle interno de 5 min en
// syncFromAPI evita dobles llamadas. Cuota api-football: 100/día → 72 polls/día
// con este intervalo, más espacio para syncs manuales y al abrir página.
const BACKGROUND_POLL_MS = 20 * 60 * 1000; // 20 minutos
setInterval(() => {
  // Forzamos saltar el throttle del syncFromAPI con manual=true ya que el
  // background poll YA es el throttle.
  if (state.user?.isAdmin) {
    const last = +(localStorage.getItem("lastApiSync") || 0);
    if (Date.now() - last >= BACKGROUND_POLL_MS - 30000) {
      syncFromAPI(true);
    }
  }
}, BACKGROUND_POLL_MS);

// Cuando la pestaña vuelve a estar visible (alguien la enfocó después de un rato),
// hacé un sync rápido para que la info esté fresca.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.user?.isAdmin) {
    syncFromAPI(false);
  }
});

// Aviso si la config no fue editada
if (FIREBASE_CONFIG.apiKey === "REEMPLAZAR") {
  document.body.innerHTML = `<div style="padding:40px;text-align:center;color:#e6edf7;font-family:sans-serif;background:#0b1220;min-height:100vh">
    <h1>⚙️ Falta configurar Firebase</h1>
    <p>Editá <code>config.js</code> y completá las credenciales antes de usar la web.</p>
    <p>Mirá <code>README.md</code> para el paso a paso.</p>
  </div>`;
}
