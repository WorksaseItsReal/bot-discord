'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SECUR_MODULES, own } = require('../../utils/secur');
const { createLogger } = require('../../core/logger');

const logger = createLogger('secur:registry');

/**
 * Registre des modules Secur, chargés automatiquement depuis src/services/secur/modules/*.js
 * (ordre alphabétique). Chaque fichier exporte UN module (ou un tableau de modules) :
 *
 *   {
 *     key,                                   // clé déclarée dans SECUR_MODULES (utils/secur.js)
 *     auditTypes: [12],                      // types d'audit DÉCLARÉS pour cette clé
 *     classify(entry, guild, ctx),           // null si bénin, sinon { weight ≥ 1, record }
 *     undo?(guild, record, ctx),             // → { ok, note } ; relit l'état et s'abstient s'il a changé
 *     describe?(record),                     // texte court pour la carte d'incident
 *     priority?: 1..5,                       // file d'annulation : 1 rôles … 5 membres et références
 *     targetKey?(record),                    // objet visé (disjoncteur anti-boucle)
 *   }
 *
 * Refusés au chargement : clé absente de SECUR_MODULES, clé déjà chargée, type d'audit que
 * SECUR_MODULES ne déclare pas pour cette clé (type d'un autre module).
 */
class SecurRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this.modules = new Map();
    /** @type {Map<number, object[]>} type d'audit → modules */
    this.byType = new Map();
    /** @type {{ file: string, reason: string }[]} */
    this.failures = [];
  }

  /** Valide puis enregistre un module. Lève une Error s'il est invalide. */
  register(mod) {
    const key = mod?.key;
    if (typeof key !== 'string' || !own(SECUR_MODULES, key)) throw new Error(`Module Secur à clé inconnue : « ${key} » (absente de SECUR_MODULES).`);
    if (this.modules.has(key)) throw new Error(`Module Secur « ${key} » chargé deux fois.`);
    if (typeof mod.classify !== 'function') throw new Error(`Module Secur « ${key} » : classify manquant.`);
    if (mod.undo != null && typeof mod.undo !== 'function') throw new Error(`Module Secur « ${key} » : undo doit être une fonction.`);
    const types = mod.auditTypes ?? [];
    if (!Array.isArray(types) || types.some((t) => !Number.isInteger(t))) throw new Error(`Module Secur « ${key} » : auditTypes invalides.`);
    const declared = SECUR_MODULES[key].auditTypes;
    for (const t of types) {
      if (!declared.includes(t)) {
        const owner = Object.keys(SECUR_MODULES).find((k) => SECUR_MODULES[k].auditTypes.includes(t));
        throw new Error(`Module Secur « ${key} » : le type d'audit ${t} ${owner ? `appartient au module « ${owner} »` : 'n\'est déclaré par aucun module'}.`);
      }
      for (const other of this.byType.get(t) ?? []) {
        if (!SECUR_MODULES[other.key].auditTypes.includes(t)) throw new Error(`Module Secur « ${key} » : type d'audit ${t} déjà pris par « ${other.key} ».`);
      }
    }
    const priority = Number.isInteger(mod.priority) && mod.priority >= 1 && mod.priority <= 5 ? mod.priority : 5;
    const entry = Object.freeze({ ...mod, auditTypes: [...new Set(types)], priority });
    this.modules.set(key, entry);
    for (const t of entry.auditTypes) this.byType.set(t, [...(this.byType.get(t) ?? []), entry]);
    return entry;
  }

  /** Charge les modules d'un dossier (ordre alphabétique). Un fichier invalide est signalé et ignoré. */
  load(dir) {
    if (!fs.existsSync(dir)) return this;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
      try {
        const exported = require(path.join(path.resolve(dir), file));
        for (const mod of [].concat(exported)) this.register(mod);
      } catch (err) {
        this.failures.push({ file, reason: err?.message ?? String(err) });
        logger.error(`Module Secur ${file} refusé :`, err);
      }
    }
    if (this.modules.size) logger.info(`${this.modules.size} module(s) Secur chargé(s) : ${[...this.modules.keys()].join(', ')}.`);
    return this;
  }

  has(key) {
    return typeof key === 'string' && this.modules.has(key);
  }

  get(key) {
    return this.has(key) ? this.modules.get(key) : null;
  }

  /** Modules qui classent ce type d'audit. */
  forType(type) {
    return this.byType.get(type) ?? [];
  }

  keys() {
    return [...this.modules.keys()];
  }
}

module.exports = { SecurRegistry };
