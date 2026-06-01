# Setup de Sync 24/7 con GitHub Actions

Esto hace que el prode sincronice resultados de api-football solo, cada 20 min, sin que tengas que tener la web abierta.

## Paso 1: Crear repo en GitHub

1. Andá a https://github.com/new
2. Nombre del repo: `prode-mundial-2026` (o el que quieras)
3. **Importante:** privado o público da lo mismo (la api key ya es pública porque está en el código del frontend).
4. NO marques "Add a README" — Lo dejamos vacío
5. Click "Create repository"
6. En la pantalla que sigue, copiá la URL HTTPS (algo tipo `https://github.com/tu-usuario/prode-mundial-2026.git`)

## Paso 2: Subir el código al repo

En la terminal en `prode-web`:

```
git init
git add .
git commit -m "Setup inicial del prode"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/prode-mundial-2026.git
git push -u origin main
```

Reemplazá `TU-USUARIO` por tu usuario de GitHub.

Si GitHub te pide credenciales: usuario + contraseña no funcionan más, tenés que usar un **personal access token**. Para crear uno:
- Andá a https://github.com/settings/tokens/new
- Note: `prode-deploy`
- Expiration: 90 days
- Scopes: marcá `repo`
- Generate → copialo (NO se ve dos veces)
- Cuando git te pida password, pegá el token

## Paso 3: Generar credenciales de Firebase Admin

El sync corre con permisos de admin (no como un usuario logueado), así que necesita un "service account":

1. Andá a https://console.firebase.google.com/project/prodeguanak-mundial-2026/settings/serviceaccounts/adminsdk
2. Click en **"Generar nueva clave privada"**
3. Te descarga un archivo JSON. Abrilo con el Bloc de Notas, **copiá todo el contenido**.
4. **Guardalo en un lugar seguro — no lo subas al repo, no lo compartas.**

## Paso 4: Configurar los secrets en GitHub

1. En GitHub, andá a tu repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **"New repository secret"** y agregá los siguientes 3 secretos:

### Secret 1: `API_FOOTBALL_KEY`
- Name: `API_FOOTBALL_KEY`
- Secret: tu API key de api-football (la misma que ya está en `config.js`)

### Secret 2: `FIREBASE_DATABASE_URL`
- Name: `FIREBASE_DATABASE_URL`
- Secret: `https://prodeguanak-mundial-2026-default-rtdb.firebaseio.com`

### Secret 3: `FIREBASE_SERVICE_ACCOUNT`
- Name: `FIREBASE_SERVICE_ACCOUNT`
- Secret: pegá el JSON COMPLETO del paso 3 (todas las llaves `{...}`)

## Paso 5: Probar el workflow

1. En GitHub, andá a la solapa **"Actions"** del repo
2. Vas a ver "Sync prode (api-football → Firebase)" en la lista
3. Click en él → botón **"Run workflow"** (derecha) → "Run workflow"
4. Se va a empezar a ejecutar. Tarda ~30 seg.
5. Si dice "✅ X resultados, X llaves, X no matcheados" en los logs, **anda perfecto**.

Si tira error rojo, click en el step que falló para ver el mensaje. Avisame y lo destrabamos.

## Paso 6: Listo, anda solo

A partir de ahora, **cada 20 min** (en realidad puede tardar 5-10 min extra, GitHub a veces se demora), el sync corre automático. No tenés que hacer nada.

Si querés forzar un sync, repetí el paso 5.

## Modificaciones futuras

Cuando edites código localmente (ej: cambiar reglas, etc.), tenés que:

1. Como antes, deployar al hosting: `firebase deploy --only hosting`
2. **Adicionalmente** subir los cambios al repo para que el sync use el código actualizado:
   ```
   git add .
   git commit -m "descripción del cambio"
   git push
   ```

Lo de git lo hacés solo si tocaste `sync.mjs`, `fixture.js` o `package.json`. Para cambios sólo en `index.html`, `app.js`, `style.css`, etc., no hace falta.
