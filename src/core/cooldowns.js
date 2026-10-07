'use strict';

/**
 * Gestion des cooldowns par (commande, utilisateur). Pure → testable.
 * Évite le spam de commandes et protège l'API Discord (rate-limits).
 */
class CooldownManager {
  constructor() {
    /** @type {Map<string, number>} clé -> timestamp d'expiration */
    this.expiries = new Map();
    this.lastSweep = 0;
  }

  /**
   * Vérifie et consomme un cooldown.
   * @param {string} key   ex: `ban:123456`
   * @param {number} ms    durée du cooldown
   * @param {number} [now]
   * @returns {number} 0 si autorisé, sinon millisecondes restantes
   */
  hit(key, ms, now = Date.now()) {
    if (!ms || ms <= 0) return 0;
    this.#sweep(now);
    const expiry = this.expiries.get(key);
    if (expiry && expiry > now) return expiry - now;
    this.expiries.set(key, now + ms);
    return 0;
  }

  /** Libère un cooldown (ex: la commande a échoué à cause d'une erreur utilisateur). */
  release(key) {
    this.expiries.delete(key);
  }

  get size() {
    return this.expiries.size;
  }

  /** Nettoie les entrées expirées au plus une fois par minute (mémoire bornée). */
  #sweep(now) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, expiry] of this.expiries) if (expiry <= now) this.expiries.delete(key);
  }
}

module.exports = { CooldownManager };
