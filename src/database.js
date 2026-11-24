const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function createDatabase(customDbPath) {
  const dbPath = customDbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'smart-table.sqlite');
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  function seedDefaultProfiles() {
    const defaults = ['admin', 'Norte', 'Sur', 'Este', 'Oeste'];
    const insert = db.prepare('INSERT OR IGNORE INTO Profiles (name) VALUES (?)');
    for (const name of defaults) {
      insert.run(name);
    }
  }

  function seedBuiltInPresets() {
    const insertPreset = db.prepare('INSERT INTO Presets (name, modulesConfig, isBuiltIn) VALUES (?, ?, 1)');

    const getBaseModules = () => ({
      turns: { enabled: false, orderType: 'clockwise', customOrder: [], countRounds: false, autoRound: false, maxRounds: 0 },
      timer: { enabled: false, type: 'turn', seconds: 60, autoStart: false, autoPass: false, allowPlayerControls: true },
      dice: { enabled: false, count: 2, faces: 6, allowOutOfTurn: false },
      score: { enabled: false, mode: 'individual', winCondition: 'highest', teams: {} },
    });

    const catanModules = getBaseModules();
    catanModules.dice = { enabled: true, count: 2, faces: 6, allowOutOfTurn: false };
    catanModules.turns = { enabled: true, orderType: 'clockwise', customOrder: [], countRounds: false, autoRound: false, maxRounds: 0 };
    catanModules.score = { enabled: true, mode: 'individual', winCondition: 'highest', teams: {}, endCondition: { type: 'points', value: 10, direction: 'asc' } };

    const monopolyModules = getBaseModules();
    monopolyModules.dice = { enabled: true, count: 2, faces: 6, allowOutOfTurn: false };
    monopolyModules.turns = { enabled: true, orderType: 'clockwise', customOrder: [], countRounds: false, autoRound: false, maxRounds: 0 };

    const dixitModules = getBaseModules();
    dixitModules.turns = { enabled: true, orderType: 'clockwise', customOrder: [], countRounds: true, autoRound: false, maxRounds: 0 };
    dixitModules.score = { enabled: true, mode: 'individual', winCondition: 'highest', teams: {}, endCondition: { type: 'points', value: 30, direction: 'asc' } };

    insertPreset.run('Catan', JSON.stringify(catanModules));
    insertPreset.run('Monopoly', JSON.stringify(monopolyModules));
    insertPreset.run('Dixit', JSON.stringify(dixitModules));
  }

  function initDb() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS Presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        modulesConfig TEXT NOT NULL,
        isBuiltIn INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS Games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATETIME DEFAULT CURRENT_TIMESTAMP,
        presetName TEXT,
        winnerProfileId INTEGER,
        scoresData TEXT
      );
    `);

    const presetsCount = db.prepare('SELECT COUNT(*) as count FROM Presets').get().count;
    if (presetsCount === 0) {
      seedBuiltInPresets();
    }
    seedDefaultProfiles();
  }

  function getProfileByName(name) {
    return db.prepare('SELECT * FROM Profiles WHERE name COLLATE NOCASE = ?').get(name);
  }

  function createProfile(name) {
    if (!name || !String(name).trim()) {
      throw new Error('El nombre de perfil es obligatorio');
    }
    const cleanName = String(name).trim();
    try {
      const info = db.prepare('INSERT INTO Profiles (name) VALUES (?)').run(cleanName);
      return { id: info.lastInsertRowid, name: cleanName };
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return getProfileByName(cleanName);
      }
      throw err;
    }
  }

  function getAllProfiles() {
    return db.prepare('SELECT * FROM Profiles ORDER BY name ASC').all();
  }

  function deleteProfile(id) {
    const profile = db.prepare('SELECT name FROM Profiles WHERE id = ?').get(id);
    if (profile) {
      const defaults = ['admin', 'Norte', 'Sur', 'Este', 'Oeste'];
      if (defaults.map((d) => d.toLowerCase()).includes(profile.name.toLowerCase())) {
        throw new Error('No se pueden borrar los perfiles por defecto');
      }
    }
    db.prepare('DELETE FROM Profiles WHERE id = ?').run(id);
  }

  function getAllPresets() {
    return db
      .prepare('SELECT * FROM Presets ORDER BY isBuiltIn DESC, name ASC')
      .all()
      .map((p) => ({
        ...p,
        modulesConfig: JSON.parse(p.modulesConfig),
      }));
  }

  function savePreset(name, modulesConfig) {
    const existing = db.prepare('SELECT id, isBuiltIn FROM Presets WHERE name COLLATE NOCASE = ?').get(name);
    if (existing) {
      db.prepare('UPDATE Presets SET modulesConfig = ? WHERE id = ?').run(JSON.stringify(modulesConfig), existing.id);
      return existing.id;
    }
    const info = db.prepare('INSERT INTO Presets (name, modulesConfig) VALUES (?, ?)').run(name, JSON.stringify(modulesConfig));
    return info.lastInsertRowid;
  }

  function deletePreset(id) {
    db.prepare('DELETE FROM Presets WHERE id = ?').run(id);
  }

  function saveGameResult(presetName, winnerProfileId, scoresData) {
    const info = db
      .prepare('INSERT INTO Games (presetName, winnerProfileId, scoresData) VALUES (?, ?, ?)')
      .run(presetName || 'Custom', winnerProfileId, JSON.stringify(scoresData || {}));
    return info.lastInsertRowid;
  }

  function getLeaderboard() {
    return db
      .prepare(
        `
      SELECT p.name, COUNT(g.id) as wins
      FROM Profiles p
      LEFT JOIN Games g ON p.id = g.winnerProfileId
      WHERE p.name COLLATE NOCASE NOT IN ('admin', 'norte', 'sur', 'este', 'oeste')
      GROUP BY p.id
      ORDER BY wins DESC, p.name ASC
    `
      )
      .all();
  }

  function getGameHistory() {
    return db
      .prepare(
        `
      SELECT g.*, p.name as winnerName
      FROM Games g
      LEFT JOIN Profiles p ON g.winnerProfileId = p.id
      ORDER BY g.date DESC
      LIMIT 50
    `
      )
      .all()
      .map((g) => ({
        ...g,
        scoresData: JSON.parse(g.scoresData),
      }));
  }

  function updateLastGameName(name) {
    const lastGame = db.prepare('SELECT id FROM Games ORDER BY date DESC, id DESC LIMIT 1').get();
    if (lastGame) {
      db.prepare('UPDATE Games SET presetName = ? WHERE id = ?').run(name, lastGame.id);
    }
  }

  function close() {
    db.close();
  }

  initDb();

  return {
    initDb,
    getProfileByName,
    createProfile,
    getAllProfiles,
    deleteProfile,
    getAllPresets,
    savePreset,
    deletePreset,
    saveGameResult,
    getLeaderboard,
    getGameHistory,
    updateLastGameName,
    close,
  };
}

module.exports = { createDatabase };
