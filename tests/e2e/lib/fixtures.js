'use strict';

const { PermissionFlagsBits: P } = require('discord.js');
const { snowflakeAt, DAY } = require('./ids');

/**
 * Serveur de test réaliste, au format brut de l'API (GUILD_CREATE).
 * Identifiants fixes (déterministes) : OWNER_IDS peut être défini avant le
 * chargement de la configuration du bot.
 */
const T0 = Date.parse('2020-03-01T12:00:00Z');
const id = (n, ts = T0) => snowflakeAt(ts, n);

const IDS = {
  guild: id(1, Date.parse('2019-06-01T00:00:00Z')),
  users: {
    owner: id(10, Date.parse('2016-05-01T00:00:00Z')),
    admin: id(11, Date.parse('2017-02-01T00:00:00Z')),
    mod: id(12, Date.parse('2018-02-01T00:00:00Z')),
    member: id(13, Date.parse('2019-02-01T00:00:00Z')),
    target: id(14, Date.parse('2020-02-01T00:00:00Z')),
    bot: id(15, Date.parse('2021-01-01T00:00:00Z')),
    botOwner: id(16, Date.parse('2015-12-01T00:00:00Z')),
    otherBot: id(17, Date.parse('2021-06-01T00:00:00Z')),
  },
  roles: {
    member: id(20),
    notif: id(21),
    gamer: id(22),
    mod: id(23),
    admin: id(24),
    bot: id(25),
    muted: id(26),
    temp: id(27),
  },
  channels: {
    catGeneral: id(30),
    general: id(31),
    rules: id(32),
    announcements: id(33),
    logs: id(34),
    modLog: id(35),
    catVoice: id(36),
    voice: id(37),
    hub: id(38),
    catTickets: id(39),
    forum: id(40),
    stage: id(41),
    staff: id(42),
    thread: id(43),
  },
  emoji: id(50),
  application: id(15, Date.parse('2021-01-01T00:00:00Z')),
};
IDS.roles.everyone = IDS.guild;

const perms = (...flags) => flags.reduce((a, f) => a | f, 0n).toString();

const EVERYONE_PERMS = perms(
  P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AddReactions, P.Connect, P.Speak, P.UseApplicationCommands,
  P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.CreateInstantInvite, P.ChangeNickname, P.SendMessagesInThreads,
  P.CreatePublicThreads, P.Stream, P.UseVAD, P.SendVoiceMessages, P.SendPolls,
);
const MOD_PERMS = perms(
  P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ManageNicknames, P.MuteMembers, P.MoveMembers,
  P.DeafenMembers, P.ViewAuditLog, P.ManageThreads,
);

function rawUser(key, name, extra = {}) {
  return {
    id: IDS.users[key],
    username: name.toLowerCase().replace(/[^a-z0-9_.]/g, ''),
    global_name: name,
    discriminator: '0',
    avatar: null,
    bot: false,
    system: false,
    banner: null,
    accent_color: null,
    public_flags: 0,
    avatar_decoration_data: null,
    ...extra,
  };
}

function rawRole(key, name, position, permissions, extra = {}) {
  return {
    id: IDS.roles[key],
    name,
    color: 0,
    colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
    hoist: false,
    icon: null,
    unicode_emoji: null,
    position,
    permissions,
    managed: false,
    mentionable: false,
    flags: 0,
    ...extra,
  };
}

function rawChannel(key, type, name, position, extra = {}) {
  const base = {
    id: IDS.channels[key],
    type,
    guild_id: IDS.guild,
    name,
    position,
    permission_overwrites: [],
    parent_id: null,
    flags: 0,
  };
  if (type === 0 || type === 5) Object.assign(base, { topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0, default_auto_archive_duration: 1440 });
  if (type === 2 || type === 13) Object.assign(base, { bitrate: 64000, user_limit: 0, rtc_region: null, video_quality_mode: 1, nsfw: false, rate_limit_per_user: 0, last_message_id: null });
  if (type === 15) Object.assign(base, { topic: null, nsfw: false, rate_limit_per_user: 0, available_tags: [], default_reaction_emoji: null, default_thread_rate_limit_per_user: 0, default_sort_order: null, default_forum_layout: 0, template: '' });
  return { ...base, ...extra };
}

function rawMember(user, roles, joinedDaysAgo, extra = {}) {
  return {
    user,
    nick: null,
    avatar: null,
    banner: null,
    roles,
    joined_at: new Date(Date.now() - joinedDaysAgo * DAY).toISOString(),
    premium_since: null,
    deaf: false,
    mute: false,
    flags: 0,
    pending: false,
    communication_disabled_until: null,
    ...extra,
  };
}

/** Construit l'état initial du serveur (utilisateurs, rôles, salons, membres). */
function buildGuild({ botAdministrator = true, big = false, restrictBot = false } = {}) {
  const users = {
    owner: rawUser('owner', 'Propriétaire'),
    admin: rawUser('admin', 'Admin'),
    mod: rawUser('mod', 'Modo'),
    member: rawUser('member', 'Membre'),
    target: rawUser('target', 'Cible'),
    bot: rawUser('bot', 'Inspecteur Gadget', { bot: true, username: 'inspecteur-gadget' }),
    botOwner: rawUser('botOwner', 'Dev'),
    otherBot: rawUser('otherBot', 'AutreBot', { bot: true, username: 'autrebot' }),
  };

  const botPerms = botAdministrator
    ? perms(P.Administrator)
    : perms(
      P.ManageGuild, P.ManageRoles, P.ManageChannels, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages,
      P.ViewAuditLog, P.ManageNicknames, P.MoveMembers, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory,
      P.ViewChannel, P.ManageWebhooks, P.AddReactions, P.UseExternalEmojis, P.Connect, P.Speak, P.MuteMembers, P.ManageThreads,
    );

  const roles = [
    rawRole('everyone', '@everyone', 0, EVERYONE_PERMS),
    rawRole('temp', 'Temporaire', 1, '0'),
    rawRole('member', 'Membre', 1, '0', { color: 0x95a5a6 }),
    rawRole('notif', 'Notifications', 2, '0', { mentionable: true }),
    rawRole('gamer', 'Joueur', 3, '0', { color: 0x3498db }),
    rawRole('muted', 'Muet', 4, '0'),
    rawRole('mod', 'Modérateur', 5, MOD_PERMS, { color: 0x2ecc71, hoist: true }),
    rawRole('admin', 'Admin', 6, perms(P.Administrator), { color: 0xe74c3c, hoist: true }),
    rawRole('bot', 'Inspecteur Gadget', 7, botPerms, { managed: true, tags: { bot_id: IDS.users.bot } }),
  ];

  const staffOnly = [
    { id: IDS.roles.everyone, type: 0, allow: '0', deny: perms(P.ViewChannel) },
    { id: IDS.roles.mod, type: 0, allow: perms(P.ViewChannel), deny: '0' },
  ];
  const channels = [
    rawChannel('catGeneral', 4, 'Général', 0),
    rawChannel('general', 0, 'général', 0, { parent_id: IDS.channels.catGeneral, topic: 'Discussion générale' }),
    rawChannel('rules', 0, 'règles', 1, { parent_id: IDS.channels.catGeneral }),
    rawChannel('announcements', 5, 'annonces', 2, { parent_id: IDS.channels.catGeneral }),
    rawChannel('logs', 0, 'logs', 3, { parent_id: IDS.channels.catGeneral, permission_overwrites: staffOnly }),
    rawChannel('modLog', 0, 'mod-log', 4, { parent_id: IDS.channels.catGeneral, permission_overwrites: staffOnly }),
    rawChannel('staff', 0, 'staff', 5, { parent_id: IDS.channels.catGeneral, permission_overwrites: staffOnly }),
    rawChannel('forum', 15, 'idées', 6, { parent_id: IDS.channels.catGeneral }),
    rawChannel('catVoice', 4, 'Vocaux', 1),
    rawChannel('voice', 2, 'Salon vocal', 0, { parent_id: IDS.channels.catVoice }),
    rawChannel('hub', 2, '➕ Créer un vocal', 1, { parent_id: IDS.channels.catVoice }),
    rawChannel('stage', 13, 'Conférence', 2, { parent_id: IDS.channels.catVoice }),
    rawChannel('catTickets', 4, 'Tickets', 2),
  ];

  const members = [
    rawMember(users.owner, [], 1500),
    rawMember(users.admin, [IDS.roles.admin, IDS.roles.member], 1200),
    rawMember(users.mod, [IDS.roles.mod, IDS.roles.member], 900),
    rawMember(users.member, [IDS.roles.member, IDS.roles.gamer], 400),
    rawMember(users.target, [IDS.roles.member], 120),
    rawMember(users.bot, [IDS.roles.bot], 300),
    rawMember(users.otherBot, [], 200),
  ];

  if (big) addCrowd({ roles, channels, members, users });
  if (restrictBot) {
    // Le bot ne peut pas écrire dans #général ni voir #logs (permissions de salon).
    const deny = (key, flags) => channels.find((c) => c.id === IDS.channels[key]).permission_overwrites.push({ id: IDS.roles.bot, type: 0, allow: '0', deny: perms(...flags) });
    deny('general', [P.SendMessages, P.EmbedLinks, P.ManageMessages, P.ManageChannels, P.ManageRoles]);
    deny('logs', [P.ViewChannel]);
  }

  const threads = [{
    id: IDS.channels.thread,
    type: 11,
    guild_id: IDS.guild,
    parent_id: IDS.channels.general,
    name: 'discussion',
    owner_id: IDS.users.member,
    rate_limit_per_user: 0,
    message_count: 3,
    member_count: 2,
    total_message_sent: 3,
    last_message_id: null,
    flags: 0,
    thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: new Date().toISOString(), locked: false, invitable: true },
  }];

  const guild = {
    id: IDS.guild,
    name: 'Serveur de test',
    icon: null,
    splash: null,
    discovery_splash: null,
    banner: null,
    description: 'Un serveur pour les tests de bout en bout',
    owner_id: IDS.users.owner,
    afk_channel_id: null,
    afk_timeout: 300,
    verification_level: 1,
    default_message_notifications: 1,
    explicit_content_filter: 2,
    mfa_level: 0,
    nsfw_level: 0,
    application_id: null,
    system_channel_id: IDS.channels.general,
    system_channel_flags: 0,
    rules_channel_id: IDS.channels.rules,
    public_updates_channel_id: IDS.channels.modLog,
    safety_alerts_channel_id: null,
    vanity_url_code: null,
    premium_tier: 1,
    premium_subscription_count: 3,
    premium_progress_bar_enabled: false,
    preferred_locale: 'fr',
    max_members: 500000,
    max_video_channel_users: 25,
    features: ['COMMUNITY', 'NEWS'],
    emojis: [
      { id: IDS.emoji, name: 'gadget', roles: [], require_colons: true, managed: false, animated: false, available: true },
      ...(big ? Array.from({ length: 60 }, (_, i) => ({ id: id(5000 + i), name: `emoji_tres_long_nom_${i}`.slice(0, 32), roles: [], require_colons: true, managed: false, animated: i % 3 === 0, available: true })) : []),
    ],
    stickers: [],
    roles,
    channels,
    threads,
    members,
    voice_states: [],
    presences: [],
    stage_instances: [],
    guild_scheduled_events: [],
    soundboard_sounds: [],
    member_count: members.length,
    large: false,
    unavailable: false,
    joined_at: new Date(Date.now() - 300 * DAY).toISOString(),
    shardId: 0,
  };

  return { guild, users };
}

/**
 * « Gros » serveur : beaucoup de rôles, salons, catégories et membres, avec des
 * noms longs et des caractères Markdown — pour les listes, menus (≤ 25 options)
 * et limites de longueur.
 */
function addCrowd({ roles, channels, members, users }) {
  const long = (base, n, max) => `${base} ${'*_~`|'.repeat(4)} ${'ñ'.repeat(max)}`.slice(0, max - String(n).length) + n;
  // 60 rôles sous le rôle du bot (positions décalées).
  for (const r of roles) if (r.position >= 1) r.position += 60;
  for (let i = 0; i < 60; i += 1) {
    roles.push(rawRole('member', long('Rôle', i, 100), 1 + i, '0', { id: id(1000 + i), color: (i * 2654435761) % 0xffffff, mentionable: i % 2 === 0 }));
  }
  // 30 catégories, 90 salons texte, 20 vocaux.
  for (let c = 0; c < 30; c += 1) {
    const catId = id(2000 + c);
    channels.push(rawChannel('catGeneral', 4, long('Catégorie', c, 100), 10 + c, { id: catId }));
    for (let k = 0; k < 3; k += 1) channels.push(rawChannel('general', 0, long(`salon-${c}`, k, 100).toLowerCase().replace(/\s+/g, '-'), k, { id: id(3000 + c * 3 + k), parent_id: catId, topic: 'x'.repeat(1024) }));
    if (c < 20) channels.push(rawChannel('voice', 2, long('Vocal', c, 100), 5, { id: id(4000 + c), parent_id: catId }));
  }
  // 200 membres aux pseudos longs.
  for (let i = 0; i < 200; i += 1) {
    const user = rawUser('member', `Membre ${'*_'.repeat(5)} ${i}`.slice(0, 32), { id: id(6000 + i, Date.parse('2019-01-01T00:00:00Z') + i * 1000), username: `membre_tres_long_${i}`.slice(0, 32) });
    users[`crowd${i}`] = user;
    members.push(rawMember(user, [IDS.roles.member, id(1000 + (i % 60))], 10 + i, { nick: i % 2 ? `${'Pseudo'.repeat(5)}${i}`.slice(0, 32) : null }));
  }
}

module.exports = { IDS, buildGuild, rawUser, rawMember, rawChannel, rawRole, perms, EVERYONE_PERMS };
