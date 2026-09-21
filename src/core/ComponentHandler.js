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
  }

  loadAll(dir) {
    if (!fs.existsSync(dir)) return this.handlers;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.js')) continue;
      const mod = require(path.join(dir, entry));
      if (!mod?.id || typeof mod.execute !== 'function') {
        logger.warn(`Composant ignoré (structure invalide) : ${entry}`);
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
