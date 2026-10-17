'use strict';

const path = require('node:path');
const { REST, Routes } = require('discord.js');
const { config, validate } = require('../src/config');
const { CommandHandler } = require('../src/core/CommandHandler');
const { logger } = require('../src/core/logger');

/**
 * Enregistre les slash commands.
 *
 *   node scripts/deploy-commands.js                 → serveur DEV_GUILD_ID (instantané),
 *                                                     ou global si DEV_GUILD_ID est vide
 *   node scripts/deploy-commands.js --global        → globalement (jusqu'à 1 h de propagation)
 *   node scripts/deploy-commands.js --clear-guild   → supprime toutes les commandes du serveur
 *                                                     DEV_GUILD_ID (PUT []), utile après un
 *                                                     passage en global pour éviter les doublons
 *   node scripts/deploy-commands.js --dry-run       → affiche ce qui serait déployé (cibles,
 *                                                     nombres, noms), sans appel à l'API ni token
 *   node scripts/deploy-commands.js --skip-owner    → ne déploie que les commandes globales
 *                                                     (avertissement), sans le lot « owner »
 *
 * Commandes de portée « owner » (console /bot des propriétaires) : enregistrées UNIQUEMENT sur
 * le serveur OWNER_GUILD_ID, JAMAIS globalement (sans OWNER_GUILD_ID : avertissement, aucun repli
 * en global). Avant le PREMIER envoi, le script vérifie que le bot est bien sur ce serveur (GET
 * de ses commandes) : sinon (50001, 10004, 403) il s'arrête sans RIEN déployer, pour ne jamais
 * laisser un déploiement à moitié fait.
 *
 *   --global : PUT global (sans les commandes owner), puis PUT sur OWNER_GUILD_ID.
 *   mode dev : DEV_GUILD_ID = OWNER_GUILD_ID → UN SEUL PUT fusionné ; sinon PUT dev puis PUT owner.
 *
 * Sort en code 1 si une commande n'a pas pu être chargée : on ne déploie jamais
 * un jeu de commandes incomplet (cela supprimerait les commandes manquantes).
 */

/** Limites de Discord par cible : 100 commandes slash, 5 menus contextuels de chaque type. */
const MAX_SLASH = 100;
const MAX_MENUS_PER_TYPE = 5;
/** Codes « le bot n'est pas sur ce serveur » renvoyés par le GET de validation. */
const NOT_IN_GUILD_CODES = new Set([50001, 10004]);

/** Nombre de commandes slash et de menus contextuels d'un lot. Pur. */
function countBody(body) {
  const slash = body.filter((c) => (c.type ?? 1) === 1).length;
  const userMenus = body.filter((c) => c.type === 2).length;
  const messageMenus = body.filter((c) => c.type === 3).length;
  return { slash, userMenus, messageMenus, menus: userMenus + messageMenus };
}

/**
 * Plan de déploiement (pur, testé) : cibles dans l'ordre d'envoi, avertissements, erreurs et
 * serveur owner à valider avant le premier PUT.
 * @param {{ global?: boolean, clearGuild?: boolean, skipOwner?: boolean, devGuildId?: string,
 *   ownerGuildId?: string, globalBody?: object[], ownerBody?: object[] }} opts
 * @returns {{ targets: Array<{ kind: 'global'|'guild', guildId?: string, label: string, body: object[], owner?: boolean, merged?: boolean }>,
 *   warnings: string[], errors: string[], validateOwner: string|null }}
 */
function planDeployment({ global = false, clearGuild = false, skipOwner = false, devGuildId = '', ownerGuildId = '', globalBody = [], ownerBody = [] } = {}) {
  const warnings = [];
  const errors = [];
  const targets = [];
  const ownerNames = ownerBody.map((c) => `/${c.name}`).join(', ');
  if (clearGuild && global) {
    errors.push('--clear-guild et --global sont incompatibles.');
    return { targets, warnings, errors, validateOwner: null };
  }
  if (clearGuild) {
    if (!devGuildId) errors.push('--clear-guild nécessite DEV_GUILD_ID dans .env');
    else {
      targets.push({ kind: 'guild', guildId: devGuildId, label: `sur le serveur ${devGuildId}`, body: [] });
      if (ownerGuildId && devGuildId === ownerGuildId) {
        warnings.push(`DEV_GUILD_ID = OWNER_GUILD_ID : les commandes propriétaire${ownerNames ? ` (${ownerNames})` : ''} de ce serveur seront AUSSI supprimées. Relancez « npm run deploy » pour les réenregistrer.`);
      }
    }
    return { targets, warnings, errors, validateOwner: null };
  }

  let ownerGuild = null;
  if (ownerBody.length) {
    if (skipOwner) warnings.push(`--skip-owner : commandes propriétaire (${ownerNames}) NON déployées ; seul le lot global part.`);
    else if (!ownerGuildId) warnings.push(`OWNER_GUILD_ID non défini : commandes propriétaire (${ownerNames}) déployées nulle part (jamais en global). Renseignez OWNER_GUILD_ID dans .env.`);
    else ownerGuild = ownerGuildId;
  }

  const devMode = !global && Boolean(devGuildId);
  if (devMode) {
    if (ownerGuild && ownerGuild === devGuildId) {
      targets.push({ kind: 'guild', guildId: devGuildId, label: `sur le serveur ${devGuildId} (développement + propriétaire, envoi unique)`, body: [...globalBody, ...ownerBody], owner: true, merged: true });
    } else {
      targets.push({ kind: 'guild', guildId: devGuildId, label: `sur le serveur ${devGuildId} (développement)`, body: globalBody });
      if (ownerGuild) targets.push({ kind: 'guild', guildId: ownerGuild, label: `sur le serveur propriétaire ${ownerGuild}`, body: ownerBody, owner: true });
    }
  } else {
    targets.push({ kind: 'global', label: 'globalement', body: globalBody });
    if (ownerGuild) targets.push({ kind: 'guild', guildId: ownerGuild, label: `sur le serveur propriétaire ${ownerGuild}`, body: ownerBody, owner: true });
  }

  for (const t of targets) {
    const n = countBody(t.body);
    if (n.slash > MAX_SLASH) errors.push(`${n.slash} commandes slash ${t.label} : Discord en accepte ${MAX_SLASH} au plus par cible.`);
    if (n.userMenus > MAX_MENUS_PER_TYPE || n.messageMenus > MAX_MENUS_PER_TYPE) errors.push(`Menus contextuels ${t.label} : ${MAX_MENUS_PER_TYPE} au plus de chaque type.`);
  }
  if (targets.some((t) => t.kind === 'global' && t.body.some((c) => ownerBody.some((o) => o.name === c.name)))) {
    errors.push('Une commande propriétaire figure dans le lot global : déploiement refusé.');
  }
  return { targets, warnings, errors, validateOwner: ownerGuild };
}

/** L'erreur du GET de validation signifie-t-elle « le bot n'est pas sur ce serveur » ? Pur. */
function isNotInGuild(err) {
  return NOT_IN_GUILD_CODES.has(err?.code) || err?.status === 403;
}

/** Route REST d'une cible. */
function routeOf(target, clientId) {
  return target.kind === 'guild' ? Routes.applicationGuildCommands(clientId, target.guildId) : Routes.applicationCommands(clientId);
}

async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const global = args.has('--global');
  const dryRun = args.has('--dry-run');
  const clearGuild = args.has('--clear-guild');
  const skipOwner = args.has('--skip-owner');

  let globalBody = [];
  let ownerBody = [];
  if (!clearGuild) {
    const handler = new CommandHandler();
    handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));
    if (handler.failures.length) {
      logger.error(`${handler.failures.length} commande(s) n'ont pas pu être chargée(s) — déploiement annulé :`);
      for (const f of handler.failures) logger.error(`  - ${f.file} : ${f.reason}`);
      process.exit(1);
    }
    globalBody = handler.toJSON({ scope: 'global' });
    ownerBody = handler.toJSON({ scope: 'owner' });
  }

  const plan = planDeployment({ global, clearGuild, skipOwner, devGuildId: config.devGuildId, ownerGuildId: config.ownerGuildId, globalBody, ownerBody });
  if (plan.errors.length) {
    for (const e of plan.errors) logger.error(e);
    process.exit(1);
  }
  for (const w of plan.warnings) logger.warn(w);

  if (dryRun) {
    for (const t of plan.targets) {
      if (clearGuild) {
        logger.info(`[dry-run] Toutes les commandes seraient supprimées ${t.label}.`);
        continue;
      }
      const n = countBody(t.body);
      logger.info(`[dry-run] ${t.body.length} commande(s) seraient déployée(s) ${t.label} (dont ${n.menus} menu(s) contextuel(s)) : ${t.body.map((c) => c.name).sort().join(', ')}`);
    }
    if (plan.validateOwner) logger.info(`[dry-run] Vérification préalable : présence du bot sur le serveur propriétaire ${plan.validateOwner}.`);
    return;
  }

  const errors = validate({ requireToken: true });
  if (errors.length) {
    for (const e of errors) logger.error(`  - ${e}`);
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(config.token);
  // VALIDATION AVANT LE PREMIER PUT : jamais de déploiement à moitié fait.
  if (plan.validateOwner) {
    try {
      await rest.get(Routes.applicationGuildCommands(config.clientId, plan.validateOwner));
    } catch (err) {
      if (isNotInGuild(err)) {
        logger.error(`Déploiement annulé : le bot n'est pas dans OWNER_GUILD_ID (${plan.validateOwner}) ou n'y a pas accès (code ${err?.code ?? err?.status}). Aucune commande n'a été envoyée. Invitez le bot sur ce serveur, corrigez OWNER_GUILD_ID, ou relancez avec --skip-owner.`);
        process.exit(1);
      }
      throw err;
    }
  }
  for (const t of plan.targets) {
    await rest.put(routeOf(t, config.clientId), { body: t.body });
    if (clearGuild) logger.info(`Commandes supprimées ${t.label}.`);
    else logger.info(`${t.body.length} commande(s) déployée(s) ${t.label}.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('Échec du déploiement :', err);
    process.exit(1);
  });
}

module.exports = { planDeployment, countBody, isNotInGuild, MAX_SLASH };
