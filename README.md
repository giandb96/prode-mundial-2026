# Prode Mundial 2026

Web para tu prode con amigos. Todo gratis: hosting + base de datos + login con Google.

## Resumen de reglas (idéntico al Excel anterior)

- **Pleno** (marcador exacto) con ≤3 goles → **3 pts**
- **Pleno** con 4+ goles → **suma de goles** del partido (ej: 4-1 = 5 pts)
- **Solo signo correcto** (ganador o empate) → **1 pt**
- **Campeón del Mundial** → **10 pts** (se carga antes del primer partido, después se bloquea)
- **Goleador del Mundial** → **10 pts** (igual)
- **Desempate**: cantidad de plenos
- **Cierre diario**: cuando arranca el primer partido del día se bloquean TODOS los pronósticos de ese día

---

## Paso 1: Crear proyecto Firebase

1. Andá a **https://console.firebase.google.com/** y logueate con tu Google.
2. Click en **"Agregar proyecto"** → nombre: `prode-mundial-2026` (o el que ya creaste) → siguiente → deshabilitá Google Analytics si querés → crear.

## Paso 2: Habilitar login con Google

1. En el menú izquierdo: **"Compilación → Authentication"** → "Comenzar".
2. Pestaña "Método de acceso" → habilitá el proveedor **Google** → poné tu mail como soporte → guardar.

## Paso 3: Crear Realtime Database (NO Firestore)

> 💡 Usamos **Realtime Database** y NO **Firestore Database** porque Firestore ahora requiere tarjeta de crédito. Realtime Database sigue 100% gratis sin tarjeta.

1. En el menú izquierdo: **"Compilación → Realtime Database"** → "Crear base de datos".
2. Ubicación: **"Estados Unidos (us-central1)"** (la única gratis sin tarjeta).
3. Modo: **"Iniciar en modo bloqueado"** → habilitar.
4. Vas a estar dentro de la base. Pasá a la solapa **"Reglas"** (arriba) y pegá EXACTAMENTE el contenido del archivo `database.rules.json` (de esta carpeta). Publicalo.

## Paso 4: Obtener credenciales

1. Click en el engranaje ⚙️ → **"Configuración del proyecto"**.
2. Bajá hasta **"Tus apps"** → si no tenés ninguna, click en **"</> Web"** (ícono de código) → nombre: `prode-web` → registrar.
3. Te va a mostrar un bloque de código con `firebaseConfig`. **Copialo entero.**

## Paso 5: Pegar credenciales en config.js

Abrí el archivo `config.js` y reemplazá los valores `"REEMPLAZAR"` con los que copiaste.

Atento: el campo **`databaseURL`** es obligatorio y termina en `firebaseio.com`. Si Firebase no te lo muestra automáticamente en el config, lo encontrás en la solapa de Realtime Database (es el URL que aparece arriba, tipo `https://prode-mundial-2026-default-rtdb.firebaseio.com`).

Debe quedar algo así:

```js
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "prode-mundial-2026.firebaseapp.com",
  databaseURL: "https://prode-mundial-2026-default-rtdb.firebaseio.com",
  projectId: "prode-mundial-2026",
  storageBucket: "prode-mundial-2026.appspot.com",
  messagingSenderId: "1234567",
  appId: "1:1234:web:abc"
};
```

## Paso 6: Probar local

Para probar antes de subir, abrí una terminal en esta carpeta y corré:

```
npx serve .
```

(necesita Node.js instalado). Te va a dar un link tipo `http://localhost:3000`.

> **Nota**: no podés abrir `index.html` haciendo doble click — Firebase y los módulos ES6 requieren un servidor HTTP.

## Paso 7: Desplegar gratis con Firebase Hosting

1. Instalá la CLI de Firebase (una sola vez):
   ```
   npm install -g firebase-tools
   ```
2. En esta carpeta:
   ```
   firebase login
   firebase init hosting
   ```
   - Elegí el proyecto que creaste
   - Carpeta pública: `.` (un punto, la carpeta actual)
   - ¿SPA?: **No**
   - ¿Sobrescribir `index.html`?: **No**
3. Deploy:
   ```
   firebase deploy --only hosting
   ```

Te va a dar un link tipo `https://prode-mundial-2026.web.app`. Ese es el que compartís con tus amigos.

## Paso 8: Pasarles el link a los amigos

Compartiles `https://prode-mundial-2026.web.app`. Entran con su Google, cargan sus picks, y listo.

---

## Estructura del proyecto

```
prode-web/
├── index.html              # Página principal (HTML)
├── style.css               # Estilos
├── app.js                  # Toda la lógica de la app
├── fixture.js              # 104 partidos del Mundial 2026
├── config.js               # ⚠️ Tus credenciales de Firebase
├── config.example.js       # Plantilla
├── database.rules.json     # Reglas de seguridad de Realtime Database
└── README.md               # Esto
```

## Cosas a saber

- **Solo Gian (gian96db@gmail.com) ve el panel Admin.** Cambiá el email en `config.js` y en `database.rules.json` si querés.
- **Los pronósticos se guardan automáticamente** al escribir un número (no hay botón "guardar" por partido).
- **Después de que arranca el primer partido del día, esos picks no se pueden editar.** Cargalos antes.
- **Para ver los picks de otros**: tenés que haber cargado TODOS los picks del día (o que el día ya haya cerrado).

## Problemas conocidos / mejoras futuras

- Las **fases eliminatorias** (16vos en adelante) tienen partidos con equipos placeholders ("Ganador Grupo X", "2° Grupo Y", etc.) porque dependen de cómo termine la fase de grupos. Cuando se vayan definiendo, hay que actualizar `fixture.js`.
- Si un día tiene partidos sin horario confirmado, el deadline cae a las 3 AM UTC (medianoche en Argentina) del día como fallback.
- **Sin integración de API automática** todavía: vos cargás los resultados desde el panel Admin. Avisame cuando quieras que la sume.
