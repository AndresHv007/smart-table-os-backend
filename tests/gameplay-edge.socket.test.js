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

describe('SmartTable OS - Casos Limite de Gameplay', () => {
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

  it('valida moderador solo para host, deseleccion de color y auto-inicio con setReady', async () => {
    const host = await connectClient('sess-edge-1');
    host.emit('joinRole', { role: 'Norte', name: 'Host' });
    await waitFor(() => instance.gameState.host === 'Norte');

    const player = await connectClient('sess-edge-2');
    player.emit('joinRole', { role: 'Sur', name: 'Jugador' });
    await waitFor(() => instance.gameState.players.Sur !== null);

    // Jugador no-host no puede ser moderador
    const modErr = new Promise((r) => player.once('errorMsg', r));
    player.emit('selectColor', 'moderator');
    expect(await modErr).toContain('Solo el host');

    // Host si puede elegir moderador y luego deseleccionar color
    host.emit('selectColor', 'moderator');
    await waitFor(() => instance.gameState.colors.Norte === 'moderator');
    host.emit('selectColor', null);
    await waitFor(() => instance.gameState.colors.Norte === null);

    // Jugador selecciona color y marca ready -> auto-inicio
    player.emit('selectColor', 'green');
    await waitFor(() => instance.gameState.colors.Sur === 'green');
    player.emit('setReady', true);
    await waitFor(() => instance.gameState.status === 'PLAYING');
    expect(instance.gameState.turn).toBe('Sur');
  });

  it('maneja togglePlayerDead, updateTeam, votacion players/custom y fin por rondas', async () => {
    const host = await connectClient('sess-edge-3');
    host.emit('joinRole', { role: 'Norte', name: 'Norte' });
    await waitFor(() => instance.gameState.host === 'Norte');
    host.emit('selectColor', 'red');

    const p2 = await connectClient('sess-edge-4');
    p2.emit('joinRole', { role: 'Sur', name: 'Sur' });
    await waitFor(() => instance.gameState.players.Sur !== null);
    p2.emit('selectColor', 'blue');
    await waitFor(() => instance.gameState.colors.Sur === 'blue');

    host.emit('updateModules', {
      turns: {
        enabled: true,
        orderType: 'custom',
        customOrder: ['Norte', 'Sur'],
        countRounds: true,
        autoRound: true,
        maxRounds: 1,
        showModeratorPanel: true,
        firstPlayer: 'Norte',
      },
      score: {
        enabled: true,
        mode: 'teams',
        initialScore: 0,
        winCondition: 'highest',
        endCondition: { type: 'rounds', value: 1 },
        teams: { team1: { name: 'Alpha', colorRole: 'Norte' }, team2: { name: 'Beta', colorRole: 'Sur' } },
      },
      voting: { enabled: true, mode: 'players', customOptions: ['A', 'B'], dynamicCustomOptions: false, showVotesOnReveal: false },
    });
    await waitFor(() => instance.gameState.modules.score.mode === 'teams');

    host.emit('updateTeam', { teamId: 'team1', name: 'Dragones', colorRole: 'Norte' });
    await waitFor(() => instance.gameState.modules.score.teams.team1.name === 'Dragones');

    host.emit('startGame');
    await waitFor(() => instance.gameState.status === 'PLAYING');

    // Votacion modo players y luego modo custom
    host.emit('startVote', '¿A quien expulsar?');
    await waitFor(() => instance.gameState.moduleStates.voting.options.includes('Norte'));
    host.emit('updateModules', {
      voting: { enabled: true, mode: 'custom', customOptions: ['Mapa 1', 'Mapa 2'], dynamicCustomOptions: false, showVotesOnReveal: false },
    });
    await waitFor(() => instance.gameState.modules.voting.mode === 'custom');
    host.emit('startVote', '¿Que mapa?', ['Desierto', 'Bosque']);
    await waitFor(() => instance.gameState.moduleStates.voting.options[0] === 'Desierto');

    // Marcar al jugador en turno como muerto salta su turno y luego revivirlo
    host.emit('togglePlayerDead', 'Norte');
    await waitFor(() => instance.gameState.turn === 'Sur');
    host.emit('togglePlayerDead', 'Norte');
    await waitFor(() => !instance.gameState.moduleStates.turns.deadPlayers.includes('Norte'));

    // Avanzar turno desde el ultimo jugador completa ronda 1 -> supera limite y finaliza partida
    host.emit('updateScore', { target: 'team1', delta: 20 });
    host.emit('advanceTurn');
    await waitFor(() => instance.gameState.status === 'FINISHED');
    expect(instance.gameState.winner).toBe('team1');

    // Renombrar la partida recien finalizada
    host.emit('updateGameName', 'Final de Equipos');
    await waitFor(() => db.getGameHistory()[0]?.presetName === 'Final de Equipos');
  });
});
