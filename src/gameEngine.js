function getDefaultModules() {
  return {
    turns: {
      enabled: true,
      orderType: 'clockwise',
      customOrder: [],
      countRounds: false,
      autoRound: false,
      maxRounds: 0,
      showModeratorPanel: true,
      firstPlayer: 'random',
    },
    timer: {
      enabled: false,
      type: 'turn',
      seconds: 60,
      autoStart: false,
      autoPass: false,
      allowPlayerControls: true,
    },
    dice: {
      enabled: true,
      count: 2,
      faces: 6,
      allowOutOfTurn: false,
      specialRolls: [{ type: 'single', value: 20 }],
    },
    score: {
      enabled: false,
      mode: 'individual',
      initialScore: 0,
      winCondition: 'highest',
      endCondition: { type: 'none', value: 0 },
      teams: {},
    },
    voting: {
      enabled: false,
      mode: 'yes_no',
      customOptions: [],
      dynamicCustomOptions: false,
      showVotesOnReveal: false,
    },
    hiddenRoles: {
      enabled: false,
      roleDeck: [],
      hostSeesAll: false,
    },
  };
}

function createInitialGameState() {
  return {
    status: 'LOBBY',
    host: null,
    players: { Norte: null, Sur: null, Este: null, Oeste: null },
    colors: { Norte: null, Sur: null, Este: null, Oeste: null },
    names: { Norte: 'Norte', Sur: 'Sur', Este: 'Este', Oeste: 'Oeste' },
    profiles: { Norte: null, Sur: null, Este: null, Oeste: null },
    ready: { Norte: false, Sur: false, Este: false, Oeste: false },
    activePreset: null,
    turnOrder: [],
    turnIndex: 0,
    turn: null,
    showStats: false,
    activeStatsTab: 'leaderboard',
    winner: null,
    modules: getDefaultModules(),
    moduleStates: {
      dice: { lastRoll: { values: [], total: 0, player: null, specialIndices: [], isTotalSpecial: false } },
      score: {
        Norte: 0,
        Sur: 0,
        Este: 0,
        Oeste: 0,
        global: 0,
        team1: 0,
        team2: 0,
        team3: 0,
        team4: 0,
      },
      turns: { currentRound: 1, deadPlayers: [] },
      timer: { timeLeft: 60, isRunning: false, isExpired: false },
      voting: { active: false, question: '', options: [], votes: {}, resultsRevealed: false },
      hiddenRoles: { rolesDistributed: false },
    },
  };
}

function getActivePlayers(gameState) {
  return Object.keys(gameState.colors).filter(
    (r) =>
      gameState.colors[r] &&
      gameState.colors[r] !== 'moderator' &&
      !gameState.moduleStates.turns.deadPlayers?.includes(r)
  );
}

function calculateWinner(gameState) {
  let winner = null;
  const winCondition = gameState.modules.score.winCondition;
  let bestScore = winCondition === 'lowest' ? Infinity : -Infinity;

  const targets =
    gameState.modules.score.mode === 'individual'
      ? getActivePlayers(gameState)
      : gameState.modules.score.mode === 'teams'
      ? Object.keys(gameState.modules.score.teams)
      : ['global'];

  targets.forEach((t) => {
    const s = gameState.moduleStates.score[t] || 0;
    if (winCondition === 'lowest') {
      if (s < bestScore) {
        bestScore = s;
        winner = t;
      }
    } else if (s > bestScore) {
      bestScore = s;
      winner = t;
    }
  });

  return { winner, bestScore };
}

function computeTurnOrder(activeRoles, turnsConfig, randomFn = Math.random) {
  let turnOrder;
  if (turnsConfig.orderType === 'custom' && turnsConfig.customOrder && turnsConfig.customOrder.length > 0) {
    turnOrder = [...turnsConfig.customOrder];
  } else {
    const shuffledRoles = [...activeRoles].sort(() => randomFn() - 0.5);
    turnOrder = turnsConfig.orderType === 'counterclockwise' ? shuffledRoles.reverse() : shuffledRoles;
  }

  if (turnsConfig.firstPlayer && turnsConfig.firstPlayer !== 'random') {
    const firstIndex = turnOrder.indexOf(turnsConfig.firstPlayer);
    if (firstIndex > 0) {
      turnOrder = [...turnOrder.slice(firstIndex), ...turnOrder.slice(0, firstIndex)];
    }
  }

  return turnOrder;
}

function getNextAliveTurnIndex(turnOrder, currentIndex, deadPlayers = []) {
  if (!turnOrder || turnOrder.length === 0) {
    return { nextIndex: 0, nextTurn: null };
  }
  let nextIndex = (currentIndex + 1) % turnOrder.length;
  let loopCount = 0;
  while (deadPlayers.includes(turnOrder[nextIndex]) && loopCount < turnOrder.length) {
    nextIndex = (nextIndex + 1) % turnOrder.length;
    loopCount++;
  }
  if (loopCount < turnOrder.length) {
    return { nextIndex, nextTurn: turnOrder[nextIndex] };
  }
  return { nextIndex: currentIndex, nextTurn: null };
}

function evaluateDiceRoll(diceConfig, playerRole = null, randomFn = Math.random) {
  const count = Math.max(1, Math.min(10, Number(diceConfig.count) || 1));
  const faces = Math.max(2, Math.min(100, Number(diceConfig.faces) || 6));
  const values = [];
  let total = 0;
  const specialIndices = [];
  let isTotalSpecial = false;

  for (let i = 0; i < count; i++) {
    const val = Math.floor(randomFn() * faces) + 1;
    values.push(val);
    total += val;

    if (diceConfig.goldenEnabled && Array.isArray(diceConfig.goldenConditions)) {
      diceConfig.goldenConditions.forEach((cond) => {
        if (cond.type && cond.type.startsWith('single_')) {
          if (cond.type === 'single_exact' && val === cond.value && !specialIndices.includes(i)) specialIndices.push(i);
          if (cond.type === 'single_min' && val >= cond.value && !specialIndices.includes(i)) specialIndices.push(i);
          if (cond.type === 'single_max' && val <= cond.value && !specialIndices.includes(i)) specialIndices.push(i);
        }
      });
    }
  }

  if (diceConfig.goldenEnabled && Array.isArray(diceConfig.goldenConditions)) {
    diceConfig.goldenConditions.forEach((cond) => {
      if (cond.type && cond.type.startsWith('sum_')) {
        if (cond.type === 'sum_exact' && total === cond.value) isTotalSpecial = true;
        if (cond.type === 'sum_min' && total >= cond.value) isTotalSpecial = true;
        if (cond.type === 'sum_max' && total <= cond.value) isTotalSpecial = true;
      }
    });
  }

  return {
    values,
    total,
    player: playerRole,
    specialIndices,
    isTotalSpecial,
  };
}

function checkScoreEndCondition(endCondition, newScore) {
  if (!endCondition || endCondition.type !== 'points') return false;
  if (endCondition.direction === 'above' || endCondition.direction === 'asc') {
    return newScore >= endCondition.value;
  }
  if (endCondition.direction === 'below' || endCondition.direction === 'desc') {
    return newScore <= endCondition.value;
  }
  return newScore >= endCondition.value;
}

function distributeRolesFisherYates(activePlayers, roles, randomFn = Math.random) {
  const shuffledRoles = [...roles];
  for (let i = shuffledRoles.length - 1; i > 0; i--) {
    const j = Math.floor(randomFn() * (i + 1));
    [shuffledRoles[i], shuffledRoles[j]] = [shuffledRoles[j], shuffledRoles[i]];
  }

  const assignedRolesMap = {};
  activePlayers.forEach((playerRole, idx) => {
    assignedRolesMap[playerRole] = shuffledRoles[idx] || 'Sin Rol';
  });
  return assignedRolesMap;
}

module.exports = {
  getDefaultModules,
  createInitialGameState,
  getActivePlayers,
  calculateWinner,
  computeTurnOrder,
  getNextAliveTurnIndex,
  evaluateDiceRoll,
  checkScoreEndCondition,
  distributeRolesFisherYates,
};
