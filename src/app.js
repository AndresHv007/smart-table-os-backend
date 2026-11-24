const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const {
  getDefaultModules,
  createInitialGameState,
  getActivePlayers,
  calculateWinner,
  computeTurnOrder,
  getNextAliveTurnIndex,
  evaluateDiceRoll,
  checkScoreEndCondition,
  distributeRolesFisherYates,
} = require('./gameEngine');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function createApp({ db, sentry = null, enableTimerLoop = true } = {}) {
  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'development';
  const appVersion = process.env.APP_VERSION || '1.0.0';
  const adminPassword = process.env.ADMIN_PASSWORD || '1234';

  app.use(cors({ origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()) }));
  app.use(express.json());

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((s) => s.trim()),
      methods: ['GET', 'POST'],
    },
  });

  const sessions = {};
  const gameState = createInitialGameState();

  function saveGameResultToDb(winnerRole) {
    try {
      const winnerProfileId = gameState.profiles[winnerRole] || null;
      const scoresData = {};
      Object.keys(gameState.colors)
        .filter((r) => gameState.colors[r])
        .forEach((r) => {
          scoresData[gameState.names[r] || r] = gameState.moduleStates.score[r] || 0;
        });
      db.saveGameResult(gameState.activePreset, winnerProfileId, scoresData);
      io.emit('statsUpdated');
    } catch (err) {
      if (sentry) sentry.captureException(err);
      console.error('Error saving game result:', err);
    }
  }

  function advanceTurnServerSide() {
    if (!gameState.modules.turns.enabled) return;

    if (gameState.turnIndex === gameState.turnOrder.length - 1) {
      if (gameState.modules.turns.countRounds && gameState.modules.turns.autoRound) {
        gameState.moduleStates.turns.currentRound++;

        if (gameState.modules.score.enabled && gameState.modules.score.endCondition?.type === 'rounds') {
          const limit = gameState.modules.score.endCondition.value;
          if (limit > 0 && gameState.moduleStates.turns.currentRound > limit) {
            gameState.status = 'FINISHED';
            const { winner } = calculateWinner(gameState);
            gameState.winner = winner;
            saveGameResultToDb(winner);
            io.emit('gameState', gameState);
            return;
          }
        }
      }
    }

    const { nextIndex, nextTurn } = getNextAliveTurnIndex(
      gameState.turnOrder,
      gameState.turnIndex,
      gameState.moduleStates.turns.deadPlayers || []
    );
    gameState.turnIndex = nextIndex;
    gameState.turn = nextTurn;

    if (gameState.modules.timer.enabled && gameState.modules.timer.type === 'turn') {
      gameState.moduleStates.timer.timeLeft = gameState.modules.timer.seconds;
      gameState.moduleStates.timer.isRunning = gameState.modules.timer.autoStart;
      gameState.moduleStates.timer.isExpired = false;
    }

    io.emit('gameState', gameState);
  }

  function startGame() {
    gameState.status = 'PLAYING';
    gameState.winner = null;
    const activeRoles = getActivePlayers(gameState);

    gameState.turnOrder = computeTurnOrder(activeRoles, gameState.modules.turns);
    gameState.turnIndex = 0;
    gameState.turn = gameState.turnOrder.length > 0 ? gameState.turnOrder[0] : null;

    gameState.moduleStates.dice.lastRoll = { values: [], total: 0, player: null, specialIndices: [], isTotalSpecial: false };
    gameState.moduleStates.turns.currentRound = 1;
    if (gameState.modules.timer.enabled) {
      gameState.moduleStates.timer.timeLeft = gameState.modules.timer.seconds;
      gameState.moduleStates.timer.isRunning = gameState.modules.timer.autoStart;
      gameState.moduleStates.timer.isExpired = false;
    }

    if (gameState.modules.score.enabled) {
      const initScore = gameState.modules.score.initialScore || 0;
      activeRoles.forEach((r) => {
        gameState.moduleStates.score[r] = initScore;
      });
      if (gameState.modules.score.mode === 'teams') {
        Object.keys(gameState.modules.score.teams).forEach((t) => {
          gameState.moduleStates.score[t] = initScore;
        });
      }
      gameState.moduleStates.score.global = initScore;
    }

    gameState.moduleStates.voting = { active: false, question: '', options: [], votes: {}, resultsRevealed: false };
    gameState.moduleStates.hiddenRoles = { rolesDistributed: false, playerRoles: {} };
  }

  // ==========================================
  // REST & HEALTH PROBES
  // ==========================================
  app.get('/', (req, res) => {
    res.status(200).json({
      service: 'smart-table-os-backend',
      environment: appEnv,
      version: appVersion,
      status: 'UP',
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'UP',
      environment: appEnv,
      version: appVersion,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
  });

  app.get('/ready', (req, res) => {
    const presetsCount = db.getAllPresets().length;
    res.status(200).json({
      status: 'ready',
      environment: appEnv,
      checks: {
        database: presetsCount >= 0 ? 'connected' : 'error',
        memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
    });
  });

  app.get('/live', (req, res) => {
    res.status(200).json({
      status: 'alive',
      pid: process.pid,
    });
  });

  // ==========================================
  // DOMAIN REST ENDPOINTS
  // ==========================================
  app.get('/api/presets', (req, res) => {
    res.status(200).json({ presets: db.getAllPresets() });
  });

  app.get('/api/profiles', (req, res) => {
    res.status(200).json({ profiles: db.getAllProfiles() });
  });

  app.get('/api/stats', (req, res) => {
    res.status(200).json({
      leaderboard: db.getLeaderboard(),
      history: db.getGameHistory(),
    });
  });

  app.post('/api/dice/roll', (req, res) => {
    const { count = 2, faces = 6, goldenEnabled = false, goldenConditions = [], player = 'API' } = req.body || {};
    const runRoll = () => evaluateDiceRoll({ count, faces, goldenEnabled, goldenConditions }, player);

    const roll =
      sentry && typeof sentry.startSpan === 'function'
        ? sentry.startSpan({ name: 'smarttable.dice.roll', op: 'game.dice' }, runRoll)
        : runRoll();

    res.status(200).json(roll);
  });

  // ==========================================
  // APM / OBSERVABILITY ENDPOINTS (SENTRY)
  // ==========================================
  app.get('/api/apm/trace', async (req, res) => {
    const executeTrace = async () => {
      const presets =
        sentry && typeof sentry.startSpan === 'function'
          ? await sentry.startSpan({ name: 'db.query.presets', op: 'db.sqlite' }, async () => {
              await new Promise((r) => setTimeout(r, 40));
              return db.getAllPresets();
            })
          : db.getAllPresets();

      const activePlayers =
        sentry && typeof sentry.startSpan === 'function'
          ? await sentry.startSpan({ name: 'game.compute.activePlayers', op: 'game.engine' }, async () => {
              await new Promise((r) => setTimeout(r, 30));
              return getActivePlayers(gameState);
            })
          : getActivePlayers(gameState);

      return { presetsCount: presets.length, activePlayersCount: activePlayers.length };
    };

    const result =
      sentry && typeof sentry.startSpan === 'function'
        ? await sentry.startSpan({ name: 'smarttable.apm.trace', op: 'http.server' }, executeTrace)
        : await executeTrace();

    res.status(200).json({
      success: true,
      environment: appEnv,
      message: 'Traza de rendimiento registrada en APM (Sentry)',
      ...result,
    });
  });

  const handleApmMessage = (req, res) => {
    const message =
      req.body?.message ||
      req.query?.message ||
      `Mensaje de auditoria SmartTable OS (${appEnv}) - ${new Date().toISOString()}`;
    const level = req.body?.level || req.query?.level || 'info';

    let eventId = null;
    if (sentry && typeof sentry.captureMessage === 'function') {
      eventId = sentry.captureMessage(message, {
        level,
        tags: { environment: appEnv, service: 'smart-table-os-backend', type: 'audit_message' },
      });
    }

    res.status(200).json({
      success: true,
      environment: appEnv,
      level,
      message,
      eventId,
    });
  };

  app.get('/api/apm/message', handleApmMessage);
  app.post('/api/apm/message', handleApmMessage);

  app.get('/api/apm/error', (req, res, next) => {
    const err = new Error(`Error simulado de monitoreo APM en SmartTable OS (${appEnv})`);
    next(err);
  });

  app.post('/api/apm/exception', (req, res) => {
    const reason = req.body?.reason || 'Excepcion controlada de prueba APM';
    const err = new Error(reason);
    const eventId =
      sentry && typeof sentry.captureException === 'function'
        ? sentry.captureException(err, {
            tags: { environment: appEnv, tipo: 'manual_capture' },
          })
        : null;

    res.status(500).json({
      success: false,
      environment: appEnv,
      error: err.message,
      eventId,
    });
  });

  // Sentry Express error handler
  if (sentry && typeof sentry.setupExpressErrorHandler === 'function') {
    sentry.setupExpressErrorHandler(app);
  }

  // Fallback JSON error handler
  app.use((err, req, res, next) => {
    res.status(500).json({
      success: false,
      environment: appEnv,
      error: err.message || 'Internal Server Error',
      sentryEventId: res.sentry || null,
    });
  });

  // ==========================================
  // SOCKET.IO HANDLERS
  // ==========================================
  io.on('connection', (socket) => {
    const sessionId = socket.handshake.auth?.sessionId;
    socket.sessionId = sessionId;

    if (sessionId) {
      if (!sessions[sessionId]) {
        sessions[sessionId] = { role: null, timeoutId: null, count: 0 };
      }
      const session = sessions[sessionId];
      session.count++;
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
      }
      if (session.role) {
        socket.role = session.role;
        gameState.players[session.role] = socket.id;
        socket.emit('sessionRestored', session.role);
      }
    }

    socket.emit('gameState', gameState);
    socket.emit('serverInfo', { localIp: getLocalIp(), environment: appEnv, version: appVersion });
    socket.emit('presetsData', db.getAllPresets());

    socket.on('checkProfile', (name, callback) => {
      const profile = db.getProfileByName(name);
      if (callback) callback({ exists: !!profile, profile });
    });

    socket.on('createProfile', (name, callback) => {
      try {
        const profile = db.createProfile(name);
        if (callback) callback({ success: true, profile });
      } catch (err) {
        if (callback) callback({ success: false, error: err.message });
      }
    });

    socket.on('joinRole', ({ role, profileId, name }) => {
      if (gameState.players[role] === null || gameState.players[role] === socket.id) {
        gameState.players[role] = socket.id;
        socket.role = role;
        if (profileId) {
          gameState.profiles[role] = profileId;
          gameState.names[role] = name;
        } else if (name) {
          const p = db.getProfileByName(name);
          if (p) {
            gameState.profiles[role] = p.id;
            gameState.names[role] = p.name;
          } else {
            gameState.names[role] = name;
          }
        }

        if (socket.sessionId && sessions[socket.sessionId]) {
          sessions[socket.sessionId].role = role;
        }

        if (gameState.host === null) {
          gameState.host = role;
        }

        io.emit('gameState', gameState);
      } else {
        socket.emit('errorMsg', `Role ${role} is already taken.`);
      }
    });

    socket.on('selectColor', (colorId) => {
      if (!socket.role) return;

      if (colorId === 'moderator') {
        if (gameState.host === socket.role) {
          gameState.colors[socket.role] = 'moderator';
          gameState.ready[socket.role] = false;
          io.emit('gameState', gameState);
        } else {
          socket.emit('errorMsg', 'Solo el host puede ser moderador.');
        }
        return;
      }

      if (colorId === null) {
        gameState.colors[socket.role] = null;
        gameState.ready[socket.role] = false;
        io.emit('gameState', gameState);
        return;
      }

      const isTaken = Object.values(gameState.colors).includes(colorId);
      if (!isTaken) {
        gameState.colors[socket.role] = colorId;
        gameState.ready[socket.role] = false;
        io.emit('gameState', gameState);
      } else {
        socket.emit('errorMsg', 'El color ya esta en uso.');
      }
    });

    socket.on('setReady', (isReady) => {
      if (!socket.role) return;
      gameState.ready[socket.role] = typeof isReady === 'boolean' ? isReady : !gameState.ready[socket.role];

      const activeRoles = getActivePlayers(gameState);
      if (activeRoles.length >= 1) {
        const allReady = activeRoles.every((r) => gameState.ready[r]);
        if (allReady && gameState.status === 'LOBBY') {
          startGame();
        }
      }
      io.emit('gameState', gameState);
    });

    socket.on('startGame', () => {
      if (gameState.status !== 'LOBBY' || socket.role !== gameState.host) return;
      if (getActivePlayers(gameState).length > 0) {
        startGame();
        io.emit('gameState', gameState);
      }
    });

    socket.on('returnToLobby', () => {
      if (gameState.status === 'LOBBY' || socket.role !== gameState.host) return;
      gameState.status = 'LOBBY';
      Object.keys(gameState.ready).forEach((r) => {
        gameState.ready[r] = false;
      });
      gameState.moduleStates.dice.lastRoll = { values: [], total: 0, player: null, specialIndices: [], isTotalSpecial: false };
      io.emit('gameState', gameState);
    });

    socket.on('getAdminData', (callback) => {
      if (!socket.isAdmin) return callback({ error: 'No autorizado' });
      try {
        callback({ profiles: db.getAllProfiles(), presets: db.getAllPresets() });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on('updateGameName', (name) => {
      if (gameState.status === 'FINISHED') {
        try {
          db.updateLastGameName(name);
          io.emit('statsUpdated');
        } catch (err) {
          if (sentry) sentry.captureException(err);
        }
      }
    });

    socket.on('changeName', (newName) => {
      if (!socket.role) return;
      if (newName && newName.trim().length > 0) {
        gameState.names[socket.role] = newName.substring(0, 15).trim();
        io.emit('gameState', gameState);
      }
    });

    socket.on('changeProfile', (profileId) => {
      if (!socket.role) return;
      gameState.profiles[socket.role] = profileId;
      io.emit('gameState', gameState);
    });

    socket.on('updateModules', (newModules) => {
      if (socket.role !== gameState.host) return;

      if (gameState.status === 'PLAYING') {
        const activeRoles = getActivePlayers(gameState);
        if (newModules.timer?.enabled && !gameState.modules.timer.enabled) {
          gameState.moduleStates.timer.timeLeft = newModules.timer.seconds || gameState.modules.timer.seconds;
          gameState.moduleStates.timer.isRunning = newModules.timer.autoStart || gameState.modules.timer.autoStart;
          gameState.moduleStates.timer.isExpired = false;
        }
        if (newModules.score?.enabled && !gameState.modules.score.enabled) {
          const initScore = newModules.score.initialScore || gameState.modules.score.initialScore || 0;
          activeRoles.forEach((r) => {
            if (gameState.moduleStates.score[r] === undefined) gameState.moduleStates.score[r] = initScore;
          });
          if (gameState.moduleStates.score.global === undefined) gameState.moduleStates.score.global = initScore;
        }
      }

      gameState.modules = { ...gameState.modules, ...newModules };
      gameState.activePreset = null;
      io.emit('gameState', gameState);
    });

    socket.on('loadPreset', (presetName) => {
      if (gameState.status !== 'LOBBY' || socket.role !== gameState.host) return;
      const preset = db.getAllPresets().find((p) => p.name === presetName);
      if (preset) {
        const loadedModules = JSON.parse(JSON.stringify(preset.modulesConfig));
        gameState.modules = { ...getDefaultModules(), ...loadedModules };
        gameState.activePreset = preset.name;
        io.emit('gameState', gameState);
      }
    });

    socket.on('savePreset', (presetName) => {
      if (socket.role !== gameState.host) return;
      try {
        db.savePreset(presetName, gameState.modules);
        gameState.activePreset = presetName;
        io.emit('presetsData', db.getAllPresets());
        io.emit('gameState', gameState);
      } catch (err) {
        socket.emit('errorMsg', err.message);
      }
    });

    socket.on('getStats', (callback) => {
      try {
        if (callback) {
          callback({
            leaderboard: db.getLeaderboard(),
            history: db.getGameHistory(),
            profiles: db.getAllProfiles(),
          });
        }
      } catch (err) {
        if (callback) callback({ error: err.message });
      }
    });

    socket.on('updateScore', ({ target, delta }) => {
      if (gameState.status !== 'PLAYING' || !gameState.modules.score.enabled) return;

      gameState.moduleStates.score[target] = (gameState.moduleStates.score[target] || 0) + delta;

      if (checkScoreEndCondition(gameState.modules.score.endCondition, gameState.moduleStates.score[target])) {
        gameState.status = 'FINISHED';
        const { winner } = calculateWinner(gameState);
        gameState.winner = winner;
        saveGameResultToDb(winner);
      }
      io.emit('gameState', gameState);
    });

    socket.on('updateTeam', ({ teamId, name, colorRole }) => {
      if (gameState.modules.score.teams[teamId]) {
        if (name) gameState.modules.score.teams[teamId].name = name;
        if (colorRole) gameState.modules.score.teams[teamId].colorRole = colorRole;
        io.emit('gameState', gameState);
      }
    });

    socket.on('rollDice', () => {
      if (gameState.status !== 'PLAYING' || !gameState.modules.dice.enabled) return;
      if (gameState.modules.turns.enabled && !gameState.modules.dice.allowOutOfTurn && gameState.turn !== socket.role) {
        return;
      }

      const roll = evaluateDiceRoll(gameState.modules.dice, socket.role);
      gameState.moduleStates.dice.lastRoll = roll;
      io.emit('diceRolled', roll);
      io.emit('gameState', gameState);
    });

    socket.on('endTurn', () => {
      if (gameState.status !== 'PLAYING' || !gameState.modules.turns.enabled || gameState.turn !== socket.role) return;
      advanceTurnServerSide();
    });

    socket.on('advanceTurn', () => {
      if (gameState.host !== socket.role && gameState.turn !== socket.role) return;
      advanceTurnServerSide();
    });

    socket.on('togglePlayerDead', (roleToToggle) => {
      if (gameState.host !== socket.role) return;
      if (!gameState.moduleStates.turns.deadPlayers) gameState.moduleStates.turns.deadPlayers = [];
      const isDead = gameState.moduleStates.turns.deadPlayers.includes(roleToToggle);
      if (isDead) {
        gameState.moduleStates.turns.deadPlayers = gameState.moduleStates.turns.deadPlayers.filter((r) => r !== roleToToggle);
      } else {
        gameState.moduleStates.turns.deadPlayers.push(roleToToggle);
        if (gameState.turn === roleToToggle) {
          advanceTurnServerSide();
          return;
        }
      }
      io.emit('gameState', gameState);
    });

    socket.on('startVote', (question, options) => {
      if (gameState.host !== socket.role) return;
      gameState.moduleStates.voting.active = true;
      gameState.moduleStates.voting.question = question || '¿Votacion General?';

      if (gameState.modules.voting.mode === 'players') {
        gameState.moduleStates.voting.options = getActivePlayers(gameState).map((p) => gameState.names[p] || p);
      } else if (gameState.modules.voting.mode === 'custom') {
        gameState.moduleStates.voting.options =
          options && options.length > 0
            ? options
            : gameState.modules.voting.customOptions?.length > 0
            ? gameState.modules.voting.customOptions
            : ['Si', 'No'];
      } else {
        gameState.moduleStates.voting.options = ['Si (A favor)', 'No (En contra)'];
      }

      gameState.moduleStates.voting.votes = {};
      gameState.moduleStates.voting.resultsRevealed = false;
      io.emit('gameState', gameState);
    });

    socket.on('submitVote', (option) => {
      if (!socket.role) return;
      if (gameState.moduleStates.voting.active && !gameState.moduleStates.voting.resultsRevealed) {
        gameState.moduleStates.voting.votes[socket.role] = option;
        io.emit('gameState', gameState);
      }
    });

    socket.on('closeVote', () => {
      if (gameState.host !== socket.role) return;
      gameState.moduleStates.voting.active = false;
      gameState.moduleStates.voting.resultsRevealed = false;
      io.emit('gameState', gameState);
    });

    socket.on('revealVote', () => {
      if (gameState.host !== socket.role) return;
      gameState.moduleStates.voting.active = false;
      gameState.moduleStates.voting.resultsRevealed = true;
      io.emit('gameState', gameState);
    });

    socket.on('distributeHiddenRoles', (roles) => {
      if (gameState.host !== socket.role) return;
      const activePlayers = getActivePlayers(gameState);
      const assignedRolesMap = distributeRolesFisherYates(activePlayers, roles);

      activePlayers.forEach((playerRole) => {
        const playerSocketId = gameState.players[playerRole];
        if (playerSocketId) {
          io.to(playerSocketId).emit('secretRole', assignedRolesMap[playerRole]);
        }
      });

      if (gameState.modules.hiddenRoles.hostSeesAll && gameState.host && gameState.players[gameState.host]) {
        io.to(gameState.players[gameState.host]).emit('allSecretRoles', assignedRolesMap);
      }

      gameState.moduleStates.hiddenRoles.rolesDistributed = true;
      io.emit('gameState', gameState);
    });

    socket.on('clearHiddenRoles', () => {
      if (gameState.host !== socket.role) return;
      gameState.moduleStates.hiddenRoles.rolesDistributed = false;
      io.emit('clearSecretRole');
      io.emit('gameState', gameState);
    });

    socket.on('advanceRound', () => {
      if (gameState.status !== 'PLAYING' || socket.role !== gameState.host) return;
      gameState.moduleStates.turns.currentRound++;
      io.emit('gameState', gameState);
    });

    socket.on('startTimer', () => {
      if (gameState.status === 'PLAYING') {
        gameState.moduleStates.timer.isRunning = true;
        gameState.moduleStates.timer.isExpired = false;
        io.emit('gameState', gameState);
      }
    });

    socket.on('pauseTimer', () => {
      if (gameState.status === 'PLAYING') {
        gameState.moduleStates.timer.isRunning = false;
        io.emit('gameState', gameState);
      }
    });

    socket.on('resetTimer', () => {
      if (gameState.status === 'PLAYING') {
        gameState.moduleStates.timer.timeLeft = gameState.modules.timer.seconds;
        gameState.moduleStates.timer.isRunning = false;
        gameState.moduleStates.timer.isExpired = false;
        io.emit('gameState', gameState);
      }
    });

    socket.on('toggleStatsView', (show) => {
      gameState.showStats = show;
      io.emit('gameState', gameState);
    });

    socket.on('setStatsTab', (tab) => {
      gameState.activeStatsTab = tab;
      io.emit('gameState', gameState);
    });

    socket.on('adminLogin', (password, callback) => {
      if (password === adminPassword) {
        socket.isAdmin = true;
        if (callback) callback({ success: true });
      } else if (callback) {
        callback({ success: false, error: 'Contrasena incorrecta' });
      }
    });

    socket.on('deleteProfile', (id, callback) => {
      if (!socket.isAdmin) return callback?.({ success: false, error: 'No autorizado' });
      try {
        db.deleteProfile(id);
        callback?.({ success: true });
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on('deletePreset', (id, callback) => {
      if (!socket.isAdmin) return callback?.({ success: false, error: 'No autorizado' });
      try {
        db.deletePreset(id);
        io.emit('presetsData', db.getAllPresets());
        callback?.({ success: true });
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on('addManualRecord', (data, callback) => {
      if (!socket.isAdmin && socket.role !== gameState.host) {
        return callback?.({ success: false, error: 'No autorizado' });
      }
      try {
        let winnerProfileId = null;
        if (data.winnerName && data.winnerName !== 'Empate') {
          const profile = db.getProfileByName(data.winnerName);
          if (profile) winnerProfileId = profile.id;
        }
        db.saveGameResult(data.presetName || 'Manual Record', winnerProfileId, data.scores || {});
        io.emit('statsUpdated');
        callback?.({ success: true });
      } catch (err) {
        callback?.({ success: false, error: err.message });
      }
    });

    socket.on('disconnect', () => {
      const sId = socket.sessionId;
      if (sId && sessions[sId]) {
        sessions[sId].count--;
        if (sessions[sId].count <= 0 && socket.role) {
          const roleToFree = socket.role;
          const timeoutId = setTimeout(() => {
            if (gameState.players[roleToFree]) {
              gameState.players[roleToFree] = null;
              gameState.colors[roleToFree] = null;
              gameState.names[roleToFree] = roleToFree;
              gameState.profiles[roleToFree] = null;
              gameState.ready[roleToFree] = false;

              if (gameState.host === roleToFree) {
                const remainingPlayers = Object.keys(gameState.players).filter((r) => gameState.players[r] !== null);
                gameState.host = remainingPlayers.length > 0 ? remainingPlayers[0] : null;
              }
              delete sessions[sId];
              io.emit('gameState', gameState);
            }
          }, 5 * 60 * 1000);
          sessions[sId].timeoutId = timeoutId;
        }
      }
    });
  });

  let timerInterval = null;
  if (enableTimerLoop) {
    timerInterval = setInterval(() => {
      if (gameState.status === 'PLAYING' && gameState.modules.timer.enabled && gameState.moduleStates.timer.isRunning) {
        if (gameState.moduleStates.timer.timeLeft > 0) {
          gameState.moduleStates.timer.timeLeft--;
          if (gameState.moduleStates.timer.timeLeft === 0) {
            gameState.moduleStates.timer.isRunning = false;
            gameState.moduleStates.timer.isExpired = true;
            io.emit('timerExpired', gameState.turn);
            io.emit('timerTick', 0);
            io.emit('gameState', gameState);
            if (gameState.modules.timer.autoPass) {
              setTimeout(() => advanceTurnServerSide(), 1000);
            }
          } else {
            io.emit('timerTick', gameState.moduleStates.timer.timeLeft);
          }
        }
      }
    }, 1000);
  }

  return {
    app,
    server,
    io,
    gameState,
    stopTimer: () => {
      if (timerInterval) clearInterval(timerInterval);
    },
  };
}

module.exports = { createApp };
