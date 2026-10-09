'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');
const { createLogger } = require('./logger');

const logger = createLogger('components');

/**
 * Charge les gestionnaires de composants persistants (boutons, menus, modals)
 * depuis src/components. Chaque module exporte : { id, execute(interaction, client) }.
 * Le routage se fait sur le premier segment du customId (`<id>:...`).
 * Cela permet aux composants de survivre à un redémarrage (giveaways, tickets…).
 */
class ComponentHandler {
  constructor() {
    /** @type {Collection<string, object>} */
    this.handlers = new Collection();
    /** @type {{ file: string, reason: string }[]} modules non chargés */
    this.failures = [];
  }

  loadAll(dir) {
    if (!fs.existsSync(dir)) return this.handlers;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.js')) continue;
      let mod;
      try {
        mod = require(path.join(path.resolve(dir), entry));
      } catch (err) {
        this.failures.push({ file: entry, reason: err?.message ?? String(err) });
        logger.error(`Échec du chargement du composant ${entry} :`, err);
        continue;
      }
      if (!mod?.id || typeof mod.execute !== 'function') {
        this.failures.push({ file: entry, reason: 'structure invalide' });
        logger.warn(`Composant ignoré (structure invalide) : ${entry}`);
        continue;
      }
      if (this.handlers.has(mod.id)) {
        this.failures.push({ file: entry, reason: `identifiant « ${mod.id} » en double` });
        logger.warn(`Composant en double ignoré : ${mod.id} (${entry})`);
        continue;
      }
      this.handlers.set(mod.id, mod);
    }
    logger.info(`${this.handlers.size} gestionnaire(s) de composants chargé(s).`);
    return this.handlers;
  }

  /** Retrouve le handler par le préfixe du customId. */
  resolve(customId) {
    const prefix = String(customId).split(':')[0];
    return this.handlers.get(prefix);
  }
}

module.exports = { ComponentHandler };
