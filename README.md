# Smart Table OS — Backend

Servidor Node.js + Express + Socket.IO + SQLite con observabilidad en **Sentry (APM)**, pruebas unitarias con cobertura en **Vitest**, empaquetado en **Docker Hub** (`andreshu07/smarttable-api`) y despliegue automatizado a **Azure App Service** (Dev y Prod con aprobación manual).

## Endpoints principales
- `GET /health`, `/healthz`, `/ready`, `/live` — Health probes
- `GET /api/presets`, `/api/profiles`, `/api/stats` — Datos de partidas y perfiles
- `POST /api/dice/roll` — Motor de tirada de dados con trazabilidad
- `GET /api/apm/trace` — Genera transacción con sub-spans en Sentry
- `GET/POST /api/apm/message` — Envía mensaje/log de auditoría a Sentry
- `GET /api/apm/error` y `POST /api/apm/exception` — Reporta errores y excepciones a Sentry

## Uso local
```bash
npm install
cp .env.example .env
npm run test:coverage
npm start
```
