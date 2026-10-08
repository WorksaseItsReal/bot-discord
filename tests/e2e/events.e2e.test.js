'use strict';

/**
 * Bout en bout : événements de passerelle passés par les handlers RÉELS de
 * discord.js (GUILD_MEMBER_ADD, MESSAGE_CREATE, VOICE_STATE_UPDATE,
 * GUILD_AUDIT_LOG_ENTRY_CREATE…), serveur entièrement configuré.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { nextId } = require('./lib/ids');

/** Messages publiés par le bot dans un salon depuis `mark` (position dans messageLog). */
function botMessagesIn(h, channelId, mark) {
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);
}
const titles = (msgs) => msgs.flatMap((m) => (m.embeds ?? []).map((e) => e.title ?? ''));
const deleted = (h, msg) => !h.fake.messages.has(msg.id);

test('arrivées, AntiRaid et départs', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    let mark = h.fake.messageLog.length;
    const newcomer = h.addUser('Nouveau', { ageDays: 400 });
    await h.memberJoin(newcomer);
    assert.ok(h.fake.members.get(newcomer.id).roles.includes(IDS.roles.member), 'rôle automatique non donné');
    assert.ok(botMessagesIn(h, IDS.channels.general, mark).length >= 1, 'pas de message de bienvenue');
    assert.ok(botMessagesIn(h, IDS.channels.logs, mark).length >= 1, 'arrivée non journalisée');
    assert.ok([...h.fake.dms.values()].some((d) => d.recipients[0].id === newcomer.id), 'bienvenue en MP non envoyée');

    const young = h.addUser('Recent', { ageDays: 1 });
    await h.memberJoin(young);
    assert.ok(!h.fake.members.has(young.id), 'compte trop récent non expulsé');

    const bot = h.addUser('BotX', { ageDays: 400, bot: true });
    await h.memberJoin(bot);
    assert.ok(!h.fake.members.has(bot.id), 'bot non autorisé non expulsé (antiBot)');

    const raiders = [];
    for (let i = 0; i < 5; i += 1) {
      const u = h.addUser(`Raid${i}`, { ageDays: 300 });
      raiders.push(u);
      await h.memberJoin(u);
    }
    assert.ok(raiders.some((u) => !h.fake.members.has(u.id)), 'raid non sanctionné');

    mark = h.fake.messageLog.length;
    await h.memberLeave(newcomer.id);
    assert.ok(botMessagesIn(h, IDS.channels.general, mark).length >= 1, 'pas de message de départ');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('AutoMod : arnaque, invitation, mentions de masse, majuscules, mot interdit, spam', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const scam = await h.userMessage({ as: 'member', content: 'Free nitro here https://discord-gift.ru/claim steam gift' });
    assert.ok(deleted(h, scam), 'arnaque non supprimée');
    assert.ok(h.fake.members.get(IDS.users.member).communication_disabled_until, 'auteur de l\'arnaque non exclu temporairement');

    const invite = await h.userMessage({ as: 'target', content: 'Rejoignez discord.gg/abcdef' });
    assert.ok(deleted(h, invite), 'invitation non supprimée');

    const mentions = [IDS.users.admin, IDS.users.mod, IDS.users.owner, IDS.users.member, IDS.users.bot, IDS.users.otherBot].map((id) => `<@${id}>`).join(' ');
    const mass = await h.userMessage({ as: 'target', content: mentions });
    assert.ok(deleted(h, mass), 'mentions de masse non supprimées');

    const caps = await h.userMessage({ as: 'admin', channel: 'rules', content: 'BONJOUR' });
    assert.ok(!deleted(h, caps), 'un message court en majuscules d\'un admin ne doit pas être supprimé');

    const word = await h.userMessage({ as: 'target', channel: 'announcements', content: 'ceci est interdit ici' });
    assert.ok(deleted(h, word), 'mot interdit non supprimé');

    const spam = [];
    const spammer = h.addUser('Spammeur', { ageDays: 400 });
    await h.memberJoin(spammer);
    for (let i = 0; i < 7; i += 1) spam.push(await h.userMessage({ as: spammer.id, channel: 'rules', content: `spam numéro ${i} !` }));
    assert.ok(spam.some((m) => deleted(h, m)), 'spam non traité');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('logs de messages : édition, suppression, purge, messages hors cache', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const mark = h.fake.messageLog.length;
    const msg = await h.userMessage({ as: 'admin', content: 'Message original' });
    await h.editUserMessage(msg.id, 'Message modifié');
    await h.deleteUserMessage(msg.id);
    const G = h.guild.id;
    const ch = IDS.channels.general;
    h.fake.dispatchNow('MESSAGE_DELETE', { id: nextId(), channel_id: ch, guild_id: G }, 'suppression hors cache');
    h.fake.dispatchNow('MESSAGE_UPDATE', { id: nextId(), channel_id: ch, guild_id: G, content: 'nouveau', author: h.fake.users.get(IDS.users.member), edited_timestamp: new Date().toISOString(), member: { ...h.fake.members.get(IDS.users.member), user: undefined } }, 'édition hors cache');
    h.fake.dispatchNow('MESSAGE_UPDATE', { id: nextId(), channel_id: ch, guild_id: G, embeds: [{ type: 'link', url: 'https://example.com' }] }, 'édition partielle sans auteur');
    h.fake.dispatchNow('MESSAGE_DELETE_BULK', { ids: [nextId(), nextId()], channel_id: ch, guild_id: G }, 'purge hors cache');
    await h.settle();
    const logs = botMessagesIn(h, IDS.channels.logs, mark);
    assert.ok(logs.length >= 3, `logs attendus (édition, suppression, purge) : ${titles(logs).join(' | ')}`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('vocaux temporaires : création depuis le hub, panneau, suppression une fois vide', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    // La catégorie impose un refus (rôle Muet) : le salon créé doit en hériter.
    const cat = h.fake.channels.get(IDS.channels.catVoice);
    cat.permission_overwrites = [{ id: IDS.roles.muted, type: 0, allow: '0', deny: String(1n << 21n) }];
    h.fake.dispatchNow('CHANNEL_UPDATE', cat);
    await h.voice('member', 'hub');
    const tempId = h.fake.voiceStates.get(IDS.users.member)?.channel_id;
    assert.ok(tempId && tempId !== IDS.channels.hub, 'membre non déplacé dans un vocal temporaire');
    const temp = h.fake.channels.get(tempId);
    assert.equal(temp.parent_id, IDS.channels.catVoice);
    assert.ok(temp.permission_overwrites.some((o) => o.id === IDS.roles.muted), 'surcharges de la catégorie perdues');
    assert.ok(temp.permission_overwrites.some((o) => o.id === IDS.users.member && o.type === 1), 'droits du propriétaire absents');
    const panel = [...h.fake.messages.values()].find((m) => m.channel_id === tempId && m.components?.length);
    assert.ok(panel, 'panneau de contrôle absent');

    // Verrouiller / masquer puis rétablir : surcharges identiques à l'origine.
    const snap = () => JSON.stringify([...h.fake.channels.get(tempId).permission_overwrites].sort((a, b) => (a.id > b.id ? 1 : -1)));
    const original = snap();
    for (const [on, off] of [['cmd:tempvoice:lock:on', 'cmd:tempvoice:lock:off'], ['cmd:tempvoice:hide:on', 'cmd:tempvoice:hide:off']]) {
      await h.click(h.message(panel.id), on, { as: 'member' });
      assert.notEqual(snap(), original, `${on} sans effet`);
      await h.click(h.message(panel.id), off, { as: 'member' });
      await h.settle();
      assert.equal(snap(), original, `${off} ne restaure pas les surcharges`);
    }

    await h.voice('target', tempId);
    await h.voice('member', null);
    assert.ok(h.fake.channels.has(tempId), 'salon supprimé alors qu\'il reste un membre');
    await h.voice('target', null);
    assert.ok(!h.fake.channels.has(tempId), 'salon vide non supprimé');
    await h.voice('admin', 'voice');
    await h.voice('admin', null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('journal d\'audit : suppressions massives par un humain, rôles, kick, timeout, bans', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { channelDeleteThreshold: 3, punishExecutor: 'strip' } });
  try {
    for (const key of ['rules', 'announcements', 'staff']) {
      const id = IDS.channels[key];
      const ch = h.fake.channels.get(id);
      h.fake.channels.delete(id);
      h.fake.dispatchNow('CHANNEL_DELETE', ch, `suppression de #${ch.name}`);
      await h.auditEntry({ action_type: 12, target_id: id, user_id: IDS.users.mod });
    }
    assert.ok(!h.fake.members.get(IDS.users.mod).roles.includes(IDS.roles.mod), 'auteur des suppressions massives non sanctionné');
    await h.auditEntry({ action_type: 25, target_id: IDS.users.member, user_id: IDS.users.admin, changes: [{ key: '$add', new_value: [{ id: IDS.roles.notif, name: 'Notifications' }] }] });
    await h.auditEntry({ action_type: 24, target_id: IDS.users.member, user_id: IDS.users.admin, changes: [{ key: 'communication_disabled_until', new_value: new Date(Date.now() + 600_000).toISOString() }, { key: 'nick', old_value: 'a', new_value: 'b' }] });
    await h.auditEntry({ action_type: 20, target_id: IDS.users.otherBot, user_id: IDS.users.admin, reason: 'test' });
    const banned = h.addUser('BanniManuel', { ageDays: 50 });
    h.fake.dispatchNow('GUILD_BAN_ADD', { guild_id: h.guild.id, user: banned }, 'ban manuel');
    await h.auditEntry({ action_type: 22, target_id: banned.id, user_id: IDS.users.admin, reason: 'spam' });
    h.fake.dispatchNow('GUILD_BAN_REMOVE', { guild_id: h.guild.id, user: banned }, 'unban manuel');
    await h.auditEntry({ action_type: 23, target_id: banned.id, user_id: IDS.users.admin });
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('événements de structure : salons, rôles, fils, emojis, serveur, membres hors cache', async () => {
  const h = await createHarness();
  h.configureAll();
  const G = h.guild.id;
  try {
    const ghost = h.addUser('Fantome', { ageDays: 50 });
    const steps = [
      ['GUILD_MEMBER_REMOVE', { guild_id: G, user: ghost }],
      ['GUILD_MEMBER_UPDATE', { guild_id: G, user: ghost, roles: [IDS.roles.member], nick: 'X', joined_at: new Date().toISOString(), communication_disabled_until: null, flags: 0, avatar: null }],
      ['GUILD_MEMBER_UPDATE', { guild_id: G, ...h.fake.members.get(IDS.users.member), nick: 'Nouveau', roles: [IDS.roles.member, IDS.roles.notif] }],
      ['VOICE_STATE_UPDATE', { guild_id: G, channel_id: IDS.channels.voice, user_id: ghost.id, member: { user: ghost, roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 }, session_id: 'x', deaf: false, mute: false, self_deaf: false, self_mute: false, self_video: false, suppress: false, request_to_speak_timestamp: null }],
      ['VOICE_STATE_UPDATE', { guild_id: G, channel_id: IDS.channels.hub, user_id: nextId(), session_id: 'y', deaf: false, mute: false, self_deaf: false, self_mute: false, self_video: false, suppress: false, request_to_speak_timestamp: null }],
      ['CHANNEL_CREATE', { id: nextId(), type: 0, guild_id: G, name: 'nouveau', position: 9, permission_overwrites: [], parent_id: null }],
      ['CHANNEL_UPDATE', { ...h.fake.channels.get(IDS.channels.rules), name: 'reglement', topic: 'nouveau sujet', rate_limit_per_user: 10, permission_overwrites: [{ id: G, type: 0, allow: '0', deny: '2048' }] }],
      ['GUILD_ROLE_CREATE', { guild_id: G, role: { id: IDS.guild.slice(0, -2) + '99', name: 'Nouveau rôle', color: 0, hoist: false, position: 1, permissions: '0', managed: false, mentionable: false, flags: 0 } }],
      ['GUILD_ROLE_UPDATE', { guild_id: G, role: { ...h.fake.roles.get(IDS.roles.gamer), name: 'Gamer', permissions: '8' } }],
      ['GUILD_ROLE_DELETE', { guild_id: G, role_id: IDS.roles.temp }],
      ['GUILD_UPDATE', { ...h.fake.guild, roles: [...h.fake.roles.values()], name: 'Serveur renommé', verification_level: 3 }],
      ['THREAD_CREATE', { id: IDS.guild.slice(0, -2) + '98', type: 11, guild_id: G, parent_id: IDS.channels.general, name: 'fil', owner_id: IDS.users.member, thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false }, newly_created: true, member_count: 1, message_count: 0 }],
      ['THREAD_DELETE', { id: IDS.guild.slice(0, -2) + '98', guild_id: G, parent_id: IDS.channels.general, type: 11 }],
      ['GUILD_EMOJIS_UPDATE', { guild_id: G, emojis: [{ id: nextId(), name: 'nouveau', roles: [], require_colons: true, managed: false, animated: false, available: true }] }],
    ];
    for (const [t, d] of steps) {
      h.fake.dispatchNow(t, d, t);
      await h.settle();
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('ModMail : un MP au bot ouvre une conversation', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Bonjour, j\'ai un souci' });
    const channel = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    assert.ok(channel, 'salon ModMail non créé');
    assert.equal(channel.parent_id, IDS.channels.catTickets);
    const opening = botMessagesIn(h, channel.id, 0);
    assert.ok(opening.some((m) => m.components?.length), 'carte d\'ouverture sans boutons');
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Encore une précision' });
    assert.equal([...h.fake.channels.values()].filter((c) => c.name?.startsWith('modmail-')).length, 1, 'second salon ModMail créé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('ajout et retrait du bot d\'un serveur', async () => {
  const h = await createHarness();
  try {
    const { buildGuild } = require('./lib/fixtures');
    const raw = buildGuild().guild;
    raw.id = nextId();
    for (const r of raw.roles) if (r.name === '@everyone') r.id = raw.id;
    raw.channels = raw.channels.map((c) => ({ ...c, id: nextId(), parent_id: null, guild_id: raw.id }));
    raw.name = 'Second serveur';
    h.fake.dispatchNow('GUILD_CREATE', raw, 'guildCreate');
    await h.settle();
    assert.ok(h.client.guilds.cache.has(raw.id));
    h.fake.dispatchNow('GUILD_DELETE', { id: raw.id, unavailable: false }, 'guildDelete');
    await h.settle();
    assert.ok(!h.client.guilds.cache.has(raw.id));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
