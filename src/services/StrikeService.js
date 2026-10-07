'use strict';

/** Libellés français des sanctions d'escalade. */
const ACTION_LABELS = { mute: 'Timeout', timeout: 'Timeout', kick: 'Expulsion', ban: 'Bannissement' };

/** « 3 strikes → Timeout (1h) ». Pur. */
function describeThreshold(t) {
  if (!t) return null;
  const label = ACTION_LABELS[t.action] ?? t.action;
  return `${t.strikes} strikes → ${label}${t.duration ? ` (${t.duration})` : ''}`;
}

/**
 * Système de strikes configurable par serveur. À partir d'un nombre de strikes
 * et des paliers définis dans la config, détermine la sanction à appliquer.
 */
class StrikeService {
  /**
   * @param {import('../database/repositories/StrikeRepository').StrikeRepository} repo
   * @param {import('./ConfigService').ConfigService} configService
   */
  constructor(repo, configService) {
    this.repo = repo;
    this.config = configService;
  }

  getCount(guildId, userId) {
    return this.repo.get(guildId, userId);
  }

  /**
   * Ajoute des strikes et renvoie l'action escaladée éventuelle.
   * @returns {{ count:number, action:import('./strike-types').StrikeAction|null }}
   */
  add(guildId, userId, amount = 1) {
    const count = this.repo.add(guildId, userId, amount);
    const action = this.resolveAction(guildId, count);
    return { count, action };
  }

  reset(guildId, userId) {
    this.repo.reset(guildId, userId);
  }

  /**
   * Calcule la sanction correspondant au nombre de strikes courant.
   * Logique pure sur la base des seuils configurés (le plus haut palier atteint).
   * @returns {{ strikes:number, action:string, duration:string|null }|null}
   */
  resolveAction(guildId, count) {
    const { strikes } = this.config.get(guildId);
    if (!strikes?.enabled) return null;
    const thresholds = [...(strikes.thresholds || [])].sort((a, b) => a.strikes - b.strikes);
    let matched = null;
    for (const t of thresholds) {
      if (count >= t.strikes) matched = t;
    }
    return matched;
  }

  /** Prochain palier non encore atteint (ou null). */
  nextThreshold(guildId, count) {
    const { strikes } = this.config.get(guildId);
    if (!strikes?.enabled) return null;
    return [...(strikes.thresholds || [])].sort((a, b) => a.strikes - b.strikes).find((t) => t.strikes > count) ?? null;
  }
}

module.exports = { StrikeService, ACTION_LABELS, describeThreshold };
