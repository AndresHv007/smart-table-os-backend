import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { io as Client } from 'socket.io-client';
import { createDatabase } from '../src/database';
import { createApp } from '../src/app';

describe('SmartTable OS - Socket.IO Real-time Flow', () => {
  let db;
  let instance;
  let port;
  let client1;
  let client2;

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
    client1?.disconnect();
    client2?.disconnect();
    instance.stopTimer();
    await new Promise((resolve) => instance.io.close(resolve));
    db.close();
  });

  it('permite unirse, elegir color, iniciar partida, lanzar dados y avanzar turno', async () => {
    client1 = Client(`http://127.0.0.1:${port}`, { auth: { sessionId: 'sess-1' } });
    client2 = Client(`http://127.0.0.1:${port}`, { auth: { sessionId: 'sess-2' } });

    await Promise.all([
      new Promise((r) => client1.on('connect', r)),
      new Promise((r) => client2.on('connect', r)),
    ]);

    client1.emit('joinRole', { role: 'Norte', name: 'Andres' });
    await new Promise((r) => setTimeout(r, 30));
    client1.emit('selectColor', 'red');
    client2.emit('joinRole', { role: 'Sur', name: 'Luis' });
    await new Promise((r) => setTimeout(r, 30));
    client2.emit('selectColor', 'blue');

    await new Promise((r) => setTimeout(r, 50));
    expect(instance.gameState.host).toBe('Norte');
    expect(instance.gameState.colors.Norte).toBe('red');
    expect(instance.gameState.colors.Sur).toBe('blue');

    client1.emit('loadPreset', 'Catan');
    await new Promise((r) => setTimeout(r, 40));
    expect(instance.gameState.activePreset).toBe('Catan');

    client1.emit('startGame');
    await new Promise((r) => setTimeout(r, 50));
    expect(instance.gameState.status).toBe('PLAYING');

    const activeTurn = instance.gameState.turn;
    const activeClient = activeTurn === 'Norte' ? client1 : client2;
    const rollPromise = new Promise((r) => client1.once('diceRolled', r));
    activeClient.emit('rollDice');
    const roll = await rollPromise;
    expect(roll.values).toHaveLength(2);
    expect(roll.player).toBe(activeTurn);

    activeClient.emit('endTurn');
    await new Promise((r) => setTimeout(r, 40));
    expect(instance.gameState.turn).not.toBe(activeTurn);

    const loginRes = await new Promise((r) => client1.emit('adminLogin', '1234', r));
    expect(loginRes.success).toBe(true);

    // Modulos de votacion, roles ocultos, puntaje y timer
    client1.emit('updateModules', {
      score: { enabled: true, mode: 'individual', initialScore: 0, winCondition: 'highest', endCondition: { type: 'points', value: 10, direction: 'asc' }, teams: {} },
      voting: { enabled: true, mode: 'yes_no', customOptions: [], dynamicCustomOptions: false, showVotesOnReveal: true },
      hiddenRoles: { enabled: true, roleDeck: ['Lobo', 'Aldeano'], hostSeesAll: true },
      timer: { enabled: true, type: 'turn', seconds: 30, autoStart: false, autoPass: false, allowPlayerControls: true },
    });
    await new Promise((r) => setTimeout(r, 30));

    client1.emit('startVote', '¿Cambiamos de mapa?');
    await new Promise((r) => setTimeout(r, 20));
    client1.emit('submitVote', 'Si (A favor)');
    client2.emit('submitVote', 'Si (A favor)');
    client1.emit('revealVote');
    client1.emit('closeVote');

    client1.emit('distributeHiddenRoles', ['Lobo', 'Aldeano']);
    await new Promise((r) => setTimeout(r, 20));
    expect(instance.gameState.moduleStates.hiddenRoles.rolesDistributed).toBe(true);
    client1.emit('clearHiddenRoles');

    client1.emit('startTimer');
    client1.emit('pauseTimer');
    client1.emit('resetTimer');
    client1.emit('advanceRound');
    client1.emit('updateScore', { target: 'Norte', delta: 10 });
    await new Promise((r) => setTimeout(r, 40));
    expect(instance.gameState.status).toBe('FINISHED');
    expect(instance.gameState.winner).toBe('Norte');

    client1.emit('returnToLobby');
    await new Promise((r) => setTimeout(r, 30));
    expect(instance.gameState.status).toBe('LOBBY');
  });
});
