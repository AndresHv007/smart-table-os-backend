import { describe, it, expect } from 'vitest';
import {
  createInitialGameState,
  getActivePlayers,
  calculateWinner,
  computeTurnOrder,
  getNextAliveTurnIndex,
  evaluateDiceRoll,
  checkScoreEndCondition,
  distributeRolesFisherYates,
} from '../src/gameEngine';

describe('SmartTable OS - Game Engine', () => {
  it('filtra jugadores activos excluyendo moderador y eliminados', () => {
    const state = createInitialGameState();
    state.colors = { Norte: 'red', Sur: 'blue', Este: 'moderator', Oeste: 'green' };
    state.moduleStates.turns.deadPlayers = ['Oeste'];

    expect(getActivePlayers(state)).toEqual(['Norte', 'Sur']);
  });

  it('calcula correctamente al ganador con winCondition highest y lowest', () => {
    const state = createInitialGameState();
    state.colors = { Norte: 'red', Sur: 'blue', Este: 'green', Oeste: null };
    state.modules.score.mode = 'individual';
    state.moduleStates.score = { Norte: 12, Sur: 25, Este: 7 };

    state.modules.score.winCondition = 'highest';
    expect(calculateWinner(state)).toEqual({ winner: 'Sur', bestScore: 25 });

    state.modules.score.winCondition = 'lowest';
    expect(calculateWinner(state)).toEqual({ winner: 'Este', bestScore: 7 });
  });

  it('calcula ganador en modo teams y modo global', () => {
    const state = createInitialGameState();
    state.modules.score.mode = 'teams';
    state.modules.score.teams = { team1: { name: 'Rojos' }, team2: { name: 'Azules' } };
    state.moduleStates.score.team1 = 15;
    state.moduleStates.score.team2 = 30;
    expect(calculateWinner(state)).toEqual({ winner: 'team2', bestScore: 30 });

    state.modules.score.mode = 'global';
    state.moduleStates.score.global = 99;
    expect(calculateWinner(state)).toEqual({ winner: 'global', bestScore: 99 });
  });

  it('genera orden de turnos personalizado y rota segun firstPlayer', () => {
    const order = computeTurnOrder(['Norte', 'Sur', 'Este'], {
      orderType: 'custom',
      customOrder: ['Este', 'Sur', 'Norte'],
      firstPlayer: 'Sur',
    });
    expect(order).toEqual(['Sur', 'Norte', 'Este']);

    const ccw = computeTurnOrder(
      ['Norte', 'Sur'],
      { orderType: 'counterclockwise', firstPlayer: 'random' },
      () => 0.1
    );
    expect(ccw).toHaveLength(2);
  });

  it('salta jugadores marcados como muertos al avanzar turno', () => {
    const res = getNextAliveTurnIndex(['Norte', 'Sur', 'Este'], 0, ['Sur']);
    expect(res).toEqual({ nextIndex: 2, nextTurn: 'Este' });

    const allDead = getNextAliveTurnIndex(['Norte', 'Sur'], 0, ['Norte', 'Sur']);
    expect(allDead.nextTurn).toBeNull();

    expect(getNextAliveTurnIndex([], 0, []).nextTurn).toBeNull();
  });

  it('evalua tiradas de dados dentro de rango y detecta golden rolls (single y sum)', () => {
    const roll = evaluateDiceRoll(
      {
        count: 2,
        faces: 6,
        goldenEnabled: true,
        goldenConditions: [
          { type: 'single_exact', value: 6 },
          { type: 'sum_min', value: 12 },
        ],
      },
      'Norte',
      () => 0.99
    );

    expect(roll.values).toEqual([6, 6]);
    expect(roll.total).toBe(12);
    expect(roll.player).toBe('Norte');
    expect(roll.specialIndices).toEqual([0, 1]);
    expect(roll.isTotalSpecial).toBe(true);
  });

  it('evalua condiciones golden single_min, single_max, sum_exact y sum_max', () => {
    const roll = evaluateDiceRoll(
      {
        count: 2,
        faces: 6,
        goldenEnabled: true,
        goldenConditions: [
          { type: 'single_max', value: 1 },
          { type: 'single_min', value: 1 },
          { type: 'sum_exact', value: 2 },
          { type: 'sum_max', value: 3 },
        ],
      },
      'Sur',
      () => 0.0
    );

    expect(roll.values).toEqual([1, 1]);
    expect(roll.specialIndices).toEqual([0, 1]);
    expect(roll.isTotalSpecial).toBe(true);
  });

  it('valida condiciones de fin de partida por puntaje', () => {
    expect(checkScoreEndCondition({ type: 'none', value: 10 }, 20)).toBe(false);
    expect(checkScoreEndCondition({ type: 'points', direction: 'asc', value: 10 }, 10)).toBe(true);
    expect(checkScoreEndCondition({ type: 'points', direction: 'asc', value: 10 }, 9)).toBe(false);
    expect(checkScoreEndCondition({ type: 'points', direction: 'desc', value: 0 }, 0)).toBe(true);
    expect(checkScoreEndCondition({ type: 'points', value: 15 }, 16)).toBe(true);
  });

  it('distribuye roles ocultos con Fisher-Yates sin perder cartas', () => {
    const assigned = distributeRolesFisherYates(
      ['Norte', 'Sur', 'Este'],
      ['Lobo', 'Aldeano', 'Vidente'],
      () => 0.5
    );
    expect(Object.keys(assigned)).toEqual(['Norte', 'Sur', 'Este']);
    expect(Object.values(assigned).sort()).toEqual(['Aldeano', 'Lobo', 'Vidente']);

    const fallback = distributeRolesFisherYates(['Norte', 'Sur'], ['Lobo'], () => 0);
    expect(Object.values(fallback)).toContain('Sin Rol');
  });
});
