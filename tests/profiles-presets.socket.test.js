import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { io as Client } from 'socket.io-client';
import { createDatabase } from '../src/database';
import { createApp } from '../src/app';

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timeout esperando condicion de estado'));
      }
    }, 10);
  });
}

describe('SmartTable OS - Perfiles, Presets y Reconexion', () => {
  let db;
  let instance;
  let port;
  const clients = [];

  const connectClient = async (sessionId) => {
    const c = Client(`http://127.0.0.1:${port}`, { auth: { sessionId } });
    clients.push(c);
    await new Promise((r) => c.on('connect', r));
    return c;
  };

  beforeEach(async () => {
    db = createDatabase(':memory:');
    instance = createApp({ db, sentry: null, enableTimerLoop: false });
    await new Promise((resolve) => {
      instance.server.listen(0, '127.0.0.1', () => {
        port = instance.server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    while (clients.length) clients.pop().disconnect();
    instance.stopTimer();
    await new Promise((resolve) => instance.io.close(resolve));
    db.close();
  });

  it('crea y consulta perfiles, guarda presets y expone estadisticas por socket', async () => {
    const host = await connectClient('sess-prof-1');

    const emptyRes = await new Promise((r) => host.emit('createProfile', '   ', r));
    expect(emptyRes.success).toBe(false);

    const created = await new Promise((r) => host.emit('createProfile', 'Carlos', r));
    expect(created.success).toBe(true);
    expect(created.profile.name).toBe('Carlos');

    const checked = await new Promise((r) => host.emit('checkProfile', 'Carlos', r));
    expect(checked.exists).toBe(true);

    host.emit('joinRole', { role: 'Norte', profileId: created.profile.id, name: 'Carlos' });
    await waitFor(() => instance.gameState.host === 'Norte');

    host.emit('changeName', 'CarlosPro');
    host.emit('changeProfile', created.profile.id);
    await waitFor(() => instance.gameState.names.Norte === 'CarlosPro');

    host.emit('savePreset', 'MiPresetCustom');
    await waitFor(() => instance.gameState.activePreset === 'MiPresetCustom');
    expect(db.getAllPresets().some((p) => p.name === 'MiPresetCustom')).toBe(true);

    host.emit('toggleStatsView', true);
    host.emit('setStatsTab', 'history');
    await waitFor(() => instance.gameState.showStats === true && instance.gameState.activeStatsTab === 'history');

    const stats = await new Promise((r) => host.emit('getStats', r));
    expect(Array.isArray(stats.profiles)).toBe(true);
    expect(Array.isArray(stats.history)).toBe(true);
  });

  it('rechaza roles o colores duplicados y restaura sesion al reconectar', async () => {
    const c1 = await connectClient('sess-reconn-1');
    c1.emit('joinRole', { role: 'Norte', name: 'Norte' });
    await waitFor(() => instance.gameState.players.Norte !== null);
    c1.emit('selectColor', 'red');
    await waitFor(() => instance.gameState.colors.Norte === 'red');

    const c2 = await connectClient('sess-reconn-2');
    const roleErr = new Promise((r) => c2.once('errorMsg', r));
    c2.emit('joinRole', { role: 'Norte', name: 'Intruso' });
    expect(await roleErr).toContain('already taken');

    c2.emit('joinRole', { role: 'Sur', name: 'Ana' });
    await waitFor(() => instance.gameState.players.Sur !== null);
    const colorErr = new Promise((r) => c2.once('errorMsg', r));
    c2.emit('selectColor', 'red');
    expect(await colorErr).toContain('en uso');

    // Reconexion con el mismo sessionId debe restaurar rol y limpiar timeout
    c1.disconnect();
    await new Promise((r) => setTimeout(r, 30));
    const c1Back = Client(`http://127.0.0.1:${port}`, { auth: { sessionId: 'sess-reconn-1' } });
    clients.push(c1Back);
    const restoredRole = await new Promise((r) => c1Back.once('sessionRestored', r));
    expect(restoredRole).toBe('Norte');
  });
});
