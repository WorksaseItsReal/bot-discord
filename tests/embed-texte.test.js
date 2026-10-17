'use strict';

/**
 * /embed texte (+say) : mentions autorisées explicites, lien de réponse limité au serveur,
 * pré-contrôle de la sécurité avant une mention de masse, ordre réponse → log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, ChannelType, Collection } = require('discord.js');
const embed = require('../src/commands/utility/embed');
const { CooldownManager } = require('../src/core/cooldowns');

const G = '100000000000000001';
const CH = '100000000000000002';
const USER = '100000000000000003';
const BOT = '100000000000000004';
const ROLE_OPEN = '100000000000000005';
const ROLE_CLOSED = '100000000000000006';
const ROLE_MANAGED = '100000000000000007';

const roles = new Collection([
  [ROLE_OPEN, { id: ROLE_OPEN, mentionable: true, managed: false }],
  [ROLE_CLOSED, { id: ROLE_CLOSED, mentionable: false, managed: false }],
  [ROLE_MANAGED, { id: ROLE_MANAGED, mentionable: true, managed: true }],
]);
const guild = { id: G, roles: { cache: roles } };
const perms = (...flags) => new PermissionsBitField(flags);

test('computeAllowedMentions : 10 membres au plus, rôles sur demande, @everyone seulement avec notifier_tous ET la permission', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `2000000000000000${String(i).padStart(2, '0')}`);
  const content = [...ids, ids[0]].map((id) => `<@${id}>`).join(' ') + ` <@!${ids[1]}> <@&${ROLE_OPEN}> <@&${ROLE_CLOSED}> <@&${ROLE_MANAGED}> <@&${G}> @everyone`;
  const none = embed.computeAllowedMentions({ content, guild, authorPerms: perms() });
  assert.deepEqual(none.users, ids.slice(0, 10), '10 premiers distincts');
  assert.deepEqual(none.roles, [], 'rôles non demandés');
  assert.deepEqual(none.parse, [], 'jamais @everyone par défaut');
  assert.equal(none.repliedUser, false);
  // Rôles demandés : mentionnable seulement, sauf « Mentionner @everyone » de l'auteur ; jamais géré ni @everyone.
  assert.deepEqual(embed.computeAllowedMentions({ content, guild, mentionRoles: true, authorPerms: perms() }).roles, [ROLE_OPEN]);
  assert.deepEqual(embed.computeAllowedMentions({ content, guild, mentionRoles: true, authorPerms: perms('MentionEveryone') }).roles, [ROLE_OPEN, ROLE_CLOSED]);
  // @everyone : notifier_tous ET permission native dans la cible.
  assert.deepEqual(embed.computeAllowedMentions({ content, guild, notifyAll: true, authorPerms: perms() }).parse, []);
  assert.deepEqual(embed.computeAllowedMentions({ content, guild, notifyAll: false, authorPerms: perms('MentionEveryone') }).parse, []);
  assert.deepEqual(embed.computeAllowedMentions({ content, guild, notifyAll: true, authorPerms: perms('MentionEveryone') }).parse, ['everyone']);
  assert.deepEqual(embed.computeAllowedMentions({ content: 'texte' }), { parse: [], users: [], roles: [], repliedUser: false });
});

test('parseMessageLink et nom de fichier sûr', () => {
  assert.deepEqual(embed.parseMessageLink(`https://discord.com/channels/${G}/${CH}/${USER}`), { guildId: G, channelId: CH, messageId: USER });
  assert.deepEqual(embed.parseMessageLink(`<https://ptb.discordapp.com/channels/${G}/${CH}/${USER}>`), { guildId: G, channelId: CH, messageId: USER });
  for (const bad of ['https://evil.example/channels/1/2/3', `https://discord.com/channels/@me/${CH}/${USER}`, 'bonjour', '']) assert.equal(embed.parseMessageLink(bad), null, bad);
  assert.equal(embed.safeFileName('../../etc/passwd'), 'etc_passwd');
  assert.equal(embed.safeFileName('rapport final (v2).pdf'), 'rapport_final_v2_.pdf');
  assert.equal(embed.safeFileName('...'), 'fichier');
  assert.equal(embed.safeFileName(null), 'fichier');
});

/** Contexte simulé : serveur, salon, auteur, bot, services enregistrés dans `calls`. */
function context({ options = {}, authorPerms = ['Administrator'], botPerms = ['Administrator'], secur = null, automod = { enabled: false } } = {}) {
  const calls = [];
  const channel = {
    id: CH,
    guildId: G,
    type: ChannelType.GuildText,
    parentId: null,
    toString: () => `<#${CH}>`,
    permissionsFor: (m) => perms(...(m.id === BOT ? botPerms : authorPerms)),
    send: async (payload) => {
      calls.push(['send', payload]);
      return { url: `https://discord.com/channels/${G}/${CH}/1` };
    },
  };
  const g = {
    id: G,
    roles: { cache: roles },
    channels: { cache: new Collection([[CH, channel]]), fetch: async () => null },
    members: { me: { id: BOT }, fetch: async () => null },
  };
  const interaction = {
    guildId: G,
    guild: g,
    channelId: CH,
    user: { id: USER, toString: () => `<@${USER}>` },
    member: { id: USER, permissions: perms(...authorPerms), roles: { cache: new Collection() } },
    options: {
      getSubcommand: () => 'texte',
      getString: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getAttachment: (n) => options[n] ?? null,
      getChannel: (n) => options[n] ?? null,
    },
    deferReply: async () => calls.push(['defer']),
    editReply: async (p) => calls.push(['reply', p]),
  };
  const client = {
    cooldowns: new CooldownManager(),
    services: {
      config: { get: () => ({ automod }) },
      automod: { inspect: () => null },
      secur,
      logging: { send: async (...args) => calls.push(['log', args]), hidesContent: () => false },
      moderation: { reportDestructiveAction: async (...args) => calls.push(['report', args]) },
    },
  };
  return { calls, interaction, client };
}

test('lien de réponse vers un AUTRE serveur : refusé avant tout appel', async () => {
  embed.sayWindows.clear();
  const { calls, interaction, client } = context({ options: { message: 'Bonjour', repondre_a: `https://discord.com/channels/999999999999999999/${CH}/${USER}` } });
  await assert.rejects(embed.execute(interaction, client), /CE serveur/);
  assert.deepEqual(calls, [], 'aucun acquittement, aucun envoi');
  const other = context({ options: { message: 'Bonjour', repondre_a: 'pas un lien' } });
  await assert.rejects(embed.execute(other.interaction, other.client), /lien d'un message/);
  const empty = context({ options: { message: '   ' } });
  await assert.rejects(embed.execute(empty.interaction, empty.client), /vide/);
  const phishing = context({ options: { message: 'Nitro offert : https://discord-gift.ru/nitro' } });
  await assert.rejects(embed.execute(phishing.interaction, phishing.client), /arnaque/);
});

test('notifier_tous : secur.assertAllowed AVANT l\'envoi, rapport après ; réponse avant le log', async () => {
  embed.sayWindows.clear();
  const order = [];
  const secur = { assertAllowed: async (i, type) => order.push(['assertAllowed', type, i.user.id]) };
  const { calls, interaction, client } = context({ options: { message: '@everyone réunion à 21 h', notifier_tous: true }, secur });
  const realSend = interaction.guild.channels.cache.get(CH).send;
  interaction.guild.channels.cache.get(CH).send = async (p) => {
    order.push(['send']);
    return realSend(p);
  };
  await embed.execute(interaction, client);
  assert.deepEqual(order.map((o) => o[0]), ['assertAllowed', 'send']);
  assert.equal(order[0][1], 'everyone');
  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['defer', 'send', 'reply', 'report', 'log'], 'réponse AVANT le rapport et le log');
  const sent = calls.find((c) => c[0] === 'send')[1];
  assert.deepEqual(sent.allowedMentions, { parse: ['everyone'], users: [], roles: [], repliedUser: false });
  assert.equal(calls.find((c) => c[0] === 'report')[1][2], 'everyone');
  const log = calls.find((c) => c[0] === 'log')[1];
  assert.equal(log[1], 'moderation');
  assert.equal(log[4].event, 'say');

  // Refus de la sécurité : rien n'est envoyé.
  embed.sayWindows.clear();
  const blocked = context({ options: { message: '@everyone', notifier_tous: true }, secur: { assertAllowed: async () => { throw Object.assign(new Error('Action bloquée par la sécurité'), { isUserError: true }); } } });
  await assert.rejects(embed.execute(blocked.interaction, blocked.client), /bloquée/);
  assert.ok(!blocked.calls.some((c) => c[0] === 'send'));

  // Sans la permission native : refus clair, aucun envoi, aucune consultation de la sécurité.
  embed.sayWindows.clear();
  let asked = 0;
  const noPerm = context({ options: { message: '@everyone', notifier_tous: true }, authorPerms: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'], secur: { assertAllowed: async () => { asked += 1; } } });
  await assert.rejects(embed.execute(noPerm.interaction, noPerm.client), /Mentionner @everyone/);
  assert.equal(asked, 0);
  assert.ok(!noPerm.calls.some((c) => c[0] === 'send'));
});

test('permissions NATIVES de l\'auteur et du bot dans la cible ; délai par membre et plafond par serveur', async () => {
  embed.sayWindows.clear();
  const author = context({ options: { message: 'Bonjour' }, authorPerms: ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'] });
  await assert.rejects(embed.execute(author.interaction, author.client), /y écrire/);
  const bot = context({ options: { message: 'Bonjour' }, botPerms: ['ViewChannel', 'ReadMessageHistory'] });
  await assert.rejects(embed.execute(bot.interaction, bot.client), /Il me manque/);
  // 5 s entre deux envois d'un même membre.
  embed.sayWindows.clear();
  const ok = context({ options: { message: 'Bonjour' } });
  await embed.execute(ok.interaction, ok.client);
  await assert.rejects(embed.execute(ok.interaction, ok.client), /Doucement/);
  // 10 envois par minute et par serveur.
  embed.sayWindows.clear();
  for (let i = 0; i < 10; i += 1) {
    const c = context({ options: { message: `Message ${i}` } });
    await embed.execute(c.interaction, c.client);
  }
  const eleventh = context({ options: { message: 'Encore' } });
  await assert.rejects(embed.execute(eleventh.interaction, eleventh.client), /dans la dernière minute/);
  embed.sayWindows.clear();
});

test('AutoMod : un texte bloqué pour l\'auteur est refusé, même avec « Gérer les messages »', async () => {
  embed.sayWindows.clear();
  const seen = [];
  const c = context({ options: { message: 'texte interdit' }, automod: { enabled: true, filters: { badWords: { enabled: true, words: ['interdit'] }, antiCaps: { enabled: true } } } });
  c.client.services.automod.inspect = (message, filters, opts) => {
    seen.push({ message, filters, opts });
    return { filter: 'badWords', reason: 'Mot interdit', detail: '« interdit »' };
  };
  await assert.rejects(embed.execute(c.interaction, c.client), /AutoMod le bloquerait \(Mot interdit/);
  assert.equal(seen[0].message.content, 'texte interdit');
  assert.equal(seen[0].message.author.id, USER);
  assert.equal(seen[0].opts.temporal, false);
  assert.ok(!('antiCaps' in seen[0].filters), 'filtres de style non appliqués');
  assert.ok(!c.calls.some((x) => x[0] === 'send'));
  // Salon ignoré par l'AutoMod : rien n'est bloqué.
  embed.sayWindows.clear();
  const ignored = context({ options: { message: 'texte interdit' }, automod: { enabled: true, ignoredChannels: [CH], filters: {} } });
  ignored.client.services.automod.inspect = () => assert.fail('salon ignoré : pas d\'analyse');
  await embed.execute(ignored.interaction, ignored.client);
  embed.sayWindows.clear();
});
