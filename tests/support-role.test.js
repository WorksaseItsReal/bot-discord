'use strict';

/**
 * Rôle soutien (SupportRoleService, /automatisations › Rôle soutien) et intent des présences
 * (PRESENCE_INTENT) : tag du serveur, statut personnalisé normalisé, anti-rebond, file bornée,
 * rôle dédié, et compteur « En ligne » jamais proposé avec le cache des présences désactivé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P, Collection, IntentsBitField, GatewayIntentBits, ActivityType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const {
  SupportRoleService,
  wearsGuildTag,
  statusDecision,
  parseStatusText,
  otherAutoRoleUse,
  QUEUE_MAX,
} = require('../src/services/SupportRoleService');
const { hasPresenceIntent, availableTypes } = require('../src/services/StatsCounterService');
const { intents, buildIntents } = require('../src/config/intents');
const { defaultGuildConfig } = require('../src/config/defaults');
const automatisations = require('../src/commands/configuration/automatisations');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) return false;
    await sleep(5);
  }
  return true;
}

const GUILD = '100000000000000001';
const OTHER = '100000000000000002';
const BOT = '999999999999999999';
const ROLE = '300000000000000001';
const ADMIN_ROLE = '300000000000000002';
let seq = 220000000000000000n;

const tagUser = (id, guildId = GUILD, enabled = true) => ({ id, username: 'x', primary_guild: { identity_guild_id: guildId, identity_enabled: enabled, tag: 'GDGT', badge: 'abc' } });
const presence = (userId, status, state = null, extra = []) => ({
  userId,
  guild: { id: GUILD },
  status,
  activities: [...(state != null ? [{ type: ActivityType.Custom, name: 'Custom Status', state }] : []), ...extra],
});

function world({ intent = false } = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const members = new Collection();
  const roles = new Collection();
  const me = { id: BOT, permissions: new PermissionsBitField(PermissionsBitField.All), roles: { highest: { position: 10 } }, user: { id: BOT, bot: true } };
  const guild = { id: GUILD, ownerId: '1', available: true, memberCount: 0, roles: { cache: roles }, members: { cache: members, me, fetch: async () => null }, channels: { cache: new Collection() } };
  const role = { id: ROLE, name: 'Soutien', position: 2, managed: false, guild, permissions: new PermissionsBitField(0n), members: new Collection() };
  roles.set(ROLE, role);
  roles.set(ADMIN_ROLE, { id: ADMIN_ROLE, name: 'Admin', position: 3, managed: false, guild, permissions: new PermissionsBitField(P.Administrator), members: new Collection() });
  const calls = [];
  const addMember = ({ bot = false, has = false } = {}) => {
    const id = String(seq++);
    const cache = new Collection(has ? [[ROLE, role]] : []);
    const member = {
      id,
      guild,
      user: { id, bot },
      roles: {
        cache,
        add: async (rid) => {
          calls.push(['add', id, rid]);
          cache.set(rid, roles.get(rid));
          role.members.set(id, member);
        },
        remove: async (rid) => {
          calls.push(['remove', id, rid]);
          cache.delete(rid);
          role.members.delete(id);
        },
      },
    };
    members.set(id, member);
    if (has) role.members.set(id, member);
    guild.memberCount = members.size;
    return member;
  };
  const client = {
    options: { intents: new IntentsBitField(intent ? [...intents, GatewayIntentBits.GuildPresences] : intents) },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    services: { config },
  };
  const svc = new SupportRoleService({ client, config });
  svc.debounceMs = 40;
  client.services.supportRole = svc;
  return { config, guild, client, svc, role, addMember, calls };
}

// ---------------------------------------------------------------- briques pures

test('tag du serveur : primary_guild brut ou primaryGuild de discord.js, identité active et CE serveur', () => {
  assert.equal(wearsGuildTag(tagUser('1'), GUILD), true);
  assert.equal(wearsGuildTag(tagUser('1', OTHER), GUILD), false, 'tag d\'un autre serveur');
  assert.equal(wearsGuildTag(tagUser('1', GUILD, false), GUILD), false, 'tag masqué');
  assert.equal(wearsGuildTag({ id: '1', primary_guild: null }, GUILD), false);
  assert.equal(wearsGuildTag({ id: '1', primaryGuild: { identityGuildId: GUILD, identityEnabled: true } }, GUILD), true);
  assert.equal(wearsGuildTag({ id: '1', primaryGuild: { identityGuildId: GUILD, identityEnabled: null } }, GUILD), false);
});

test('statut : texte normalisé du statut personnalisé ; « joue » ne compte pas ; hors ligne → rien', () => {
  const text = 'discord.gg/Gadget';
  assert.equal(statusDecision(presence('1', 'online', '✨ Rejoignez DISCORD.GG/gadget !'), text), true, 'majuscules ignorées');
  assert.equal(statusDecision(presence('1', 'idle', 'discord.gg/gadget'), text), true);
  assert.equal(statusDecision(presence('1', 'dnd', 'discord.gg/gadget'), text), true);
  assert.equal(statusDecision(presence('1', 'online', 'autre chose'), text), false, 'en ligne sans le texte → retrait');
  assert.equal(statusDecision(presence('1', 'idle', 'autre chose'), text), null, 'inactif sans le texte → rien');
  assert.equal(statusDecision(presence('1', 'offline', 'discord.gg/gadget'), text), null, 'hors ligne → rien');
  assert.equal(statusDecision(presence('1', 'online', null, [{ type: ActivityType.Playing, name: 'discord.gg/gadget' }]), text), false, '« Joue à » ne compte pas');
  assert.equal(statusDecision(presence('1', 'online', 'Équipe Café'), 'equipe cafe'), true, 'accents ignorés');
  assert.equal(parseStatusText('  discord.gg/x  '), 'discord.gg/x');
  assert.equal(parseStatusText('a'), null);
  assert.equal(parseStatusText('x'.repeat(65)), null);
});

test('rôle dédié : déjà utilisé par une autre attribution automatique → refusé', () => {
  assert.match(otherAutoRoleUse({ welcome: { autoRoles: { humans: [ROLE], bots: [] } } }, ROLE), /arrivée/);
  assert.match(otherAutoRoleUse({ automations: { voiceRole: { channels: [{ channelId: '1', roleId: ROLE }] } } }, ROLE), /vocal/);
  assert.match(otherAutoRoleUse({ automations: { boost: { roleId: ROLE } } }, ROLE), /boosters/);
  assert.match(otherAutoRoleUse({ levels: { rewards: [{ level: 5, roleId: ROLE }] } }, ROLE), /niveau/);
  assert.equal(otherAutoRoleUse(defaultGuildConfig, ROLE), null);
  const { svc, guild, role, config } = world();
  assert.equal(svc.roleIssue(guild, role), null);
  assert.match(svc.roleIssue(guild, guild.roles.cache.get(ADMIN_ROLE)), /modération ou d'administration/, 'jamais un rôle sensible');
  config.update(GUILD, { automations: { boost: { roleId: ROLE } } });
  assert.match(svc.roleIssue(guild, role), /rôle dédié/);
  assert.deepEqual(defaultGuildConfig.support, { enabled: false, roleId: null, source: 'tag', text: null });
});

// ---------------------------------------------------------------- service

test('tag : paquet GUILD_MEMBER_UPDATE → rôle ajouté, puis retiré (anti-rebond par membre)', async () => {
  const { config, svc, addMember, calls } = world();
  config.update(GUILD, { support: { enabled: true, roleId: ROLE, source: 'tag' } });
  const m = addMember();
  assert.equal(svc.handleRawMember({ guild_id: GUILD, user: tagUser(m.id) }), true);
  assert.ok(await until(() => calls.length === 1));
  assert.deepEqual(calls[0], ['add', m.id, ROLE]);
  // Rien à changer : pas de requête.
  assert.equal(svc.handleRawMember({ guild_id: GUILD, user: tagUser(m.id) }), false);
  // Tag retiré juste après : le retrait attend la fin de l'anti-rebond.
  const t0 = Date.now();
  assert.equal(svc.handleRawMember({ guild_id: GUILD, user: { id: m.id, primary_guild: null } }), true);
  assert.ok(await until(() => calls.length === 2));
  assert.deepEqual(calls[1], ['remove', m.id, ROLE]);
  assert.ok(Date.now() - t0 >= 25, 'anti-rebond respecté');
  // Paquet sans primary_guild : aucune information, rien ne change.
  assert.equal(svc.handleRawMember({ guild_id: GUILD, user: { id: m.id } }), false);
  // Bots exclus ; désactivé : inerte.
  const bot = addMember({ bot: true });
  assert.equal(svc.handleRawMember({ guild_id: GUILD, user: { ...tagUser(bot.id), bot: true } }), false);
  config.update(GUILD, { support: { enabled: false } });
  assert.equal(svc.handleRawMember({ guild_id: GUILD, user: tagUser(m.id) }), false);
  await svc.stop();
});

test('file bornée à 200 décisions ; décisions fusionnées par membre', async () => {
  const { config, svc, addMember } = world();
  svc.debounceMs = 60_000;
  config.update(GUILD, { support: { enabled: true, roleId: ROLE, source: 'tag' } });
  // Membres hors cache (aucune vérification préalable possible) : chaque décision est mise en file.
  for (let i = 0; i < QUEUE_MAX; i += 1) {
    const id = String(seq++);
    svc.lastChange.set(`${GUILD}:${id}`, Date.now()); // anti-rebond en cours : rien ne part
    assert.equal(svc.request(GUILD, id, true), true);
  }
  assert.equal(svc.request(GUILD, String(seq++), true), false, '201ᵉ : ignorée');
  assert.equal(svc.stats(GUILD).pending, QUEUE_MAX);
  assert.equal(svc.stats(GUILD).dropped, 1);
  const m = addMember();
  await svc.stop();
  assert.equal(svc.request(GUILD, m.id, true), false, 'arrêté');
});

test('statut : inerte sans l\'intent ; avec l\'intent, présence en ligne / inactif / hors ligne', async () => {
  const off = world();
  off.config.update(GUILD, { support: { enabled: true, roleId: ROLE, source: 'statut', text: 'gadget' } });
  const a = off.addMember();
  assert.equal(off.svc.activeSource(GUILD), null);
  assert.equal(off.svc.handlePresence(presence(a.id, 'online', 'gadget')), false, 'sans intent : rien');
  await off.svc.stop();

  const { config, svc, addMember, calls } = world({ intent: true });
  config.update(GUILD, { support: { enabled: true, roleId: ROLE, source: 'statut', text: 'gadget' } });
  assert.equal(svc.activeSource(GUILD), 'statut');
  const m = addMember();
  assert.equal(svc.handlePresence(presence(m.id, 'offline', null)), false, 'hors ligne : rien');
  assert.equal(svc.handlePresence(presence(m.id, 'idle', 'Fan de Gadget')), true);
  assert.ok(await until(() => calls.length === 1));
  assert.deepEqual(calls[0], ['add', m.id, ROLE]);
  assert.equal(svc.handlePresence(presence(m.id, 'idle', 'rien')), false, 'inactif sans le texte : rien');
  assert.equal(svc.handlePresence(presence(m.id, 'online', 'rien')), true);
  assert.ok(await until(() => calls.length === 2));
  assert.deepEqual(calls[1], ['remove', m.id, ROLE]);
  // Source « tag » : les présences sont ignorées.
  config.update(GUILD, { support: { source: 'tag' } });
  assert.equal(svc.handlePresence(presence(m.id, 'online', 'gadget')), false);
  await svc.stop();
});

test('resynchronisation (tag) : 10 min entre deux ; retrait à tous les porteurs à la désactivation', async () => {
  const { config, svc, guild, addMember, calls } = world();
  config.update(GUILD, { support: { enabled: true, roleId: ROLE, source: 'tag' } });
  const wearer = addMember();
  wearer.user.primaryGuild = { identityGuildId: GUILD, identityEnabled: true };
  const former = addMember({ has: true });
  former.user.primaryGuild = null;
  addMember({ bot: true, has: false });
  assert.deepEqual(svc.resync(guild), { started: true });
  assert.ok(await until(() => calls.length === 2));
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['add', 'remove']);
  const again = svc.resync(guild);
  assert.equal(again.started, false);
  assert.ok(again.retryAt > Date.now() + 9 * 60_000, 'cooldown de 10 min');
  // Désactivation : le rôle est retiré à tous ses porteurs (en arrière-plan).
  config.update(GUILD, { support: { enabled: false } });
  await svc.release(guild, ROLE);
  assert.equal(guild.roles.cache.get(ROLE).members.size, 0);
  assert.deepEqual(calls.at(-1), ['remove', wearer.id, ROLE]);
  await svc.stop();
});

// ---------------------------------------------------------------- intent et compteur « En ligne »

test('intents : GuildPresences seulement avec PRESENCE_INTENT ; cache désactivé → « En ligne » non proposé', () => {
  assert.ok(!intents.includes(GatewayIntentBits.GuildPresences), 'désactivé par défaut');
  assert.ok(buildIntents({ presenceIntent: true }).includes(GatewayIntentBits.GuildPresences));
  assert.ok(!buildIntents({}).includes(GatewayIntentBits.GuildPresences));
  const withIntent = { options: { intents: new IntentsBitField([...intents, GatewayIntentBits.GuildPresences]) } };
  assert.equal(hasPresenceIntent(withIntent), true);
  assert.ok(availableTypes(withIntent).includes('online'));
  const cacheOff = { ...withIntent, presenceCacheDisabled: true };
  assert.equal(hasPresenceIntent(cacheOff), false, 'présences jamais en cache : compteur toujours à 0');
  assert.ok(!availableTypes(cacheOff).includes('online'));
});

test('GadgetClient : PRESENCE_INTENT=on → intent actif, cache des présences à 0, drapeau presenceCacheDisabled', () => {
  const { config } = require('../src/config');
  const { GadgetClient } = require('../src/core/GadgetClient');
  const before = config.presenceIntent;
  try {
    config.presenceIntent = true;
    const client = new GadgetClient();
    assert.ok(client.options.intents.has(GatewayIntentBits.GuildPresences));
    assert.equal(client.presenceCacheDisabled, true);
    const cache = client.options.makeCache({ name: 'PresenceManager' }, {}, {});
    assert.equal(cache.maxSize, 0, 'aucune présence gardée en mémoire');
    config.presenceIntent = false;
    const plain = new GadgetClient();
    assert.ok(!plain.options.intents.has(GatewayIntentBits.GuildPresences));
    assert.equal(plain.presenceCacheDisabled, false);
  } finally {
    config.presenceIntent = before;
  }
});

// ---------------------------------------------------------------- tableau de bord

test('/automatisations : vue Rôle soutien — « indisponible » sans l\'intent, bouton Resynchroniser (tag)', () => {
  const off = world();
  off.client.config = { presenceStatuses: '', presenceIntervalMinutes: 1 };
  off.client.repositories = {};
  off.config.update(GUILD, { support: { enabled: false, roleId: ROLE, source: 'statut', text: 'gadget' } });
  const view = automatisations.render(off.client, off.guild, 'support');
  assert.match(view.embeds[0].data.description, /Indisponible : intent non activé/);
  assert.ok(view.components.length <= 5);
  const ids = view.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  assert.ok(ids.includes('cmd:automatisations:sutext'));
  off.config.update(GUILD, { support: { source: 'tag', enabled: true } });
  const tag = automatisations.render(off.client, off.guild, 'support');
  const tagIds = tag.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  assert.ok(tagIds.includes('cmd:automatisations:susync'));
  assert.ok(tagIds.includes('cmd:automatisations:sutoggle:off'), 'valeur cible');
  assert.doesNotMatch(tag.embeds[0].data.description, /Indisponible/);
});

test('/automatisations : la vue Présence affiche « Source : /bot » quand /bot impose les statuts', () => {
  const { client, guild } = world();
  client.config = { presenceStatuses: '', presenceIntervalMinutes: 1 };
  client.repositories = {};
  client.user = { presence: { activities: [] } };
  client.services.botProfile = { presenceSource: () => 'bot', presenceSettings: () => ({ statuses: [{ type: 3, text: 'imposé' }], intervalMs: 60_000, source: 'bot', invalid: [] }) };
  const view = automatisations.render(client, guild, 'presence');
  const source = view.embeds[0].data.fields.find((f) => /Source/.test(f.name));
  assert.equal(source.value, '/bot');
  assert.match(view.embeds[0].data.description, /imposé/);
  delete client.services.botProfile;
  const plain = automatisations.render(client, guild, 'presence');
  assert.notEqual(plain.embeds[0].data.fields.find((f) => /Source/.test(f.name)).value, '/bot');
});
