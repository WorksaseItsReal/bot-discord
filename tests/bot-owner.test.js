'use strict';

/**
 * Console /bot des propriétaires : présence imposée prioritaire, URL de stream, portée « owner »
 * (toJSON, contrôle au chargement), autocomplétion revérifiée elle-même, /help qui masque /bot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ActivityType, Collection, PermissionsBitField, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const P = require('../src/utils/presence');
const { BotProfileService } = require('../src/services/BotProfileService');
const { CommandHandler, scopeIssue, scopeOf } = require('../src/core/CommandHandler');
const bot = require('../src/commands/configuration/bot');
const help = require('../src/commands/information/help');

const OWNER = '300000000000000001';
const ADMIN = '300000000000000002';
const OWNER_GUILD = '300000000000000010';
const OTHER_GUILD = '300000000000000011';

/** Dépôt bot_settings en mémoire. */
function memorySettings() {
  const map = new Map();
  return { map, get: (k) => (map.has(k) ? JSON.parse(map.get(k)) : null), set: (k, v) => map.set(k, JSON.stringify(v)), delete: (k) => map.delete(k) };
}

/** Client minimal : présence enregistrée, deux serveurs. */
function fakeClient({ config = {} } = {}) {
  const presences = [];
  const client = {
    config: { ownerIds: [OWNER], ownerGuildId: OWNER_GUILD, presenceStatuses: 'joue:depuis le .env', presenceIntervalMinutes: 5, ...config },
    user: { setPresence: (p) => presences.push(p) },
    guilds: { cache: new Collection([[OWNER_GUILD, { id: OWNER_GUILD, name: 'QG', memberCount: 3 }], [OTHER_GUILD, { id: OTHER_GUILD, name: 'Serveur client', memberCount: 50 }]]) },
  };
  client.services = { botProfile: new BotProfileService({ client, settings: memorySettings() }) };
  return { client, presences };
}

test('présence : activité imposée par /bot prioritaire sur PRESENCE_STATUSES, statut imposé partout, minuteur unique', () => {
  const { client, presences } = fakeClient();
  const profile = client.services.botProfile;
  assert.equal(profile.presenceSource(), 'env');
  profile.startPresence();
  assert.deepEqual(presences.at(-1), { activities: [{ name: 'depuis le .env', type: ActivityType.Playing }], status: 'online' });
  const first = client.presenceTimer;
  profile.setActivity({ type: ActivityType.Watching, text: '{serveurs} serveurs' }, OWNER);
  assert.notEqual(client.presenceTimer, first, 'minuteur remplacé, jamais dupliqué');
  assert.equal(profile.presenceSource(), 'bot');
  assert.deepEqual(presences.at(-1), { activities: [{ name: '2 serveurs', type: ActivityType.Watching }], status: 'online' });
  profile.setStatus('dnd', OWNER);
  assert.equal(presences.at(-1).status, 'dnd');
  assert.equal(presences.at(-1).activities[0].name, '2 serveurs');
  profile.clearActivity(OWNER);
  assert.equal(profile.presenceSource(), 'env');
  assert.deepEqual(presences.at(-1), { activities: [{ name: 'depuis le .env', type: ActivityType.Playing }], status: 'dnd' }, 'statut imposé conservé pour la rotation');
  profile.setStatus('online', OWNER);
  assert.equal(profile.presenceOverride(), null, 'plus rien d\'imposé : ligne supprimée');
  clearInterval(client.presenceTimer);
  // Sans PRESENCE_STATUSES : « defaut ».
  const { client: c2 } = fakeClient({ config: { presenceStatuses: '' } });
  assert.equal(c2.services.botProfile.presenceSource(), 'defaut');
  // Activité imposée abîmée en base : ignorée (rotation).
  const fx = fakeClient();
  fx.client.services.botProfile.settings.set('presence', { activity: { type: 99, text: '' }, status: 'nimporte' });
  const eff = fx.client.services.botProfile.presenceSettings();
  assert.equal(eff.source, 'env');
  assert.equal(eff.status, 'online');
});

test('activités : stream (URL twitch.tv / youtube.com en https), statut personnalisé, saisies refusées', () => {
  assert.equal(P.parseStreamUrl('https://www.twitch.tv/gadget'), 'https://www.twitch.tv/gadget');
  assert.equal(P.parseStreamUrl('https://youtube.com/watch?v=abc'), 'https://youtube.com/watch?v=abc');
  for (const bad of ['http://twitch.tv/gadget', 'https://twitch.tv.evil.example/x', 'https://evil.example/twitch.tv', 'https://twitch.tv/', 'https://user:pw@twitch.tv/x', 'https://twitch.tv:8443/x', 'javascript:alert(1)', 'twitch.tv/gadget', '']) {
    assert.equal(P.parseStreamUrl(bad), null, bad);
  }
  assert.deepEqual(bot.readActivity('stream', 'En direct !', 'https://twitch.tv/gadget'), { type: ActivityType.Streaming, text: 'En direct !', url: 'https://twitch.tv/gadget' });
  assert.throws(() => bot.readActivity('stream', 'En direct !', 'https://evil.example/live'), /twitch\.tv/);
  assert.throws(() => bot.readActivity('stream', 'En direct !', null), /twitch\.tv/);
  assert.throws(() => bot.readActivity('joue', 'Jeu', 'https://twitch.tv/gadget'), /stream/);
  assert.throws(() => bot.readActivity('joue', '   ', null), /vide/);
  assert.throws(() => bot.readActivity('joue', 'x'.repeat(129), null), /128/);
  assert.throws(() => bot.readActivity('inconnu', 'x', null), /inconnu/);
  assert.deepEqual(bot.readActivity('participe', 'Tournoi', null), { type: ActivityType.Competing, text: 'Tournoi' });
  assert.deepEqual(P.renderStatus({ type: ActivityType.Custom, text: 'Disponible' }), { name: 'Custom Status', state: 'Disponible', type: ActivityType.Custom });
  assert.deepEqual(P.renderStatus({ type: ActivityType.Streaming, text: 'Live', url: 'https://twitch.tv/x' }), { name: 'Live', type: ActivityType.Streaming, url: 'https://twitch.tv/x' });
  assert.equal(P.validActivity({ type: ActivityType.Streaming, text: 'Live', url: 'https://evil.example/x' }), null);
});

test('portée owner : toJSON filtre, /bot jamais dans le lot global, contrôle au chargement', () => {
  const handler = new CommandHandler();
  handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));
  assert.deepEqual(handler.failures, []);
  const global = handler.toJSON({ scope: 'global' });
  const owner = handler.toJSON({ scope: 'owner' });
  const all = handler.toJSON({ scope: 'all' });
  assert.ok(!global.some((c) => c.name === 'bot'), '/bot absent du lot global');
  assert.deepEqual(owner.map((c) => c.name), ['bot']);
  assert.equal(all.length, global.length + owner.length);
  assert.deepEqual(handler.toJSON().map((c) => c.name), global.map((c) => c.name), 'par défaut : portée globale seulement');
  assert.throws(() => handler.toJSON({ scope: 'partout' }), /inconnue/);
  assert.equal(scopeOf(handler.commands.get('bot')), 'owner');
  assert.equal(scopeOf(handler.commands.get('ping')), 'global');
  const data = (perm = PermissionFlagsBits.Administrator) => new SlashCommandBuilder().setName('x').setDescription('x').setDefaultMemberPermissions(perm);
  assert.equal(scopeIssue({ scope: 'owner', ownerOnly: true, data: data() }), null);
  assert.match(scopeIssue({ scope: 'owner', data: data() }), /ownerOnly/);
  assert.match(scopeIssue({ scope: 'owner', ownerOnly: true, data: new SlashCommandBuilder().setName('x').setDescription('x') }), /permission/);
  assert.match(scopeIssue({ scope: 'serveur', data: data() }), /inconnue/);
  assert.equal(bot.ownerOnly, true);
  assert.equal(bot.data.toJSON().default_member_permissions, String(PermissionFlagsBits.Administrator));
});

/** Interaction d'autocomplétion / de bouton simulée. */
function interactionAs(userId, { guildId = OWNER_GUILD, admin = true, focused = '' } = {}) {
  const responses = [];
  return {
    responses,
    user: { id: userId },
    guildId,
    inGuild: () => true,
    memberPermissions: new PermissionsBitField(admin ? ['Administrator'] : []),
    options: { getFocused: () => focused },
    respond: async (choices) => responses.push(choices),
  };
}

test('autocomplétion de /bot quitter : revérifiée ELLE-MÊME (non-propriétaire ou autre serveur → liste vide)', async () => {
  const { client } = fakeClient();
  const admin = interactionAs(ADMIN);
  await bot.autocomplete(admin, client);
  assert.deepEqual(admin.responses, [[]], 'non-propriétaire : aucune liste de serveurs');
  const elsewhere = interactionAs(OWNER, { guildId: OTHER_GUILD });
  await bot.autocomplete(elsewhere, client);
  assert.deepEqual(elsewhere.responses, [[]], 'hors du serveur propriétaire : rien');
  const owner = interactionAs(OWNER, { focused: 'client' });
  await bot.autocomplete(owner, client);
  assert.deepEqual(owner.responses[0].map((c) => c.value), [OTHER_GUILD], 'serveur propriétaire jamais proposé');
  assert.ok(owner.responses[0][0].name.length <= 100);
});

test('assertOwner : propriétaire, provenance OWNER_GUILD_ID, Administrateur', () => {
  const { client } = fakeClient();
  assert.doesNotThrow(() => bot.assertOwner(interactionAs(OWNER), client));
  assert.throws(() => bot.assertOwner(interactionAs(ADMIN), client), /propriétaires du bot/);
  assert.throws(() => bot.assertOwner(interactionAs(OWNER, { guildId: OTHER_GUILD }), client), /OWNER_GUILD_ID/);
  assert.throws(() => bot.assertOwner(interactionAs(OWNER, { admin: false }), client), /Administrateur/);
  client.config.ownerGuildId = '';
  assert.doesNotThrow(() => bot.assertOwner(interactionAs(OWNER, { guildId: OTHER_GUILD }), client), 'sans OWNER_GUILD_ID : pas de contrôle de provenance');
});

test('/help : commandes de portée owner masquées aux non-propriétaires', () => {
  const commands = new Collection([
    ['bot', { data: { name: 'bot' }, scope: 'owner', category: 'configuration' }],
    ['ping', { data: { name: 'ping' }, category: 'utility' }],
  ]);
  const client = { config: { ownerIds: [OWNER] }, commands };
  assert.deepEqual([...help.visibleCommands(client, ADMIN).keys()], ['ping']);
  assert.deepEqual([...help.visibleCommands(client, OWNER).keys()], ['bot', 'ping']);
  assert.equal(help.findCommand(help.visibleCommands(client, ADMIN), 'bot'), null);
});

test('liste des serveurs : pages de 10, bornées, serveur propriétaire signalé', () => {
  const guilds = new Collection(Array.from({ length: 23 }, (_, i) => {
    const id = `4000000000000000${String(i).padStart(2, '0')}`;
    return [id, { id, name: `Serveur *${i}*`, memberCount: 100 - i }];
  }));
  const client = { config: { ownerGuildId: '400000000000000000' }, guilds: { cache: guilds } };
  const first = bot.serversView(client, 1).embeds[0].toJSON();
  assert.match(first.footer.text, /Page 1\/3/);
  assert.match(first.description, /👑/);
  assert.match(first.description, /Serveur \\\*0\\\*/, 'Markdown des noms échappé');
  assert.match(bot.serversView(client, 99).embeds[0].toJSON().footer.text, /Page 3\/3/);
  assert.match(bot.serversView(client, 'abc').embeds[0].toJSON().footer.text, /Page 1\/3/);
});
