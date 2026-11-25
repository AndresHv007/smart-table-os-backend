# Smart Table OS — Backend (`andreshu07/smarttable-api`)

Servidor Node.js + Express + Socket.IO + SQLite para **Smart Table OS**, con observabilidad en **Sentry (APM)**, suite de 23 pruebas en **Vitest** (91.29% cobertura global) y despliegue automatizado a **Azure App Service** (Dev y Prod con aprobación manual).

## Ejecución rápida con Docker
```bash
docker run -d --name smarttable-api \
  -p 3001:3001 \
  -e APP_ENV=development \
  -e SENTRY_DSN="" \
  -v smarttable_data:/app/data \
  andreshu07/smarttable-api:latest
```

## Variables de entorno
| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto HTTP y WebSocket |
| `APP_ENV` | `development` | Ambiente activo (`development` / `production` / `local`) |
| `APP_VERSION` | `1.0.0` | Versión o SHA del despliegue |
| `CORS_ORIGIN` | `*` | Orígenes permitidos para HTTP/Socket.IO |
| `DB_PATH` | `./data/smart-table.sqlite` | Ruta de la base de datos SQLite |
| `SENTRY_DSN` | *(vacío)* | DSN de Sentry para trazas, mensajes y errores APM |

## Endpoints principales
- `GET /health`, `/healthz`, `/ready`, `/live` — Health probes
- `GET /api/presets`, `/api/profiles`, `/api/stats` — Datos de partidas y perfiles
- `POST /api/dice/roll` — Motor de tirada de dados con trazabilidad
- `GET /api/apm/trace`, `GET/POST /api/apm/message`, `GET /api/apm/error` — Monitoreo APM (Sentry)

## Desarrollo local y pruebas
```bash
npm install
cp .env.example .env
npm run test:coverage
npm start
```
