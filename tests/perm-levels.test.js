'use strict';

/**
 * Niveaux de permissions (/permissions, ADM1) : rangs, contrôle central (assertCommandAccess),
 * délégation fermée par défaut, mode strict, cibles et rôles protégés.
 * Règle non négociable vérifiée ici : un niveau ne permet JAMAIS d'utiliser une commande qui
 * protège une action sensible sans la permission Discord qu'elle déclare.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { CommandHandler } = require('../src/core/CommandHandler');
const { ConfigService } = require('../src/services/ConfigService');
const { PermissionService, normalizeSettings } = require('../src/services/PermissionService');
const access = require('../src/utils/access');
const { assertMemberPermissions } = require('../src/events/interactionCreate');
const { requirePermission } = require('../src/services/ModerationService');
const { assertCanModerate } = require('../src/utils/permissions');
const { hasForbiddenPermissions } = require('../src/commands/roles/rolemenu');
const permissionsCommand = require('../src/commands/security/permissions');

const handler = new CommandHandler();
const COMMANDS = handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));

const G = '100000000000000001';
const OWNER = '100000000000000010';
const ADMIN = '100000000000000011';
const MOD = '100000000000000012';
const MEMBER = '100000000000000013';
const TARGET = '100000000000000014';
const BOT = '100000000000000015';
const BOT_OWNER = '100000000000000016';
const R = { l1: '200000000000000001', l2: '200000000000000002', l3: '200000000000000003', wl: '200000000000000004', plain: '200000000000000005', managed: '200000000000000006', shop: '200000000000000007', high: '200000000000000008' };

/** ConfigService réel sur un dépôt en mémoire. */
function memoryConfig() {
  const rows = new Map();
  return new ConfigService({ get: (id) => rows.get(id) ?? null, set: (id, data) => rows.set(id, data), delete: (id) => rows.delete(id) });
}

/** Faux serveur + client complets pour les niveaux. */
function world({ trustBotOwners = false, shopRoles = [] } = {}) {
  const config = memoryConfig();
  const roles = new Map();
  const guild = { id: G, ownerId: OWNER, roles: { cache: roles, everyone: null }, members: { cache: new Map(), me: null }, channels: { cache: new Map() } };
  const client = {
    config: { ownerIds: [BOT_OWNER], securTrustBotOwners: trustBotOwners },
    commands: COMMANDS,
    repositories: { economy: { listItems: () => shopRoles.map((id, i) => ({ id: i + 1, kind: 'role', role_id: id })) } },
    services: { config },
  };
  guild.client = client;
  const addRole = (id, { position = 1, permissions = 0n, managed = false, name = `r${id.slice(-2)}` } = {}) => {
    const role = { id, name, position, managed, guild, permissions: new PermissionsBitField(permissions) };
    roles.set(id, role);
    return role;
  };
  addRole(G, { position: 0, name: '@everyone' });
  for (const [k, id] of Object.entries(R)) addRole(id, { position: k === 'high' ? 50 : 2, managed: k === 'managed' });
  client.services.permissions = new PermissionService({ client, config });
  const member = (id, roleIds = [], perms = []) => {
    const cache = new Map(roleIds.map((r) => [r, roles.get(r)]));
    const highest = Math.max(0, ...roleIds.map((r) => roles.get(r)?.position ?? 0));
    const m = { id, user: { id, bot: id === BOT }, guild, client, roles: { cache, highest: { position: highest } }, permissions: new PermissionsBitField(perms) };
    guild.members.cache.set(id, m);
    return m;
  };
  return { config, guild, client, member, svc: client.services.permissions, addRole };
}

/** Fausse interaction de commande slash. */
function slash(w, member, commandName) {
  return {
    commandName,
    guildId: G,
    guild: w.guild,
    client: w.client,
    member,
    user: { id: member.id },
    memberPermissions: member.permissions,
    inGuild: () => true,
  };
}

/** Faux clic (bouton / menu / formulaire). */
function click(w, member, customId) {
  return { customId, guildId: G, guild: w.guild, client: w.client, member, user: { id: member.id }, memberPermissions: member.permissions, inGuild: () => true };
}

const cmd = (name) => COMMANDS.get(name);
const access_ = (w, i, name) => access.assertCommandAccess(w.client, i, cmd(name), assertMemberPermissions);

/* -------------------------------------------------------------------- */
/* Rangs                                                                  */
/* -------------------------------------------------------------------- */

test('rankOf : propriétaire 5, OWNER_IDS seulement avec SECUR_TRUST_BOT_OWNERS, owner 4, niveaux, Administrateur = 3 (jamais 4)', () => {
  const w = world();
  w.config.update(G, { permissions: { levels: { l1: { roles: [R.l1] }, l2: { roles: [R.l2] }, l3: { roles: [R.l3] } } }, secur: { owners: [MOD] } });
  assert.equal(w.svc.rankOf(w.member(OWNER)), 5);
  assert.equal(w.svc.rankOf(w.member(BOT_OWNER)), 0, 'OWNER_IDS sans confiance : membre');
  assert.equal(world({ trustBotOwners: true }).svc.rankOf(world({ trustBotOwners: true }).member(BOT_OWNER)), 5);
  assert.equal(w.svc.rankOf(w.member(MOD)), 4);
  assert.equal(w.svc.rankOf(w.member(MEMBER, [R.l1])), 1);
  assert.equal(w.svc.rankOf(w.member(MEMBER, [R.l1, R.l3, R.l2])), 3, 'le plus haut niveau l\'emporte');
  assert.equal(w.svc.rankOf(w.member(ADMIN, [], ['Administrator'])), 3);
  assert.equal(w.svc.rankOf(w.member(ADMIN, [R.l1], ['Administrator'])), 3, 'Administrateur vaut 3');
  assert.equal(w.svc.rankOf(w.member(TARGET)), 0);
  // Permissions de l'interaction prioritaires sur celles du membre.
  assert.equal(w.svc.rankOf(w.member(TARGET), { guild: w.guild, permissions: new PermissionsBitField(['Administrator']) }), 3);
  // Un bot n'est jamais owner de sécurité.
  w.config.update(G, { secur: { owners: [BOT] } });
  assert.equal(w.svc.rankOf(w.member(BOT)), 0);
  // @everyone dans un niveau (donnée abîmée) : ignoré.
  w.config.update(G, { permissions: { levels: { l3: { roles: [G] } } } });
  assert.equal(w.svc.levelOf(G, G), 0);
  assert.equal(w.svc.rankOf(w.member(TARGET, [G])), 0);
  // Méthodes liées (passées seules à isSensitiveRole de SEC1).
  const { levelOf, isLevelRole } = w.svc;
  assert.equal(levelOf(G, R.l2), 2);
  assert.equal(isLevelRole(G, R.plain), false);
});

test('normalizeSettings : valeurs abîmées et pollution de prototype ignorées, bornes appliquées', () => {
  const raw = JSON.parse('{"levels":{"l1":{"name":"  Helpers  ","roles":["200000000000000001","x","200000000000000001"]},"l2":null,"l9":{"roles":["200000000000000002"]}},"commands":{"clear":1,"ban":7,"__proto__":2,"Kick":1},"strict":"oui"}');
  const s = normalizeSettings(raw);
  assert.equal(s.levels[1].name, 'Helpers');
  assert.deepEqual(s.levels[1].roles, [R.l1]);
  assert.deepEqual(s.levels[2], { name: null, roles: [] });
  assert.deepEqual(s.commands, { clear: 1 });
  assert.equal(Object.getPrototypeOf(s.commands), Object.prototype);
  assert.equal(s.strict, false);
  const many = normalizeSettings({ levels: { l1: { roles: Array.from({ length: 15 }, (_, i) => `3000000000000000${String(i).padStart(2, '0')}`), name: 'x'.repeat(50) } } });
  assert.equal(many.levels[1].roles.length, 10);
  assert.equal(many.levels[1].name.length, 32);
});

/* -------------------------------------------------------------------- */
/* Contrôle central                                                       */
/* -------------------------------------------------------------------- */

/** Résultat d'un contrôle : 'ok' ou le message d'erreur. */
function outcome(fn) {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err.message;
  }
}

test('sans commande attribuée : assertCommandAccess est STRICTEMENT identique à assertMemberPermissions (toutes les commandes, tous les profils)', () => {
  const w = world();
  // Niveaux configurés mais aucune commande attribuée : chemin historique.
  w.config.update(G, { permissions: { levels: { l3: { roles: [R.l3] } }, strict: true }, secur: { owners: [MOD] } });
  const profiles = [
    w.member(MEMBER, [R.l3]),
    w.member(MOD, [], ['ManageMessages']),
    w.member(TARGET, [], ['BanMembers', 'KickMembers']),
    w.member(ADMIN, [], ['Administrator']),
    w.member(OWNER, [], ['Administrator']),
  ];
  let checks = 0;
  for (const [name, command] of COMMANDS) {
    for (const m of profiles) {
      const i = slash(w, m, name);
      assert.equal(outcome(() => access.assertCommandAccess(w.client, i, command, assertMemberPermissions)), outcome(() => assertMemberPermissions(i, command)), `/${name}`);
      assert.equal(i[access.GRANT], undefined, `/${name} : aucune délégation sans attribution`);
      checks += 1;
    }
  }
  assert.ok(checks > 400, `${checks} contrôles`);
  // Hors serveur et sans service de niveaux : idem.
  const dm = { ...slash(w, profiles[0], 'ban'), inGuild: () => false };
  assert.equal(outcome(() => access.assertCommandAccess(w.client, dm, cmd('ban'), assertMemberPermissions)), 'ok');
  const bare = { commands: COMMANDS, services: {} };
  const i = slash(w, profiles[0], 'ban');
  assert.equal(outcome(() => access.assertCommandAccess(bare, i, cmd('ban'), assertMemberPermissions)), outcome(() => assertMemberPermissions(i, cmd('ban'))));
});

test('RÈGLE NON NÉGOCIABLE : un membre de niveau 3 sans « Bannir des membres » ne peut toujours pas bannir (attribution, mode strict, rang 4)', () => {
  const w = world();
  w.config.update(G, { permissions: { levels: { l3: { roles: [R.l3] } }, commands: { ban: 3, tempban: 1, unban: 1, softban: 1, kick: 1, warn: 1, timeout: 1, untimeout: 1, mute: 1, unmute: 1, sanctions: 1 } } });
  const level3 = w.member(MEMBER, [R.l3], ['ManageMessages', 'ManageChannels']);
  for (const strict of [false, true]) {
    w.config.update(G, { permissions: { strict } });
    for (const name of ['ban', 'tempban', 'softban', 'unban']) {
      const i = slash(w, level3, name);
      assert.throws(() => access_(w, i, name), /Bannir des membres/, `/${name} (strict ${strict})`);
      assert.equal(i[access.GRANT], undefined);
    }
    for (const [name, label] of [['kick', /Expulser/], ['warn', /Exclure temporairement|Modérer/], ['timeout', /Exclure temporairement|Modérer/], ['mute', /Exclure temporairement|Modérer/], ['sanctions', /Exclure temporairement|Modérer/]]) {
      assert.throws(() => access_(w, slash(w, level3, name), name), label, `/${name} (strict ${strict})`);
    }
  }
  // Owner de sécurité (rang 4) sans la permission native : toujours refusé.
  w.config.update(G, { secur: { owners: [TARGET] } });
  const owner4 = w.member(TARGET, [R.l3]);
  assert.equal(w.svc.rankOf(owner4), 4);
  assert.throws(() => access_(w, slash(w, owner4, 'ban'), 'ban'), /Bannir des membres/);
  // Le bouton « Débannir » (cmd:unban:revoke) ne passe pas non plus.
  assert.throws(() => requirePermission(click(w, level3, `cmd:unban:revoke:${TARGET}`), 'BanMembers'), /Bannir des membres/);
  assert.equal(access.hasPermission(click(w, level3, `cmd:ban:x:${TARGET}`), 'BanMembers'), false);
  // Avec la permission native, le niveau ne change rien (hors mode strict).
  const mod = w.member(MOD, [R.l3], ['BanMembers']);
  assert.equal(outcome(() => access_(w, slash(w, mod, 'ban'), 'ban')), 'ok');
});

test('paliers figés : seules /embed, /clear, /slowmode et /pseudo sont délégables ; toute commande sensible déclare une permission jamais déléguée', () => {
  const delegable = [...COMMANDS.keys()].filter((n) => access.isDelegable(n, cmd(n))).sort();
  assert.deepEqual(delegable, ['clear', 'embed', 'pseudo', 'slowmode']);
  for (const name of delegable) {
    assert.equal(access.declaredFlags(cmd(name)) & access.NEVER_DELEGATED_BITS, 0n, `/${name} ne doit déclarer aucune permission sensible`);
  }
  for (const tier of ['moderation', 'high']) {
    for (const name of access.DELEGATION_TIERS[tier].commands) {
      assert.ok(cmd(name), `/${name} existe`);
      assert.equal(access.isDelegable(name, cmd(name)), false);
      assert.notEqual(access.declaredFlags(cmd(name)) & access.NEVER_DELEGATED_BITS, 0n, `/${name} protège une action sensible`);
      assert.ok(access.sensitiveLabels(cmd(name)).length >= 1);
    }
  }
  // /voice n'est pas délégable ; menus contextuels, /bot et /permissions ne sont pas attribuables.
  assert.equal(access.isDelegable('voice', cmd('voice')), false);
  assert.equal(access.isAssignable('permissions', cmd('permissions')), false);
  assert.equal(access.isAssignable('bot', cmd('bot')), false);
  const menu = [...COMMANDS.values()].find((c) => c.data.type === 2 || c.data.type === 3);
  assert.equal(access.isAssignable(menu.data.name, menu), false);
});

test('délégation (palier courant) : accès sans la permission native, délégation posée sur l\'interaction ; rang insuffisant refusé', () => {
  const w = world();
  w.config.update(G, { permissions: { levels: { l1: { roles: [R.l1] }, l2: { roles: [R.l2] } }, commands: { clear: 1, slowmode: 2 } } });
  const l1 = w.member(MEMBER, [R.l1]);
  const i = slash(w, l1, 'clear');
  const grant = access_(w, i, 'clear');
  assert.deepEqual({ ...grant }, { key: 'clear', flags: P.ManageMessages, level: 1, rank: 1 });
  assert.equal(i[access.GRANT], grant);
  // La délégation couvre la permission déclarée, pour CETTE commande seulement.
  assert.equal(access.hasPermission(i, 'ManageMessages'), true);
  assert.equal(access.hasPermission(i, 'ManageChannels'), false);
  assert.equal(access.hasPermission(i, 'Administrator'), false);
  assert.doesNotThrow(() => requirePermission(i, 'ManageMessages'));
  // Niveau 1 pour une commande du niveau 2 : refus natif.
  assert.throws(() => access_(w, slash(w, l1, 'slowmode'), 'slowmode'), /Gérer les salons/);
  assert.equal(outcome(() => access_(w, slash(w, w.member(TARGET, [R.l2]), 'slowmode'), 'slowmode')), 'ok');
  // Membre sans niveau : refus.
  assert.throws(() => access_(w, slash(w, w.member(TARGET), 'clear'), 'clear'), /Gérer les messages/);
  // Délégation posée pour une AUTRE commande (forgée) : ignorée.
  const forged = slash(w, l1, 'slowmode');
  forged[access.GRANT] = grant;
  assert.equal(access.hasPermission(forged, 'ManageMessages'), false);
});

test('mode strict : restriction même avec la permission native ; Administrateur et rang 4 exemptés ; commande ouverte restreignable', () => {
  const w = world();
  w.config.update(G, { permissions: { levels: { l2: { roles: [R.l2] } }, commands: { ban: 2, ping: 1 }, strict: true }, secur: { owners: [OWNER] } });
  const mod = w.member(MOD, [], ['BanMembers']);
  assert.throws(() => access_(w, slash(w, mod, 'ban'), 'ban'), /réservée au \*\*niveau 2\*\*/);
  assert.equal(outcome(() => access_(w, slash(w, w.member(ADMIN, [], ['Administrator']), 'ban'), 'ban')), 'ok');
  assert.equal(outcome(() => access_(w, slash(w, w.member(TARGET, [R.l2], ['BanMembers']), 'ban'), 'ban')), 'ok');
  w.config.update(G, { secur: { owners: [MEMBER] } });
  assert.equal(outcome(() => access_(w, slash(w, w.member(MEMBER, [], ['BanMembers']), 'ban'), 'ban')), 'ok', 'owner de sécurité exempté');
  // Niveau 2 SANS la permission : toujours refusé (le strict ne donne rien).
  assert.throws(() => access_(w, slash(w, w.member(TARGET, [R.l2]), 'ban'), 'ban'), /Bannir des membres/);
  // Commande ouverte à tous restreinte au niveau 1.
  assert.throws(() => access_(w, slash(w, w.member(TARGET), 'ping'), 'ping'), /niveau 1/);
  w.config.update(G, { permissions: { strict: false } });
  assert.equal(outcome(() => access_(w, slash(w, mod, 'ban'), 'ban')), 'ok', 'strict coupé : comportement d\'avant');
  assert.equal(outcome(() => access_(w, slash(w, w.member(TARGET), 'ping'), 'ping')), 'ok');
  // Boutons : le mode strict s'applique aussi via requirePermission.
  w.config.update(G, { permissions: { strict: true } });
  assert.throws(() => requirePermission(click(w, mod, `cmd:ban:x:${TARGET}`), 'BanMembers'), /niveau 2/);
});

test('commandKeyOf : seulement « cmd:<commande>: » ; la délégation ne couvre que la commande du customId', () => {
  assert.equal(access.commandKeyOf('ticket:ban:1'), null);
  assert.equal(access.commandKeyOf('giveaway:clear:1'), null);
  assert.equal(access.commandKeyOf('secur:restore:1'), null);
  assert.equal(access.commandKeyOf('cmd:_:delete:1'), null);
  assert.equal(access.commandKeyOf('cmd:unban:revoke:1'), 'unban');
  assert.equal(access.commandKeyOf('cmd:slowmode:set:1:0:2'), 'slowmode');
  assert.equal(access.commandKeyOf('cmd:'), null);
  assert.equal(access.commandKeyOf(undefined), null);

  const w = world();
  w.config.update(G, { permissions: { levels: { l1: { roles: [R.l1] } }, commands: { clear: 1, slowmode: 1, unban: 1 } } });
  const l1 = w.member(MEMBER, [R.l1]);
  assert.equal(access.hasPermission(click(w, l1, 'cmd:slowmode:set:1:0:2'), 'ManageChannels'), true);
  assert.equal(access.hasPermission(click(w, l1, 'ticket:slowmode:1'), 'ManageChannels'), false, 'préfixe autre que cmd:');
  assert.equal(access.hasPermission(click(w, l1, 'cmd:clear:x'), 'ManageChannels'), false, 'délégation de /clear ≠ Gérer les salons');
  assert.equal(access.hasPermission(click(w, l1, 'cmd:antiraid:go:home'), 'Administrator'), false);
  assert.equal(access.grantOf(click(w, l1, 'cmd:unban:revoke:1')), null, '/unban attribuée mais jamais déléguée');
  // Rang relu à chaque clic : le rôle retiré, la délégation disparaît.
  const later = w.member(MEMBER, []);
  assert.equal(access.hasPermission(click(w, later, 'cmd:slowmode:set:1:0:2'), 'ManageChannels'), false);
  // Composant forgé avec une délégation posée pour une autre commande : ignorée.
  const forged = click(w, l1, 'cmd:antiraid:go:home');
  forged[access.GRANT] = Object.freeze({ key: 'clear', flags: P.Administrator, level: 1, rank: 1 });
  assert.equal(access.hasPermission(forged, 'Administrator'), false);
});

test('memberCanIn : natif dans le salon, sinon délégation + « Voir le salon » natif ; jamais une permission sensible', () => {
  const w = world();
  w.config.update(G, { permissions: { levels: { l1: { roles: [R.l1] } }, commands: { slowmode: 1 } } });
  const l1 = w.member(MEMBER, [R.l1]);
  const chan = (bits) => ({ permissionsFor: () => new PermissionsBitField(bits) });
  const i = click(w, l1, 'cmd:slowmode:set:1:0:2');
  assert.equal(access.memberCanIn(i, chan(['ViewChannel']), [P.ManageChannels]), true);
  assert.equal(access.memberCanIn(i, chan([]), [P.ManageChannels]), false, 'salon invisible');
  assert.equal(access.memberCanIn(i, chan(['ViewChannel']), [P.ManageChannels, P.ManageRoles]), false, 'Gérer les permissions jamais déléguée');
  assert.equal(access.memberCanIn(click(w, w.member(TARGET), 'cmd:slowmode:set:1'), chan(['ViewChannel']), [P.ManageChannels]), false);
  assert.equal(access.memberCanIn(click(w, w.member(TARGET), 'cmd:slowmode:set:1'), chan(['ViewChannel', 'ManageChannels']), [P.ManageChannels]), true, 'permission native');
  assert.equal(access.memberCanIn(i, null, [P.ManageChannels]), false);
});

/* -------------------------------------------------------------------- */
/* Rôles et cibles protégés                                               */
/* -------------------------------------------------------------------- */

test('hasForbiddenPermissions : vrai pour un rôle de niveau et un rôle de whitelist, faux après leur retrait', () => {
  const w = world();
  const role = w.guild.roles.cache.get(R.plain);
  assert.equal(hasForbiddenPermissions(role), false);
  w.config.update(G, { permissions: { levels: { l1: { roles: [R.plain] } } } });
  assert.equal(hasForbiddenPermissions(role), true);
  w.config.update(G, { permissions: { levels: { l1: { roles: [] } } } });
  assert.equal(hasForbiddenPermissions(role), false);
  w.config.update(G, { whitelist: { roles: [R.plain] } });
  assert.equal(hasForbiddenPermissions(role), true);
  w.config.update(G, { whitelist: { roles: [] } });
  assert.equal(hasForbiddenPermissions(role), false);
  // Rôle sans serveur (anciens tests, objets partiels) : seules les permissions comptent.
  assert.equal(hasForbiddenPermissions({ id: R.plain, permissions: new PermissionsBitField([]) }), false);
});

test('/permissions niveau : refuse @everyone, un rôle géré, un rôle de boutique, un rôle au-dessus de l\'auteur, un rôle d\'un autre niveau', () => {
  const w = world({ shopRoles: [R.shop] });
  w.config.update(G, { permissions: { levels: { l2: { roles: [R.l2] } } } });
  const admin = w.member(ADMIN, [R.l3], ['Administrator']);
  admin.roles.highest.position = 10;
  const i = slash(w, admin, 'permissions');
  const issue = (id) => permissionsCommand.levelRoleIssue(w.client, i, w.guild.roles.cache.get(id), { adding: true });
  assert.match(issue(G), /@everyone/);
  assert.match(issue(R.managed), /géré/);
  assert.match(issue(R.shop), /boutique/);
  assert.match(issue(R.high), /au-dessus/);
  assert.equal(issue(R.plain), null);
  const res = permissionsCommand.setLevelRoles(w.client, i, 1, [R.plain, R.l2, R.shop]);
  assert.equal(res.changed, true);
  assert.deepEqual(w.svc.settings(G).levels[1].roles, [R.plain]);
  assert.equal(res.refused.length, 2);
  assert.match(res.refused.join(' '), /niveau 2/);
  // Le propriétaire (rang 5) peut choisir un rôle au-dessus du sien.
  const owner = w.member(OWNER, [], ['Administrator']);
  assert.equal(permissionsCommand.levelRoleIssue(w.client, slash(w, owner, 'permissions'), w.guild.roles.cache.get(R.high), { adding: true }), null);
  // Autre attribution automatique (rôle d'arrivée) refusée.
  w.config.update(G, { welcome: { autoRoles: { humans: [R.l1], bots: [] } } });
  assert.match(issue(R.l1), /arrivée/);
  // Pas de changement → aucune ligne de log.
  assert.equal(permissionsCommand.setLevelRoles(w.client, i, 1, [R.plain]).changed, false);
});

test('attribution : sanctions lourdes réservées au propriétaire, modération aux owners, palier courant à l\'Administrateur ; double attribution sans changement', () => {
  const w = world();
  const admin = w.member(ADMIN, [], ['Administrator']);
  const owner = w.member(OWNER, [], ['Administrator']);
  const ai = slash(w, admin, 'permissions');
  assert.throws(() => permissionsCommand.assignCommand(w.client, ai, 'ban', cmd('ban'), 3), /propriétaire du serveur/);
  assert.throws(() => permissionsCommand.assignCommand(w.client, ai, 'kick', cmd('kick'), 1), /owners de sécurité/);
  assert.equal(permissionsCommand.assignCommand(w.client, ai, 'clear', cmd('clear'), 1).changed, true);
  assert.equal(permissionsCommand.assignCommand(w.client, ai, 'clear', cmd('clear'), 1).changed, false, 'double clic : un seul changement');
  assert.equal(permissionsCommand.assignCommand(w.client, ai, 'ping', cmd('ping'), 2).changed, true, 'hors palier : restriction');
  assert.throws(() => permissionsCommand.assignCommand(w.client, ai, 'permissions', cmd('permissions'), 1), /ne peut pas être attribuée/);
  assert.throws(() => permissionsCommand.assignCommand(w.client, ai, 'clear', cmd('clear'), 4), /Niveau invalide/);
  const oi = slash(w, owner, 'permissions');
  const res = permissionsCommand.assignCommand(w.client, oi, 'ban', cmd('ban'), 2);
  assert.equal(res.changed, true);
  assert.match(res.line, /\/ban \(restriction\) : aucun → niveau 2/);
  // Un administrateur ne peut pas non plus RETIRER la restriction du propriétaire.
  assert.throws(() => permissionsCommand.assignCommand(w.client, ai, 'ban', cmd('ban'), 0), /propriétaire du serveur/);
  // Owner de sécurité : modération oui, sanctions lourdes non.
  w.config.update(G, { secur: { owners: [ADMIN] } });
  assert.equal(permissionsCommand.assignCommand(w.client, ai, 'kick', cmd('kick'), 2).changed, true);
  assert.throws(() => permissionsCommand.assignCommand(w.client, ai, 'softban', cmd('softban'), 2), /propriétaire du serveur/);
  assert.deepEqual(w.svc.settings(G).commands, { clear: 1, ping: 2, ban: 2, kick: 2 });
  // Retrait : la clé passe à null (ignorée à la lecture).
  permissionsCommand.assignCommand(w.client, oi, 'ban', cmd('ban'), 0);
  assert.equal(w.svc.assignedLevel(G, 'ban'), 0);
});

test('assertCanModerate : cible de rang supérieur refusée, owner de sécurité intouchable sauf pour le propriétaire, le bot non concerné', () => {
  const w = world();
  w.config.update(G, { permissions: { levels: { l1: { roles: [R.l1] } } }, secur: { owners: [TARGET] } });
  const me = w.member(BOT, [], ['Administrator']);
  me.roles.highest.position = 100;
  const mod = w.member(MOD, [], ['BanMembers']);
  mod.roles.highest.position = 20;
  const helper = w.member(MEMBER, [R.l1]);
  assert.throws(() => assertCanModerate(mod, helper, me, { action: 'bannir' }), /niveau de permissions \(1\) est supérieur au vôtre \(0\)/);
  const admin = w.member(ADMIN, [], ['Administrator']);
  admin.roles.highest.position = 30;
  assert.doesNotThrow(() => assertCanModerate(admin, helper, me, { action: 'bannir' }));
  const securOwner = w.member(TARGET, []);
  assert.throws(() => assertCanModerate(admin, securOwner, me, { action: 'bannir' }), /owner de sécurité/);
  const owner = w.member(OWNER, []);
  assert.doesNotThrow(() => assertCanModerate(owner, securOwner, me, { action: 'bannir' }));
  // AutoMod (le bot) : pas de comparaison de rang.
  assert.doesNotThrow(() => assertCanModerate(me, helper, me, { action: 'timeout' }));
});

test('surcharges Intégrations : visible (rôle du niveau ou @everyone), masquée, repli sur la surcharge de l\'application, inconnue', () => {
  const guild = { id: G };
  const status = (entries, names = [['900', 'clear'], ['901', 'slowmode']]) => ({ at: 0, error: null, appId: BOT, names: new Map(names), entries: new Map(entries) });
  assert.equal(PermissionService.visibility(status([['900', [{ id: R.l1, type: 1, permission: true }]]]), guild, 'clear', [R.l1]), 'visible');
  assert.equal(PermissionService.visibility(status([['900', [{ id: G, type: 1, permission: true }]]]), guild, 'clear', [R.l1]), 'visible');
  assert.equal(PermissionService.visibility(status([['900', [{ id: R.l1, type: 1, permission: false }]]]), guild, 'clear', [R.l1]), 'hidden');
  assert.equal(PermissionService.visibility(status([]), guild, 'clear', [R.l1]), 'hidden');
  assert.equal(PermissionService.visibility(status([[BOT, [{ id: R.l1, type: 1, permission: true }]]]), guild, 'slowmode', [R.l1]), 'visible', 'surcharge de l\'application');
  assert.equal(PermissionService.visibility(status([['901', []], [BOT, [{ id: R.l1, type: 1, permission: true }]]]), guild, 'slowmode', [R.l1]), 'hidden', 'surcharge de commande prioritaire');
  assert.equal(PermissionService.visibility(status([], []), guild, 'clear', [R.l1]), 'unknown', 'commande non enregistrée');
  assert.equal(PermissionService.visibility({ error: 'Missing Access' }, guild, 'clear', [R.l1]), 'unknown');
});

test('lecture des surcharges : cache de 5 minutes, échec toléré, relecture forcée bornée', async () => {
  const w = world();
  let calls = 0;
  let fail = false;
  w.client.application = { id: BOT, commands: { cache: new Map([['900', { id: '900', name: 'clear' }]]) } };
  w.guild.commands = {
    cache: new Map(),
    permissions: {
      fetch: async () => {
        calls += 1;
        if (fail) throw new Error('Missing Access');
        return new Map([['900', [{ id: R.l1, type: 1, permission: true }]]]);
      },
    },
  };
  const first = await w.svc.integrationOverrides(w.guild);
  assert.equal(first.error, null);
  assert.equal(first.names.get('900'), 'clear');
  await w.svc.integrationOverrides(w.guild);
  assert.equal(calls, 1, 'cache');
  await w.svc.integrationOverrides(w.guild, { force: true });
  assert.equal(calls, 1, 'relecture forcée bornée à une fois par 30 s');
  w.svc.overrides.get(G).at -= 31_000;
  fail = true;
  const failed = await w.svc.integrationOverrides(w.guild, { force: true });
  assert.equal(calls, 2);
  assert.match(failed.error, /Missing Access/);
  assert.equal(PermissionService.visibility(failed, w.guild, 'clear', [R.l1]), 'unknown');
  w.svc.forgetGuild(G);
  assert.equal(w.svc.overrides.has(G), false);
});

test('autocomplétion de /permissions commande : vide sans Administrateur, palier courant d\'abord, 25 au plus', async () => {
  const w = world();
  const respond = [];
  const ac = (member, value) => ({
    inGuild: () => true,
    guildId: G,
    memberPermissions: member.permissions,
    options: { getFocused: () => ({ name: 'nom', value }) },
    respond: async (list) => respond.push(list),
  });
  await permissionsCommand.autocomplete(ac(w.member(MEMBER), ''), w.client);
  assert.deepEqual(respond.pop(), []);
  await permissionsCommand.autocomplete(ac(w.member(ADMIN, [], ['Administrator']), ''), w.client);
  const list = respond.pop();
  assert.ok(list.length <= 25 && list.length > 10);
  assert.deepEqual(list.slice(0, 4).map((c) => c.value), ['embed', 'clear', 'slowmode', 'pseudo']);
  assert.ok(list.every((c) => c.name.length <= 100));
  assert.ok(!list.some((c) => c.value === 'permissions' || c.value === 'bot'));
  await permissionsCommand.autocomplete(ac(w.member(ADMIN, [], ['Administrator']), '/ban'), w.client);
  assert.ok(respond.pop().some((c) => c.value === 'ban' && /restriction/.test(c.name)));
});
