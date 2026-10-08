'use strict';

/** Libellés français des sanctions d'escalade. */
const ACTION_LABELS = { mute: 'Timeout', timeout: 'Timeout', kick: 'Expulsion', ban: 'Bannissement' };

/** Permission que l'INVOCATEUR de /warn doit avoir pour qu'un palier soit appliqué. */
const ACTION_PERMISSIONS = { mute: 'ModerateMembers', timeout: 'ModerateMembers', kick: 'KickMembers', ban: 'BanMembers' };

/**
 * Préfixe de la raison des sanctions d'escalade (« Escalade automatique (palier de
 * 5 strikes) »). La raison n'est QUE descriptive : le palier appliqué est stocké dans
 * la colonne `sanctions.escalation_step` (migration 10), le texte libre d'une raison
 * pouvant être imité par n'importe quel modérateur.
 */
const ESCALATION_PREFIX = 'Escalade automatique (';

/** Raison d'une sanction d'escalade pour le palier `t`. Pur. */
function escalationReason(t) {
  return `${ESCALATION_PREFIX}palier de ${t.strikes} strikes)`;
}

/**
 * Palier encodé dans une raison d'escalade (ancien format « (N strikes) » accepté), sinon 0. Pur.
 * Affichage / reprise d'historique uniquement : ne sert plus à décider d'une escalade.
 */
function parseEscalationLevel(reason) {
  const m = /^Escalade automatique \((?:palier de )?(\d+) strikes\)/.exec(reason ?? '');
  return m ? Number(m[1]) : 0;
}

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

  /**
   * Palier d'escalade à appliquer maintenant.
   *
   * Règle : on applique le PLUS HAUT palier atteint (count >= seuil) s'il est
   * strictement au-dessus du plus haut palier déjà appliqué (`appliedLevel`).
   *  - un palier n'est jamais réappliqué à chaque warn suivant ;
   *  - un palier manqué (permission manquante, échec, ajout de plusieurs strikes,
   *    seuils modifiés) est rattrapé au warn suivant ;
   *  - si plusieurs paliers sont dépassés d'un coup, seul le plus sévère s'applique.
   * @returns {{ strikes:number, action:string, duration:string|null }|null}
   */
  pendingEscalation(guildId, count, appliedLevel = 0) {
    const matched = this.resolveAction(guildId, count);
    return matched && matched.strikes > appliedLevel ? matched : null;
  }

  /** Prochain palier non encore atteint (ou null). */
  nextThreshold(guildId, count) {
    const { strikes } = this.config.get(guildId);
    if (!strikes?.enabled) return null;
    return [...(strikes.thresholds || [])].sort((a, b) => a.strikes - b.strikes).find((t) => t.strikes > count) ?? null;
  }
}

module.exports = { StrikeService, ACTION_LABELS, ACTION_PERMISSIONS, ESCALATION_PREFIX, escalationReason, parseEscalationLevel, describeThreshold };
