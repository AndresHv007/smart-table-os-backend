import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createDatabase } from '../src/database';
import { createApp } from '../src/app';

describe('SmartTable OS - REST API, Health Probes & APM', () => {
  let db;
  let appInstance;
  let mockSentry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    mockSentry = {
      startSpan: vi.fn((opts, fn) => fn()),
      captureMessage: vi.fn(() => 'evt-msg-123'),
      captureException: vi.fn(() => 'evt-err-456'),
      setupExpressErrorHandler: vi.fn(),
    };
    appInstance = createApp({ db, sentry: mockSentry, enableTimerLoop: false });
  });

  afterEach(() => {
    appInstance.stopTimer();
    db.close();
  });

  it('responde en root y health probes (/health, /healthz, /ready, /live)', async () => {
    const rootRes = await request(appInstance.app).get('/');
    expect(rootRes.status).toBe(200);
    expect(rootRes.body.service).toBe('smart-table-os-backend');

    const healthRes = await request(appInstance.app).get('/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('UP');

    const healthzRes = await request(appInstance.app).get('/healthz');
    expect(healthzRes.status).toBe(200);
    expect(healthzRes.text).toBe('OK');

    const readyRes = await request(appInstance.app).get('/ready');
    expect(readyRes.status).toBe(200);
    expect(readyRes.body.status).toBe('ready');

    const liveRes = await request(appInstance.app).get('/live');
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.status).toBe('alive');
  });

  it('expone presets, profiles, stats y tirada de dados por REST', async () => {
    const presetsRes = await request(appInstance.app).get('/api/presets');
    expect(presetsRes.status).toBe(200);
    expect(presetsRes.body.presets.length).toBeGreaterThanOrEqual(3);

    const profilesRes = await request(appInstance.app).get('/api/profiles');
    expect(profilesRes.status).toBe(200);
    expect(profilesRes.body.profiles.length).toBeGreaterThanOrEqual(5);

    const statsRes = await request(appInstance.app).get('/api/stats');
    expect(statsRes.status).toBe(200);
    expect(Array.isArray(statsRes.body.leaderboard)).toBe(true);

    const rollRes = await request(appInstance.app)
      .post('/api/dice/roll')
      .send({ count: 3, faces: 6, player: 'Norte' });
    expect(rollRes.status).toBe(200);
    expect(rollRes.body.values).toHaveLength(3);
    expect(rollRes.body.total).toBeGreaterThanOrEqual(3);
    expect(rollRes.body.total).toBeLessThanOrEqual(18);
  });

  it('genera trazas, mensajes y errores para monitoreo APM (Sentry)', async () => {
    const traceRes = await request(appInstance.app).get('/api/apm/trace');
    expect(traceRes.status).toBe(200);
    expect(traceRes.body.success).toBe(true);
    expect(mockSentry.startSpan).toHaveBeenCalled();

    const msgRes = await request(appInstance.app)
      .post('/api/apm/message')
      .send({ message: 'Prueba de auditoria', level: 'warning' });
    expect(msgRes.status).toBe(200);
    expect(msgRes.body.eventId).toBe('evt-msg-123');
    expect(mockSentry.captureMessage).toHaveBeenCalled();

    const excRes = await request(appInstance.app)
      .post('/api/apm/exception')
      .send({ reason: 'Fallo controlado' });
    expect(excRes.status).toBe(500);
    expect(excRes.body.eventId).toBe('evt-err-456');
    expect(mockSentry.captureException).toHaveBeenCalled();

    const errRes = await request(appInstance.app).get('/api/apm/error');
    expect(errRes.status).toBe(500);
    expect(errRes.body.success).toBe(false);
  });
});
