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
  unsubs: [],
  entered: false,        // ya entro a la app (usuario aprobado)
  approvalUnsub: null    // listener del flag de aprobacion
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
  // Pick a medias (un solo lado cargado): el lado vacío cuenta como 0
  if (predHome == null && predAway == null) return { pts: 0, kind: "miss" };
  const oH = +officialHome, oA = +officialAway, pH = +(predHome ?? 0), pA = +(predAway ?? 0);
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
$("pendingLogout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    state.user = null;
    state.entered = false;
    if (state.approvalUnsub) { try { state.approvalUnsub(); } catch (e) {} state.approvalUnsub = null; }
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

  // ===== APROBACION DE MIEMBROS =====
  state.entered = false;
  if (state.user.isAdmin) {
    // El admin se auto-aprueba y entra directo
    await update(ref(db, `users/${user.uid}`), { approved: true });
    state.entered = true;
    enterApp();
    return;
  }
  // El resto necesita aprobacion de Gian. Escuchamos el flag en vivo:
  // apenas lo apruebe, la pantalla se desbloquea sola sin recargar.
  const apprRef = ref(db, `users/${user.uid}/approved`);
  const apprHandler = onValue(apprRef, (snap) => {
    const v = snap.val();
    if (v === true) {
      if (!state.entered) { state.entered = true; enterApp(); }
    } else {
      state.entered = false;
      cleanupSubscriptions();
      showPendingScreen(v === false);
    }
  });
  state.approvalUnsub = () => off(apprRef, "value", apprHandler);
});

// Siembra en la DB los deadlines (hora de cierre) de cada partido y de los
// extras. La regla de seguridad de Firebase usa este nodo para rechazar picks
// enviados despues del cierre, aunque todavia no se haya cargado el resultado.
// Se ejecuta solo cuando entra el admin; corre rapido y solo escribe lo que cambio.
async function ensureDeadlines() {
  if (!state.user?.isAdmin) return;
  try {
    const snap = await get(ref(db, "deadlines"));
    const existing = snap.val() || {};
    const updates = {};
    for (const m of MATCHES) {
      const dl = dayDeadline(m.date);
      if (existing[m.id] !== dl) updates[m.id] = dl;
    }
    const extrasDl = new Date(TOURNAMENT_START_UTC).getTime();
    if (existing._extras !== extrasDl) updates._extras = extrasDl;
    if (Object.keys(updates).length) await update(ref(db, "deadlines"), updates);
  } catch (e) {
    console.warn("No se pudieron sembrar los deadlines:", e);
  }
}

// Copia MIS picks/extras a los nodos espejo (picksByMatch / extras) para los que
// se hayan cargado antes de existir el espejo. Cada uno espeja lo suyo, porque ni
// el admin puede leer los picks ajenos. Solo escribe lo que todavia esta abierto
// (antes del cierre); idempotente. Corre al entrar cualquier usuario.
async function mirrorMyPicks() {
  if (!state.user) return;
  try {
    const snap = await get(ref(db, `picks/${state.user.uid}`));
    const data = snap.val() || {};
    const matches = data.matches || {};
    const updates = {};
    for (const [mid, p] of Object.entries(matches)) {
      if (!p || (p.home == null && p.away == null)) continue;
      const m = MATCHES.find(x => x.id === mid);
      if (!m || Date.now() >= dayDeadline(m.date)) continue; // ya cerrado: no se puede escribir
      updates[`picksByMatch/${mid}/${state.user.uid}`] = { home: p.home ?? null, away: p.away ?? null };
    }
    if ((data.champion || data.topScorer) && Date.now() < new Date(TOURNAMENT_START_UTC).getTime()) {
      updates[`extras/${state.user.uid}`] = { champion: data.champion || null, topScorer: data.topScorer || null };
    }
    if (Object.keys(updates).length) await update(ref(db), updates);
  } catch (e) {
    console.warn("No se pudieron espejar mis picks:", e);
  }
}

async function enterApp() {
  $("nav").classList.remove("hidden");
  if (state.user.isAdmin) {
    $("adminTab").classList.remove("hidden");
    await ensureDeadlines();
  } else {
    $("adminTab").classList.add("hidden");
  }
  await mirrorMyPicks();
  await loadInitialData();
  startSubscriptions();
  showView("picks");
  // Auto-sync de resultados al entrar (solo admin)
  maybeAutoSync();
}

function showPendingScreen(rejected) {
  $("nav").classList.add("hidden");
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("pendingView").classList.remove("hidden");
  $("pendingMsg").textContent = rejected
    ? "Tu solicitud fue rechazada. Si te parece que es un error, habla con Gian."
    : "Tu solicitud le llego a Gian. Cuando te acepte, esta pantalla se desbloquea sola (podes dejarla abierta o volver mas tarde).";
}

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
    state.lastApiSync = v.lastApiSync || 0;
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
    updateAdminPendingBadge();
    // La vista de picks NO depende de la lista de usuarios. Evitamos re-renderizarla
    // cada vez que alguien entra (cada login escribe lastLogin en users): eso era lo
    // que disparaba re-renders constantes mientras la gente cargaba sus pronósticos.
    if (state.view !== "picks") renderCurrentView();
  });
  state.unsubs = [
    () => off(r1, "value", h1),
    () => off(r2, "value", h2)
  ];

  // Mis propios picks (siempre legibles por mi, esten cerrados o no)
  const rMine = ref(db, `picks/${state.user.uid}`);
  const hMine = onValue(rMine, (snap) => {
    const data = snap.val() || {};
    state.myPicks = data.matches || {};
    state.myExtras = { champion: data.champion || null, topScorer: data.topScorer || null };
    state.allPicks[state.user.uid] = state.myPicks;
    state.allExtras[state.user.uid] = state.myExtras;
    renderCurrentView();
  });
  state.unsubs.push(() => off(rMine, "value", hMine));

  // Nadie (ni el admin) puede ver los picks ajenos antes del cierre. Todos leen
  // solo lo que las reglas permiten: picks de partidos ya cerrados + extras una vez
  // iniciado el torneo. El admin es un jugador mas para esto.
  state.subbedMatches = new Set();
  state._extrasSub = false;
  subscribeRevealed();
  state.revealTimer = setInterval(subscribeRevealed, 30000);
  state.unsubs.push(() => { if (state.revealTimer) { clearInterval(state.revealTimer); state.revealTimer = null; } });
}

// Para usuarios normales: engancha listeners a los picks ajenos a medida que cada
// partido cierra (y a los extras cuando arranca el torneo). Idempotente; se llama
// al entrar y cada 30s para tomar lo que se va cerrando sin recargar.
function subscribeRevealed() {
  if (!state.user || !state.subbedMatches) return;
  const now = Date.now();

  // Extras ajenos (campeon/goleador): legibles desde el inicio del torneo.
  const extrasStart = new Date(TOURNAMENT_START_UTC).getTime();
  if (!state._extrasSub && now >= extrasStart) {
    state._extrasSub = true;
    const er = ref(db, "extras");
    const eh = onValue(er, (snap) => {
      const v = snap.val() || {};
      for (const [uid, ex] of Object.entries(v)) {
        if (uid === state.user.uid) continue;
        state.allExtras[uid] = { champion: ex.champion || null, topScorer: ex.topScorer || null };
      }
      renderCurrentView();
    }, () => { state._extrasSub = false; }); // si aun no esta permitido, reintenta luego
    state.unsubs.push(() => off(er, "value", eh));
  }

  // Picks ajenos por partido: legibles al cerrar cada partido (su deadline).
  for (const m of MATCHES) {
    if (state.subbedMatches.has(m.id)) continue;
    if (now < dayDeadline(m.date)) continue;
    state.subbedMatches.add(m.id);
    const r = ref(db, `picksByMatch/${m.id}`);
    const h = onValue(r, (snap) => {
      const v = snap.val() || {};
      for (const [uid, p] of Object.entries(v)) {
        if (uid === state.user.uid) continue;
        if (!state.allPicks[uid]) state.allPicks[uid] = {};
        if (p && (p.home != null || p.away != null)) state.allPicks[uid][m.id] = { home: p.home ?? null, away: p.away ?? null };
        else delete state.allPicks[uid][m.id];
      }
      renderCurrentView();
    }, () => { state.subbedMatches.delete(m.id); }); // desfasaje de reloj: reintenta luego
    state.unsubs.push(() => off(r, "value", h));
  }
}

function cleanupSubscriptions() {
  state.unsubs.forEach(u => { try { u(); } catch(e){} });
  state.unsubs = [];
  if (state.revealTimer) { clearInterval(state.revealTimer); state.revealTimer = null; }
  state.subbedMatches = null;
  state._extrasSub = false;
  state.allPicks = {};
  state.allExtras = {};
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
  // Preservar el input que el usuario esté editando: si justo llega un cambio de
  // Firebase (otro amigo entra, se guarda un pick, etc.) el re-render NO debe borrar
  // lo que está tipeando ni quitarle el foco. Guardamos field+valor sin guardar.
  const active = document.activeElement;
  let editing = null;
  if (active && active.classList && active.classList.contains("score-input") && container.contains(active)) {
    editing = { matchId: active.dataset.matchId, field: active.dataset.field, value: active.value };
  }
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
  // Restaurar foco y el valor que se estaba tipeando antes del re-render.
  if (editing && editing.matchId) {
    const sel = container.querySelector(
      `.score-input[data-match-id="${editing.matchId}"][data-field="${editing.field}"]`
    );
    if (sel && !sel.disabled) {
      sel.value = editing.value;
      sel.focus();
    }
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
  homeInput.dataset.matchId = m.id; homeInput.dataset.field = "home";

  const awayInput = el("input", "score-input");
  awayInput.type = "number"; awayInput.min = "0"; awayInput.max = "20";
  awayInput.value = pick.away != null ? pick.away : "";
  awayInput.placeholder = hasResult ? result.away : "·";
  awayInput.disabled = locked;
  awayInput.dataset.matchId = m.id; awayInput.dataset.field = "away";

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
    const val = (h == null && a == null) ? null : { home: h, away: a };

    // Escritura atómica multi-path: el pick privado, su copia "espejo" (que recién
    // se vuelve legible para los demás al cerrar el partido) y lastUpdate se
    // escriben juntos. O entran todos o no entra ninguno: así no pueden quedar
    // desincronizados (p. ej. si se corta la conexión entre dos escrituras).
    await update(ref(db), {
      [`picks/${state.user.uid}/matches/${matchId}`]: val,
      [`picksByMatch/${matchId}/${state.user.uid}`]: val,
      [`picks/${state.user.uid}/lastUpdate`]: serverTimestamp()
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
  const rows = approvedUsers().map(u => {
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
    // Los picks ajenos recién se revelan cuando arranca el día (cierre). Antes de eso
    // ni siquiera están disponibles para leer (lo imponen las reglas de Firebase),
    // ni para el admin.
    const canSee = locked;

    const dayDiv = el("div", "others-day");
    const h = el("h3");
    h.textContent = formatDate(date) + (locked ? " · cerrado" : "");
    dayDiv.appendChild(h);

    if (!canSee) {
      const info = el("div", "locked-info");
      info.textContent = `Los pronósticos del resto se revelan cuando arranca el primer partido del día (${formatTime(dayDeadline(date))}).`;
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
      for (const u of approvedUsers()) {
        const p = (state.allPicks[u.uid] || {})[m.id];
        const tr = el("tr");
        const displayName = u.nickname || u.name || u.email;
        const nameTd = el("td");
        nameTd.innerHTML = `<div class="user-cell">${avatarHtml(u.email, u.photoURL, displayName, 24, true)}<span>${escapeHtml(displayName)}</span></div>`;
        const pickTd = el("td");
        if (p) pickTd.textContent = `${p.home ?? 0}-${p.away ?? 0}`;
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
  const userOptions = approvedUsers()
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
      const champion = champSel.value || null;
      const topScorer = scorerIn.value.trim() || null;
      await update(ref(db, `picks/${state.user.uid}`), {
        champion, topScorer,
        lastUpdate: serverTimestamp()
      });
      // Copia "espejo" de los extras (se revela al iniciar el torneo)
      await update(ref(db, `extras/${state.user.uid}`), { champion, topScorer });
      $("extrasStatus").className = "status ok";
      $("extrasStatus").textContent = "Guardado.";
    } catch (e) {
      $("extrasStatus").className = "status err";
      $("extrasStatus").textContent = "Error: " + e.message;
    }
  };

  renderAllExtras(locked);
}

// Tabla con el campeon/goleador de todos, visible desde el inicio del torneo
function renderAllExtras(locked) {
  const box = $("extrasAll");
  if (!box) return;
  if (!locked) {
    box.innerHTML = `<p class="hint">Cuando arranque el torneo vas a ver acá el campeón y goleador que eligió cada uno.</p>`;
    return;
  }

  const rows = approvedUsers()
    .map(u => {
      const ex = state.allExtras[u.uid] || {};
      return { ...u, champion: ex.champion || null, topScorer: ex.topScorer || null };
    })
    .sort((a, b) => (a.nickname || a.name || a.email || "").localeCompare(b.nickname || b.name || b.email || ""));

  const champOk = c => state.finals.champion && c === state.finals.champion;
  const scorerOk = s => state.finals.topScorer && s && normalize(s) === normalize(state.finals.topScorer);

  const body = rows.map(r => {
    const displayName = r.nickname || r.name || r.email;
    const avatarSmall = avatarHtml(r.email, r.photoURL, displayName, 32, true);
    const champ = r.champion
      ? `${escapeHtml(r.champion)}${champOk(r.champion) ? " <strong>✅ +10</strong>" : ""}`
      : `<span class="muted">—</span>`;
    const scorer = r.topScorer
      ? `${escapeHtml(r.topScorer)}${scorerOk(r.topScorer) ? " <strong>✅ +10</strong>" : ""}`
      : `<span class="muted">—</span>`;
    return `<tr>
      <td><div class="user-cell">${avatarSmall}<span>${escapeHtml(displayName)}</span></div></td>
      <td>${champ}</td>
      <td>${scorer}</td>
    </tr>`;
  }).join("");

  box.innerHTML = `
    <h3 style="margin-top:24px">Lo que eligió cada uno</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Jugador</th><th>🏆 Campeón</th><th>⚽ Goleador</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
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

// ===================== APROBACION (admin) =====================
function pendingUsers() {
  return state.allUsers.filter(u => u.approved !== true && u.approved !== false);
}

// Solo los miembros aceptados cuentan para el pozo, la tabla, "otros" y stats
function approvedUsers() {
  return state.allUsers.filter(u => u.approved === true);
}

let lastPendingCount = null;
function updateAdminPendingBadge() {
  if (!state.user || !state.user.isAdmin) return;
  const n = pendingUsers().length;
  $("adminTab").textContent = n > 0 ? `Admin (\u{1F514} ${n})` : "Admin";
  if (lastPendingCount != null && n > lastPendingCount) {
    toast(`\u{1F514} Nueva solicitud de acceso (${n} pendiente${n > 1 ? "s" : ""})`, "ok");
  }
  lastPendingCount = n;
}

function setApproval(uid, value) {
  return update(ref(db, `users/${uid}`), { approved: value });
}

function renderAdminMembers() {
  // --- Solicitudes pendientes ---
  const reqBox = $("pendingRequests");
  reqBox.innerHTML = "";
  const pend = pendingUsers();
  if (pend.length > 0) {
    const card = el("div", "requests-card");
    const title = el("h3");
    title.textContent = `\u{1F514} Solicitudes de acceso (${pend.length})`;
    card.appendChild(title);
    for (const u of pend) {
      const row = el("div", "request-row");
      const who = el("div", "user-cell");
      who.innerHTML = `${avatarHtml(u.email, u.photoURL, u.name || u.email, 32, true)}<span>${escapeHtml(u.name || "")} \u00B7 ${escapeHtml(u.email || "")}</span>`;
      const actions = el("div", "request-actions");
      const ok = el("button", "btn-primary btn-small"); ok.textContent = "\u2713 Aceptar";
      const no = el("button", "btn-small"); no.textContent = "\u2715 Rechazar";
      ok.onclick = async () => {
        try { await setApproval(u.uid, true); toast(`${u.name || u.email} aceptado`, "ok"); }
        catch (e) { toast(e.message, "err"); }
      };
      no.onclick = async () => {
        try { await setApproval(u.uid, false); toast(`${u.name || u.email} rechazado`, "ok"); }
        catch (e) { toast(e.message, "err"); }
      };
      actions.appendChild(ok); actions.appendChild(no);
      row.appendChild(who); row.appendChild(actions);
      card.appendChild(row);
    }
    if (pend.length > 1) {
      const all = el("button", "btn-primary btn-small");
      all.textContent = `\u2713 Aceptar todos (${pend.length})`;
      all.style.marginTop = "10px";
      all.onclick = async () => {
        try {
          for (const u of pend) await setApproval(u.uid, true);
          toast("Todos aceptados", "ok");
        } catch (e) { toast(e.message, "err"); }
      };
      card.appendChild(all);
    }
    reqBox.appendChild(card);
  }

  // --- Tabla de miembros ---
  const tbody = document.querySelector("#membersTable tbody");
  tbody.innerHTML = "";
  for (const u of state.allUsers) {
    const tr = el("tr");
    const avatarSmall = avatarHtml(u.email, u.photoURL, u.name || u.email, 32, true);
    const estado = u.approved === true ? "\u2705 Aceptado" : (u.approved === false ? "\u26D4 Rechazado" : "\u23F3 Pendiente");
    const toggleLabel = u.approved === true ? "Bloquear" : "Aceptar";
    tr.innerHTML = `<td><div class="user-cell">${avatarSmall}<span>${escapeHtml(u.email)}</span></div></td><td>${escapeHtml(u.name || "")}</td><td><input value="${escapeHtml(u.nickname || "")}" data-uid="${u.uid}" class="nick-input score-input" style="width:auto"></td><td>${estado}</td><td><button class="btn-small" data-uid="${u.uid}" data-action="nick">Guardar</button> <button class="btn-small" data-uid="${u.uid}" data-action="toggle">${toggleLabel}</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button").forEach(b => {
    b.onclick = async () => {
      const uid = b.dataset.uid;
      try {
        if (b.dataset.action === "toggle") {
          const u = state.allUsers.find(x => x.uid === uid);
          await setApproval(uid, u && u.approved === true ? false : true);
          toast("Guardado", "ok");
        } else {
          const input = tbody.querySelector(`input[data-uid="${uid}"]`);
          await update(ref(db, `users/${uid}`), { nickname: input.value.trim() });
          toast("Guardado", "ok");
        }
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
    const username = email.split("@")[0].toLowerCase();
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

// ===================== SYNC (GitHub Actions → football-data.org) =====================
// El botón ya no llama a una API de fútbol directo (football-data.org no permite
// CORS desde el navegador). En cambio dispara el workflow de GitHub Actions
// (sync.yml), que trae los resultados y los escribe en Firebase. Como la web
// escucha "tournament" en tiempo real, los cambios aparecen solos para todos.
//
// Requiere un token de GitHub (fine-grained, solo Actions:write sobre el repo)
// guardado en Realtime Database en `admin/githubToken` — solo legible por el admin.
const GH_REPO = "giandb96/prode-mundial-2026";
const GH_WORKFLOW = "sync.yml";

let syncInProgress = false;
async function syncFromAPI(manual) {
  if (!state.user?.isAdmin) {
    if (manual) toast("Solo el admin puede sincronizar", "err");
    return;
  }
  if (syncInProgress) return;
  const lastSync = +(localStorage.getItem("lastSyncDispatch") || 0);
  const ageMin = (Date.now() - lastSync) / 60000;
  if (!manual && ageMin < 5) return;

  syncInProgress = true;
  updateSyncStatusUI("Disparando sync…");
  try {
    // 1. Leer el token de GitHub desde la DB (solo el admin tiene permiso)
    const tokenSnap = await get(ref(db, "admin/githubToken"));
    const token = tokenSnap.val();
    if (!token) throw new Error("Falta admin/githubToken en la base");

    // 2. Disparar el workflow
    const resp = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ref: "main" })
      }
    );
    if (resp.status !== 204) {
      const body = await resp.text().catch(() => "");
      throw new Error(`GitHub HTTP ${resp.status} ${body.slice(0, 120)}`);
    }
    localStorage.setItem("lastSyncDispatch", String(Date.now()));

    // 3. Esperar a que el workflow escriba (actualiza tournament/lastApiSync).
    //    Suele tardar 30-60 seg. Los resultados llegan solos por el listener.
    const dispatchedAt = Date.now();
    updateSyncStatusUI("Workflow corriendo… (~30 seg)");
    const ok = await waitForSyncDone(dispatchedAt, 150000);
    if (ok) {
      updateSyncStatusUI();
      if (manual) toast("Sync OK — resultados actualizados", "ok");
    } else {
      updateSyncStatusUI("El workflow no respondió aún (mirá Actions en GitHub)");
      if (manual) toast("Tardó demasiado — revisá Actions en GitHub", "err");
    }
  } catch (e) {
    updateSyncStatusUI("Error: " + e.message);
    if (manual) toast("Error: " + e.message, "err");
    console.error(e);
  } finally {
    syncInProgress = false;
  }
}

// Pollea tournament/lastApiSync hasta que sea posterior al dispatch (o timeout)
async function waitForSyncDone(sinceTs, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const snap = await get(ref(db, "tournament/lastApiSync"));
      if ((snap.val() || 0) >= sinceTs) return true;
    } catch { /* reintenta */ }
  }
  return false;
}

function updateSyncStatusUI(msg) {
  const el = $("syncStatus");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
  } else {
    const last = state.lastApiSync || 0;
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

// Background polling: cada 20 min mientras haya una pestaña abierta como admin,
// dispara el workflow de GitHub (complementa el cron, que GitHub suele demorar).
const BACKGROUND_POLL_MS = 20 * 60 * 1000; // 20 minutos
setInterval(() => {
  // Forzamos saltar el throttle del syncFromAPI con manual=true ya que el
  // background poll YA es el throttle.
  if (state.user?.isAdmin) {
    const last = +(localStorage.getItem("lastSyncDispatch") || 0);
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
