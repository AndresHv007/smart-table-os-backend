import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../src/database';

describe('SmartTable OS - Database (SQLite)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('inicializa presets integrados y perfiles por defecto', () => {
    const presets = db.getAllPresets();
    expect(presets.map((p) => p.name)).toEqual(expect.arrayContaining(['Catan', 'Monopoly', 'Dixit']));

    const profiles = db.getAllProfiles();
    expect(profiles.map((p) => p.name)).toEqual(expect.arrayContaining(['admin', 'Norte', 'Sur', 'Este', 'Oeste']));
  });

  it('crea, consulta y elimina perfiles personalizados pero protege perfiles por defecto', () => {
    const created = db.createProfile('Andres');
    expect(created.name).toBe('Andres');

    const duplicate = db.createProfile('Andres');
    expect(duplicate.id).toBe(created.id);

    expect(() => db.createProfile('   ')).toThrow('obligatorio');

    db.deleteProfile(created.id);
    expect(db.getProfileByName('Andres')).toBeUndefined();

    const admin = db.getProfileByName('admin');
    expect(() => db.deleteProfile(admin.id)).toThrow('perfiles por defecto');
  });

  it('guarda, actualiza y elimina presets', () => {
    const id = db.savePreset('Risk', { dice: { enabled: true, count: 3, faces: 6 } });
    expect(id).toBeTruthy();

    const sameId = db.savePreset('Risk', { dice: { enabled: true, count: 5, faces: 6 } });
    expect(sameId).toBe(id);

    const updated = db.getAllPresets().find((p) => p.name === 'Risk');
    expect(updated.modulesConfig.dice.count).toBe(5);

    db.deletePreset(id);
    expect(db.getAllPresets().find((p) => p.name === 'Risk')).toBeUndefined();
  });

  it('registra partidas, calcula leaderboard y actualiza nombre de la ultima partida', () => {
    const player = db.createProfile('Sofia');
    db.saveGameResult('Catan', player.id, { Sofia: 10, Andres: 7 });

    const leaderboard = db.getLeaderboard();
    expect(leaderboard[0]).toEqual({ name: 'Sofia', wins: 1 });

    db.updateLastGameName('Catan Torneo');
    const history = db.getGameHistory();
    expect(history[0].presetName).toBe('Catan Torneo');
    expect(history[0].winnerName).toBe('Sofia');
    expect(history[0].scoresData.Sofia).toBe(10);
  });
});
