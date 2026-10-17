'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Collection, InteractionContextType, ApplicationIntegrationType, ApplicationCommandType } = require('discord.js');
const { createLogger } = require('./logger');

const logger = createLogger('commands');

/**
 * Portées de déploiement : « global » (par défaut, toutes les commandes publiques) et « owner »
 * (console des propriétaires : enregistrée UNIQUEMENT sur le serveur OWNER_GUILD_ID, jamais
 * globalement, voir scripts/deploy-commands.js).
 */
const SCOPES = Object.freeze(['global', 'owner']);

/** Portée d'une commande ('global' si non déclarée). */
function scopeOf(command) {
  return command?.scope ?? 'global';
}

/**
 * Problème de portée d'un module de commande, ou null : portée inconnue, ou commande « owner »
 * sans `ownerOnly` ni permission par défaut (elle serait visible et exécutable). Pur.
 */
function scopeIssue(command) {
  const scope = scopeOf(command);
  if (!SCOPES.includes(scope)) return `portée inconnue « ${scope} »`;
  if (scope === 'owner') {
    if (command.ownerOnly !== true) return 'commande de portée owner sans ownerOnly';
    if (command.data?.toJSON?.().default_member_permissions == null) return 'commande de portée owner sans permission par défaut';
  }
  return null;
}

/**
 * Charge récursivement les modules de commandes depuis src/commands.
 * Chaque module exporte : { data: SlashCommandBuilder, category, execute, autocomplete? }.
 * Menus contextuels (clic droit → Applications) : `data` est un ContextMenuCommandBuilder
 * (type User ou Message), sans description ni options ; le module peut exporter
 * `description` (texte affiché par /help). Même pipeline que les commandes slash.
 */
class CommandHandler {
  constructor() {
    /** @type {Collection<string, object>} */
    this.commands = new Collection();
    /**
     * Fichiers non chargés (erreur, structure invalide, doublon). Les scripts de
     * déploiement et de healthcheck échouent si cette liste n'est pas vide.
     * @type {{ file: string, reason: string }[]}
     */
    this.failures = [];
  }

  /** @param {string} dir dossier des commandes */
  loadAll(dir) {
    dir = path.resolve(dir);
    const files = this.#walk(dir);
    const fail = (file, reason, err) => {
      this.failures.push({ file: path.relative(dir, file), reason });
      if (err) logger.error(`Échec du chargement de ${path.relative(dir, file)} :`, err);
      else logger.warn(`Commande ignorée (${reason}) : ${path.relative(dir, file)}`);
    };
    for (const file of files) {
      try {
        const command = require(file);
        if (!command?.data?.name || typeof command.execute !== 'function') {
          fail(file, 'structure invalide');
          continue;
        }
        command.category = command.category || path.basename(path.dirname(file));
        if (this.commands.has(command.data.name)) {
          fail(file, `doublon de /${command.data.name}`);
          continue;
        }
        applyContexts(command);
        command.data.toJSON(); // valide le builder dès le chargement (erreur explicite si invalide)
        const issue = scopeIssue(command);
        if (issue) {
          fail(file, issue);
          continue;
        }
        this.commands.set(command.data.name, command);
      } catch (err) {
        fail(file, err?.message ?? String(err), err);
      }
    }
    logger.info(`${this.commands.size} commande(s) chargée(s).`);
    return this.commands;
  }

  /** Nombre de fichiers de commandes présents dans un dossier (pour vérification). */
  static countFiles(dir) {
    return new CommandHandler().#walk(path.resolve(dir)).length;
  }

  /**
   * Payload JSON pour l'API REST (déploiement des slash commands), filtré par portée :
   * 'global' (défaut : jamais les commandes « owner »), 'owner' ou 'all'.
   * @param {{ scope?: 'global'|'owner'|'all' }} [opts]
   */
  toJSON({ scope = 'global' } = {}) {
    if (scope !== 'all' && !SCOPES.includes(scope)) throw new Error(`Portée de déploiement inconnue : ${scope}`);
    return this.commands.filter((c) => scope === 'all' || scopeOf(c) === scope).map((c) => c.data.toJSON());
  }

  #walk(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.#walk(full));
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }
}

/**
 * Contexte d'utilisation : par défaut, une commande n'est utilisable que sur un
 * serveur (`guildOnly`). Une commande compatible MP déclare `guildOnly: false`.
 * Remplace l'ancien `setDMPermission`, déprécié par Discord.
 */
function applyContexts(command) {
  const guildOnly = command.guildOnly !== false;
  command.guildOnly = guildOnly;
  if (typeof command.data.setContexts === 'function') {
    command.data.setContexts(guildOnly ? [InteractionContextType.Guild] : [InteractionContextType.Guild, InteractionContextType.BotDM]);
  }
  if (typeof command.data.setIntegrationTypes === 'function') {
    command.data.setIntegrationTypes([ApplicationIntegrationType.GuildInstall]);
  }
  if ('dm_permission' in command.data) command.data.dm_permission = undefined;
}

/** Type d'application command (1 : slash, 2 : menu utilisateur, 3 : menu message). */
function commandType(command) {
  return command?.data?.type ?? ApplicationCommandType.ChatInput;
}

/** Vrai pour un menu contextuel (clic droit → Applications). */
function isContextMenu(command) {
  const type = commandType(command);
  return type === ApplicationCommandType.User || type === ApplicationCommandType.Message;
}

/** Nom affiché d'une commande : `/ban`, ou « Signaler le message » pour un menu contextuel. */
function commandLabel(command) {
  return isContextMenu(command) ? `« ${command.data.name} »` : `/${command.data.name}`;
}

/** Où trouver un menu contextuel : « clic droit sur un message → Applications ». */
function contextMenuWhere(command) {
  return commandType(command) === ApplicationCommandType.Message ? 'Clic droit sur un message → Applications' : 'Clic droit sur un membre → Applications';
}

module.exports = { CommandHandler, applyContexts, commandType, isContextMenu, commandLabel, contextMenuWhere, scopeOf, scopeIssue, SCOPES };
