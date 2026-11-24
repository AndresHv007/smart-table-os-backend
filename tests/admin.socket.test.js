import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { io as Client } from 'socket.io-client';
import { createDatabase } from '../src/database';
import { createApp } from '../src/app';

describe('SmartTable OS - Panel de Administracion y Registros Manuales', () => {
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

  it('bloquea acciones administrativas sin autenticacion y rechaza contrasena invalida', async () => {
    const guest = await connectClient('sess-admin-guest');

    const badLogin = await new Promise((r) => guest.emit('adminLogin', '0000', r));
    expect(badLogin.success).toBe(false);

    const adminData = await new Promise((r) => guest.emit('getAdminData', r));
    expect(adminData.error).toBe('No autorizado');

    const delProf = await new Promise((r) => guest.emit('deleteProfile', 1, r));
    expect(delProf.success).toBe(false);

    const delPreset = await new Promise((r) => guest.emit('deletePreset', 1, r));
    expect(delPreset.success).toBe(false);

    const manual = await new Promise((r) => guest.emit('addManualRecord', { winnerName: 'Empate' }, r));
    expect(manual.success).toBe(false);
  });

  it('permite consultar datos, borrar perfiles/presets no protegidos y agregar registros manuales', async () => {
    const admin = await connectClient('sess-admin-ok');

    const login = await new Promise((r) => admin.emit('adminLogin', '1234', r));
    expect(login.success).toBe(true);

    const data = await new Promise((r) => admin.emit('getAdminData', r));
    expect(data.profiles.length).toBeGreaterThanOrEqual(5);
    expect(data.presets.length).toBeGreaterThanOrEqual(3);

    // No debe permitir borrar perfil por defecto 'admin'
    const defaultAdmin = db.getProfileByName('admin');
    const delProtected = await new Promise((r) => admin.emit('deleteProfile', defaultAdmin.id, r));
    expect(delProtected.success).toBe(false);

    // Debe permitir borrar perfil y preset creados manualmente
    const customProf = db.createProfile('JugadorTemporal');
    const delCustom = await new Promise((r) => admin.emit('deleteProfile', customProf.id, r));
    expect(delCustom.success).toBe(true);

    const customPresetId = db.savePreset('PresetTemporal', { dice: { enabled: true } });
    const delPresetRes = await new Promise((r) => admin.emit('deletePreset', customPresetId, r));
    expect(delPresetRes.success).toBe(true);

    // Registro manual con ganador existente y empate
    db.createProfile('Elena');
    const recWinner = await new Promise((r) =>
      admin.emit('addManualRecord', { presetName: 'Catan', winnerName: 'Elena', scores: { Elena: 10 } }, r)
    );
    expect(recWinner.success).toBe(true);

    const recTie = await new Promise((r) =>
      admin.emit('addManualRecord', { presetName: 'Dixit', winnerName: 'Empate', scores: { Elena: 5 } }, r)
    );
    expect(recTie.success).toBe(true);
    expect(db.getGameHistory().length).toBe(2);
  });
});
