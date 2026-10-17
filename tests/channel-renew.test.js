'use strict';

/**
 * ADM2 — /channel renouveler (ChannelRenewService) : bilan (chaque refus, chaque perte, ce qui
 * est reporté), options de la copie, permissions accordées par les surcharges, renouvellement
 * réussi et retour arrière complet quand la suppression échoue.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { FeedRepository } = require('../src/database/repositories/FeedRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { CooldownManager } = require('../src/core/cooldowns');
const { ChannelRenewService, buildPlan, cloneOptions, missingGrantedPermissions, CONFIRM_WORD, _running } = require('../src/services/ChannelRenewService');

const G = '100000000000000001';
const OLD = '200000000000000001';
const NEW = '200000000000000002';
const U = '300000000000000001';

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
/** État complet de la base (configuration stockée comprise, sans son horodatage d'écriture). */
function dump(db) {
  return JSON.stringify(tables(db).filter((t) => t !== '_migrations').map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all().map(({ updated_at: _u, ...r }) => JSON.stringify(t === 'guild_config' ? r : { ...r, updated_at: _u })).sort()]));
}

function textChannel(extra = {}) {
  return { id: OLD, type: ChannelType.GuildText, name: 'général', members: new Map(), isThread: () => false, toString: () => `<#${OLD}>`, ...extra };
}
const guildOf = (extra = {}) => ({ id: G, rulesChannelId: null, publicUpdatesChannelId: null, safetyAlertsChannelId: null, systemChannelId: null, afkChannelId: null, ...extra });

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  return { db, config };
}

test('buildPlan : chaque refus (type, communauté, ticket, ModMail, vocal temporaire, entretien, giveaway, verrou, salon créateur, compteur)', () => {
  const { db, config } = world();
  const plan = (channel, guild = guildOf(), cfg = {}) => buildPlan({ channel, guild, cfg, db, config }).refusals.join(' | ');
  assert.equal(plan(textChannel()), '');
  assert.match(plan(textChannel({ type: ChannelType.PublicThread, isThread: () => true })), /fil/);
  assert.match(plan(textChannel({ type: ChannelType.GuildCategory })), /catégorie/);
  assert.match(plan(textChannel(), guildOf({ rulesChannelId: OLD })), /règles/);
  assert.match(plan(textChannel(), guildOf({ publicUpdatesChannelId: OLD })), /mises à jour/);
  assert.match(plan(textChannel(), guildOf({ safetyAlertsChannelId: OLD })), /alertes de sécurité/);
  assert.match(plan(textChannel(), guildOf(), { tempVoice: { hubChannelId: OLD } }), /créateur/);
  assert.match(plan(textChannel(), guildOf(), { statsCounters: { counters: { members: { channelId: OLD } } } }), /compteur/);

  const now = Date.now();
  db.prepare('INSERT INTO tickets (guild_id, channel_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(G, OLD, U, 'open', now);
  assert.match(plan(textChannel()), /ticket ouvert/);
  db.prepare('DELETE FROM tickets').run();
  db.prepare('INSERT INTO modmail_threads (guild_id, user_id, channel_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run(G, U, OLD, 'open', now);
  assert.match(plan(textChannel()), /ModMail/);
  db.prepare("UPDATE modmail_threads SET status = 'closed'").run();
  assert.doesNotMatch(plan(textChannel()), /ModMail/, 'conversation fermée bloquante');
  db.prepare('INSERT INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)').run(OLD, G, U, now);
  assert.match(plan(textChannel()), /vocal temporaire/);
  db.prepare('DELETE FROM temp_voice').run();
  db.prepare("INSERT INTO applications (guild_id, form_id, form_name, user_id, answers, status, interview_channel_id, created_at) VALUES (?, 1, 'Staff', ?, '[]', 'pending', ?, ?)").run(G, U, OLD, now);
  assert.match(plan(textChannel()), /entretien/);
  db.prepare("UPDATE applications SET status = 'accepted'").run();
  assert.equal(plan(textChannel()), '', 'entretien terminé bloquant');
  db.prepare("INSERT INTO giveaways (guild_id, channel_id, prize, winners, host_id, ends_at, ended, created_at) VALUES (?, ?, 'x', 1, ?, ?, 0, ?)").run(G, OLD, U, now + 1000, now);
  assert.match(plan(textChannel()), /giveaway/);
  db.prepare('UPDATE giveaways SET ended = 1').run();
  assert.equal(plan(textChannel()), '', 'giveaway terminé bloquant');
  db.prepare("INSERT INTO lock_state (guild_id, channel_id, data, created_at) VALUES (?, ?, '[]', ?)").run(G, OLD, now);
  assert.match(plan(textChannel()), /verrouillé/);
  db.prepare('DELETE FROM lock_state').run();
  db.prepare("INSERT INTO timed_channel_actions (guild_id, channel_id, kind, expires_at, created_at) VALUES (?, ?, 'lock', ?, ?)").run(G, OLD, now + 1000, now);
  assert.match(plan(textChannel()), /verrouillé/);
  db.prepare("UPDATE timed_channel_actions SET kind = 'slowmode'").run();
  assert.equal(plan(textChannel()), '', 'mode lent programmé bloquant (il est reporté)');
  // Un autre serveur ne bloque jamais.
  db.prepare('INSERT INTO tickets (guild_id, channel_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?)').run('999999999999999999', OLD, U, 'open', now);
  assert.equal(plan(textChannel()), '');
});

test('buildPlan : chaque perte et chaque report (lignes, configuration, panneaux, salon système, vocal connecté)', () => {
  const { db, config } = world();
  new FeedRepository(db).create({ guildId: G, channelId: OLD, url: 'https://example.com/a.xml' });
  db.prepare('INSERT INTO sticky_messages (guild_id, channel_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(G, OLD, 'Règles', 1, 1);
  db.prepare("INSERT INTO role_menus (guild_id, channel_id, message_id, data, created_at) VALUES (?, ?, '1', '{}', 1)").run(G, OLD);
  config.update(G, { logChannels: { messages: OLD }, tickets: { panelChannelId: OLD, panelMessageId: '5' }, welcome: { verification: { panelChannelId: OLD, panelMessageId: '6' } } });
  const cfg = config.get(G);
  const plan = buildPlan({ channel: textChannel(), guild: guildOf({ systemChannelId: OLD }), cfg, db, config });
  const carried = plan.carried.join('\n');
  const lost = plan.lost.join('\n');
  assert.match(carried, /Flux RSS/);
  assert.match(carried, /sticky/);
  assert.match(carried, /logChannels\.messages/);
  assert.match(carried, /Salon système/);
  assert.match(lost, /messages, fils/);
  assert.match(lost, /Webhooks/);
  assert.match(lost, /Menus de rôles/);
  assert.match(lost, /Panneau des tickets/);
  assert.match(lost, /Panneau de vérification/);
  assert.deepEqual(plan.refusals, []);
  const voice = buildPlan({ channel: textChannel({ type: ChannelType.GuildVoice, members: new Map([['a', {}], ['b', {}]]) }), guild: guildOf(), cfg: {}, db, config });
  assert.match(voice.lost.join('\n'), /2 membre\(s\) connecté\(s\)/);
});

test('cloneOptions : champs de clone() + tags de forum SANS identifiant, réaction, tri, disposition ; réglages vocaux', () => {
  const overwrites = new Map();
  const forum = {
    id: OLD, type: ChannelType.GuildForum, name: 'idées', parentId: '7', rawPosition: 4, topic: 'Règles', nsfw: false, rateLimitPerUser: 5,
    permissionOverwrites: { cache: overwrites },
    availableTags: [{ id: '9', name: 'Bug', moderated: true, emoji: { id: null, name: '🐛' } }],
    defaultReactionEmoji: { id: null, name: '👍' }, defaultSortOrder: 1, defaultForumLayout: 2, defaultThreadRateLimitPerUser: 10, defaultAutoArchiveDuration: 4320,
  };
  const o = cloneOptions(forum, 'raison');
  assert.equal(o.parent, '7');
  assert.equal(o.position, 4);
  assert.equal(o.permissionOverwrites, overwrites);
  assert.deepEqual(o.availableTags, [{ name: 'Bug', moderated: true, emoji: { id: null, name: '🐛' } }]);
  assert.ok(!('id' in o.availableTags[0]));
  assert.deepEqual(o.defaultReactionEmoji, { id: null, name: '👍' });
  assert.equal(o.defaultSortOrder, 1);
  assert.equal(o.defaultForumLayout, 2);
  assert.equal(o.defaultThreadRateLimitPerUser, 10);
  assert.equal(o.defaultAutoArchiveDuration, 4320);
  assert.equal(o.rateLimitPerUser, 5);
  const voice = cloneOptions({ id: OLD, type: ChannelType.GuildVoice, name: 'v', parentId: null, rawPosition: 0, nsfw: true, rateLimitPerUser: 0, bitrate: 96000, userLimit: 5, rtcRegion: 'rotterdam', videoQualityMode: 2, permissionOverwrites: { cache: new Map() } }, 'r');
  assert.deepEqual([voice.bitrate, voice.userLimit, voice.rtcRegion, voice.videoQualityMode, voice.nsfw], [96000, 5, 'rotterdam', 2, true]);
  assert.ok(!('availableTags' in voice));
});

test('surcharges : le bot doit posséder chaque permission qu\'elles ACCORDENT (sauf Administrateur)', () => {
  const overwrites = [{ allow: new PermissionsBitField(P.ViewChannel | P.MentionEveryone) }, { allow: new PermissionsBitField(0n) }];
  assert.deepEqual(missingGrantedPermissions(overwrites, P.ViewChannel | P.ManageChannels | P.ManageRoles), ['MentionEveryone']);
  assert.deepEqual(missingGrantedPermissions(overwrites, P.Administrator), []);
  assert.equal(CONFIRM_WORD, 'RENOUVELER');
});

/** Monde complet pour renew() : base, configuration, faux salon et faux serveur. */
function renewWorld({ deleteFails = false } = {}) {
  const { db, config } = world();
  const feeds = new FeedRepository(db);
  const feed = feeds.create({ guildId: G, channelId: OLD, url: 'https://example.com/a.xml' });
  db.prepare('INSERT INTO sticky_messages (guild_id, channel_id, content, last_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(G, OLD, 'Règles', '42', 1, 1);
  config.update(G, { logChannels: { messages: OLD }, tickets: { panelChannelId: OLD, panelMessageId: '5' } });
  const admin = new PermissionsBitField(P.Administrator);
  const calls = [];
  const created = { id: NEW, rawPosition: 2, async delete() { calls.push('delete-copy'); }, async setPosition() { calls.push('position'); } };
  const guild = {
    ...guildOf({ systemChannelId: OLD }),
    members: { me: { permissions: admin } },
    async edit(body) { calls.push(['guild.edit', body]); },
  };
  const source = {
    ...textChannel(), guild, parentId: null, parent: null, rawPosition: 2, topic: 'Discussion', nsfw: false, rateLimitPerUser: 0, flags: null,
    permissionOverwrites: { cache: new Map() }, permissionsFor: () => admin, manageable: true, deletable: true,
    async delete() {
      calls.push('delete-original');
      if (deleteFails) throw new Error('Missing Permissions');
    },
  };
  guild.channels = {
    cache: new Map([[OLD, source]]),
    async fetch() { return source; },
    async create(opts) { calls.push(['create', opts.name]); return created; },
  };
  const client = { database: { db }, cooldowns: new CooldownManager(), services: { config, secur: { assertAllowed: () => calls.push('secur') } } };
  const interaction = { guild, guildId: G, channelId: 'ailleurs', user: { id: U, tag: 'admin' }, member: {}, memberPermissions: admin };
  return { db, config, feeds, feed, client, interaction, calls, service: new ChannelRenewService({ client }) };
}

test('renouvellement : DELETE en échec → report inverse, copie supprimée, état IDENTIQUE (base et configuration)', async () => {
  const w = renewWorld({ deleteFails: true });
  const before = dump(w.db);
  await assert.rejects(w.service.renew(w.interaction, OLD), /rien n'a changé/);
  assert.equal(dump(w.db), before, 'base ou configuration modifiée');
  assert.equal(w.config.get(G).logChannels.messages, OLD);
  assert.deepEqual(w.calls.filter((c) => typeof c === 'string'), ['secur', 'secur', 'delete-original', 'delete-copy']);
  assert.equal(_running.size, 0, 'verrou du salon non libéré');
});

test('renouvellement réussi : report, messages liés remis à NULL, panneau à republier, salon système, délai de 30 s', async () => {
  const w = renewWorld();
  const result = await w.service.renew(w.interaction, OLD);
  assert.equal(result.created.id, NEW);
  assert.equal(w.config.get(G).logChannels.messages, NEW);
  assert.equal(w.feeds.byId(w.feed.id).channel_id, NEW);
  const sticky = w.db.prepare('SELECT channel_id, last_message_id FROM sticky_messages').get();
  assert.deepEqual({ ...sticky }, { channel_id: NEW, last_message_id: null });
  assert.equal(w.config.get(G).tickets.panelChannelId, NEW);
  assert.equal(w.config.get(G).tickets.panelMessageId, null);
  assert.deepEqual(w.calls.find((c) => Array.isArray(c) && c[0] === 'guild.edit')?.[1].systemChannel, NEW);
  assert.ok(w.calls.indexOf('delete-original') > w.calls.findIndex((c) => Array.isArray(c) && c[0] === 'create'), 'original supprimé avant la création de la copie');
  // Délai par serveur : un second renouvellement est refusé avant toute requête.
  w.interaction.guild.channels.cache.set(OLD, w.interaction.guild.channels.cache.get(OLD));
  const n = w.calls.length;
  await assert.rejects(w.service.renew(w.interaction, OLD), /réessayez dans/);
  assert.equal(w.calls.length, n);
});

test('contrôles natifs (jamais délégables) : « Gérer les salons » exigée de l\'auteur sur le serveur ET sur le salon', () => {
  const w = renewWorld();
  const channel = w.interaction.guild.channels.cache.get(OLD);
  const none = new PermissionsBitField(0n);
  assert.throws(() => w.service.check({ ...w.interaction, memberPermissions: none }, channel), /Gérer les salons/);
  assert.throws(() => w.service.check(w.interaction, { ...channel, permissionsFor: () => none }), /Gérer les salons/);
  // Un grant de délégation (ADM1) n'ouvre rien : seules les permissions natives comptent.
  const delegated = { ...w.interaction, memberPermissions: none, [Symbol.for('gadget.grant')]: { key: 'channel', flags: P.ManageChannels, level: 3 } };
  assert.throws(() => w.service.check(delegated, channel), /Gérer les salons/);
});
