'use strict';

/**
 * Non-régression de la relecture n° 2 — utilitaires, configuration générale, design.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits, ButtonStyle } = require('discord.js');
const { defaultGuildConfig } = require('../src/config/defaults');
const { ConfigService } = require('../src/services/ConfigService');
const { StrikeService } = require('../src/services/StrikeService');
const settings = require('../src/commands/configuration/settings');
const diagnostics = require('../src/commands/configuration/diagnostics');
const embed = require('../src/commands/utility/embed');
const { INVITE_PERMISSIONS } = require('../src/commands/utility/invite');
const emoji = require('../src/commands/information/emoji');
const roles = require('../src/commands/information/roles');
const inrole = require('../src/commands/information/inrole');
const help = require('../src/commands/information/help');
const timestamp = require('../src/commands/utility/timestamp');
const { evaluate, CalcError } = require('../src/utils/calc');
const { paginate, lazyPages } = require('../src/utils/pagination');
const { card, field, fitEmbeds } = require('../src/utils/ui');
const { LIMITS } = require('../src/utils/embeds');

const BOT = 'bot';
const toJSON = (x) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);
const conf = (patch = {}) => ({ ...JSON.parse(JSON.stringify(defaultGuildConfig)), ...patch });
const embedTotal = (e) => (e.title?.length || 0) + (e.description?.length || 0) + (e.footer?.text?.length || 0) + (e.author?.name?.length || 0)
  + (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);

function memoryConfig() {
  const rows = new Map();
  return new ConfigService({ get: (id) => rows.get(id) ?? null, set: (id, data) => rows.set(id, data) });
}

/** Rôle factice ; `position` relative au rôle du bot (position 5). */
const role = (id, position, extra = {}) => ({ id, position, managed: false, toString: () => `<@&${id}>`, ...extra });

function fakeGuild({ roleList = [], channels = [], me = true } = {}) {
  const all = [role('g1', 0), role(BOT, 5), ...roleList];
  return {
    id: 'g1',
    name: 'Serveur',
    iconURL: () => null,
    members: {
      me: me
        ? { permissions: { has: () => true }, roles: { highest: all.find((r) => r.id === BOT) } }
        : null,
    },
    roles: { cache: new Collection(all.map((r) => [r.id, r])) },
    channels: { cache: new Collection(channels.map((c) => [c.id, { toString: () => `<#${c.id}>`, isTextBased: () => true, permissionsFor: () => ({ has: () => true }), ...c }])) },
  };
}

// ---------------------------------------------------------------- /settings moderation

test('settings : paliers « 3=mute 1h, 5=kick, 7=ban » au format de strikes.thresholds', () => {
  assert.deepEqual(settings.parseThresholds('7=ban, 3=MUTE 1H ; 5 = kick'), [
    { strikes: 3, action: 'mute', duration: '1h' },
    { strikes: 5, action: 'kick', duration: null },
    { strikes: 7, action: 'ban', duration: null },
  ]);
  assert.deepEqual(settings.parseThresholds('2=timeout'), [{ strikes: 2, action: 'timeout', duration: '1h' }], 'durée par défaut de /warn');
  assert.deepEqual(settings.parseThresholds('aucun'), []);
  const bad = {
    '3=mute 1h,': /élément vide/,
    '': /élément vide/,
    '3=mute, 3=ban': /deux fois/,
    '3=tempban 1d': /action inconnue/,
    '5=kick 1h': /pas de durée/,
    '3=mute 1x': /durée invalide/,
    '3=timeout 30d': /28 jours/,
    '0=ban': /entre 1 et 100/,
    '101=ban': /entre 1 et 100/,
    'trois=ban': /invalide/,
    [Array.from({ length: 11 }, (_, i) => `${i + 1}=kick`).join(',')]: /Au plus/,
  };
  for (const [input, re] of Object.entries(bad)) assert.throws(() => settings.parseThresholds(input), re, input);
});

function moderationInteraction(guild, values) {
  const calls = {};
  return {
    calls,
    guild,
    guildId: guild.id,
    options: {
      getSubcommand: () => 'moderation',
      getBoolean: (n) => (n in values ? values[n] : null),
      getString: (n) => (n in values ? values[n] : null),
      getRole: (n) => values[n] ?? null,
    },
    reply: async (p) => { calls.reply = p; },
  };
}

test('settings moderation : raison obligatoire, strikes, paliers et rôle muet réellement écrits', async () => {
  const config = memoryConfig();
  const client = { services: { config } };
  const guild = fakeGuild({ roleList: [role('muted', 2)] });
  const i = moderationInteraction(guild, { raison_obligatoire: true, strikes: true, paliers: '2=mute 10m, 4=ban', role_muet: guild.roles.cache.get('muted') });
  await settings.execute(i, client);
  const cfg = config.get('g1');
  assert.equal(cfg.moderation.requireReason, true);
  assert.equal(cfg.moderation.mutedRoleId, 'muted');
  assert.equal(cfg.moderation.dmOnSanction, true, 'option non fournie : inchangée');
  assert.deepEqual(cfg.strikes.thresholds, [{ strikes: 2, action: 'mute', duration: '10m' }, { strikes: 4, action: 'ban', duration: null }]);
  // StrikeService lit exactement ce format.
  const strikes = new StrikeService({}, config);
  assert.deepEqual(strikes.resolveAction('g1', 3), { strikes: 2, action: 'mute', duration: '10m' });
  assert.equal(strikes.resolveAction('g1', 4).action, 'ban');
  const text = JSON.stringify(toJSON(i.calls.reply.embeds[0]));
  assert.ok(text.includes('Raison obligatoire') && text.includes('✏️'));
  assert.equal(i.calls.reply.ephemeral, true);

  const off = moderationInteraction(guild, { strikes: false });
  await settings.execute(off, client);
  assert.equal(config.get('g1').strikes.enabled, false);
  assert.equal(strikes.resolveAction('g1', 10), null);
  assert.equal(config.get('g1').strikes.thresholds.length, 2, 'les paliers sont conservés');
});

test('settings moderation : rôle muet refusé s\'il est au-dessus du bot, géré ou @everyone ; sans option : avertissement', async () => {
  const config = memoryConfig();
  const client = { services: { config } };
  const guild = fakeGuild({ roleList: [role('high', 9), role('integ', 1, { managed: true })] });
  for (const [r, re] of [['high', /au-dessus/], ['integ', /intégration/], ['g1', /@everyone/]]) {
    await assert.rejects(settings.execute(moderationInteraction(guild, { role_muet: guild.roles.cache.get(r) }), client), re);
  }
  await assert.rejects(settings.execute(moderationInteraction(guild, { paliers: '3=explode' }), client), /action inconnue/);
  assert.equal(config.get('g1').moderation.mutedRoleId, null, 'rien écrit');
  const none = moderationInteraction(guild, {});
  await settings.execute(none, client);
  assert.match(toJSON(none.calls.reply.embeds[0]).description, /raison_obligatoire/);
});

test('settings : modules actifs incluant Bienvenue et Niveaux, une seule action Primary dans l\'onglet Logs', async () => {
  const guild = fakeGuild();
  const base = conf();
  const before = settings.renderDashboard(guild, base).toJSON();
  const total = Number(/\*\*\d+\/(\d+)\*\* modules actifs/.exec(before.description)[1]);
  assert.equal(total, 11);
  const on = conf({ levels: { ...base.levels, enabled: true }, welcome: { ...base.welcome, join: { ...base.welcome.join, enabled: true } } });
  const after = settings.renderDashboard(guild, on).toJSON();
  const active = (d) => Number(/\*\*(\d+)\/\d+\*\* modules actifs/.exec(d.description)[1]);
  assert.equal(active(after), active(before) + 2);
  assert.ok(after.fields.some((f) => f.name.includes('Bienvenue') && f.value.includes('arrivées')));
  assert.ok(after.fields.length <= 25 && embedTotal(after) <= 6000);

  const client = { services: { config: { get: () => base } } };
  for (const action of ['view', 'logs', 'moderation']) {
    const calls = {};
    await settings.buttons[action]({ guild, guildId: 'g1', memberPermissions: { has: () => true }, update: async (p) => { calls.update = p; } }, client);
    const primaries = calls.update.components.flatMap((r) => toJSON(r).components).filter((c) => c.style === ButtonStyle.Primary);
    assert.equal(primaries.length, 1, `onglet ${action}`);
  }
});

// ---------------------------------------------------------------- /diagnostics

const checksOf = (guild, cfg) => diagnostics.analyze(guild, cfg).flatMap((g) => g.checks);

test('diagnostics : un seul rôle au-dessus du bot n\'est plus « en haut de la liste »', () => {
  const top = checksOf(fakeGuild(), conf()).find((c) => /en haut de la liste/.test(c.text));
  assert.equal(top?.level, 'ok');
  const one = checksOf(fakeGuild({ roleList: [role('admin', 6)] }), conf());
  assert.ok(!one.some((c) => /en haut de la liste/.test(c.text)));
  assert.ok(one.some((c) => c.level === 'warn' && /\*\*1\*\* rôle au-dessus/.test(c.text)));
});

test('diagnostics : rôles référencés (existence + hiérarchie) et salons de bienvenue / niveaux / modmail', () => {
  const base = conf();
  const cfg = conf({
    welcome: { ...base.welcome, autoRoles: { humans: ['low', 'gone'], bots: ['high'] }, join: { ...base.welcome.join, channelId: 'nochan' }, verification: { ...base.welcome.verification, roleId: 'low' } },
    levels: { ...base.levels, rewards: [{ level: 5, roleId: 'high' }], announce: { ...base.levels.announce, mode: 'channel', channelId: 'ann' } },
    moderation: { ...base.moderation, mutedRoleId: 'low' },
    tickets: { ...base.tickets, supportRoleIds: ['staff'] },
    logs: { ...base.logs, staffRoleId: 'gone2' },
    modmail: { ...base.modmail, logChannel: 'mm' },
  });
  const guild = fakeGuild({ roleList: [role('low', 2), role('high', 8), role('staff', 9)], channels: [{ id: 'ann' }, { id: 'mm' }] });
  const checks = checksOf(guild, cfg);
  const find = (re) => checks.filter((c) => re.test(c.text));
  assert.ok(find(/Rôle auto \(membres\) : rôle introuvable/).every((c) => c.level === 'fail') && find(/Rôle auto \(membres\) : rôle introuvable/).length === 1);
  assert.equal(find(/Rôle auto \(membres\) : <@&low>/)[0].level, 'ok');
  assert.equal(find(/Rôle auto \(bots\)/)[0].level, 'warn', 'rôle attribué au-dessus du bot');
  assert.equal(find(/Récompense niveau 5/)[0].level, 'warn');
  assert.equal(find(/Rôle de vérification/)[0].level, 'ok');
  assert.equal(find(/Rôle muet/)[0].level, 'ok');
  assert.equal(find(/Rôle staff des tickets/)[0].level, 'ok', 'rôle staff : pas de contrainte de hiérarchie');
  assert.equal(find(/Rôle staff des logs/)[0].level, 'fail');
  assert.equal(find(/Salon de bienvenue/)[0].level, 'fail');
  assert.equal(find(/Annonces de niveau/)[0].level, 'ok');
  assert.equal(find(/Transcripts du modmail/)[0].level, 'ok');
});

test('diagnostics : le hub de vocaux temporaires n\'exige que Voir / Se connecter / Déplacer', () => {
  const base = conf();
  const cfg = conf({ tempVoice: { ...base.tempVoice, enabled: true, hubChannelId: 'hub' } });
  const voicePerms = (granted) => ({ has: (flags) => [flags].flat().every((f) => granted.includes(f)) });
  const hub = (granted) => ({ id: 'hub', isTextBased: () => true, permissionsFor: () => voicePerms(granted) });
  const level = (granted) => checksOf(fakeGuild({ channels: [hub(granted)] }), cfg).find((c) => /Créer un vocal/.test(c.text)).level;
  assert.equal(level([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers]), 'ok', 'sans Envoyer ni Intégrer');
  assert.equal(level([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]), 'warn', 'Déplacer manquant');
});

test('invite / diagnostics : « Gérer le serveur » demandé et contrôlé, mêmes listes', () => {
  assert.ok(INVITE_PERMISSIONS.includes('ManageGuild'));
  assert.deepEqual(diagnostics.RECOMMENDED_PERMS.map(([, flag]) => flag), INVITE_PERMISSIONS.map((n) => PermissionFlagsBits[n]));
  assert.ok(diagnostics.RECOMMENDED_PERMS.every(([label, flag]) => typeof label === 'string' && typeof flag === 'bigint'));
});

// ---------------------------------------------------------------- /embed

test('/embed : total de 6000 caractères et URL de plus de 2048 caractères refusés avant l\'envoi', async () => {
  assert.throws(() => embed.validateEmbedInput({ title: 't'.repeat(256), description: 'd'.repeat(4096), footer: 'f'.repeat(2000) }), /6000 caractères au total.*\*\*6352\*\*\/6000.*\*\*352\*\*/s);
  assert.doesNotThrow(() => embed.validateEmbedInput({ title: 't'.repeat(256), description: 'd'.repeat(4096), footer: 'f'.repeat(1648) }));
  const long = `https://exemple.fr/${'a'.repeat(2048)}`;
  assert.throws(() => embed.validateEmbedInput({ description: 'x', image: long }), /URL de l'image est trop longue/);
  assert.throws(() => embed.validateEmbedInput({ description: 'x', thumbnail: long }), /miniature est trop longue/);
  assert.throws(() => embed.validateEmbedInput({ description: 'x', image: 'ftp://x' }), /http/);
  const opt = embed.data.toJSON().options.find((o) => o.name === 'send').options.find((o) => o.name === 'image');
  assert.equal(opt.max_length, 2048);

  const sent = [];
  const values = { titre: 't'.repeat(256), description: 'd'.repeat(4096), footer: 'f'.repeat(2048) };
  const interaction = {
    options: { getSubcommand: () => 'send', getString: (n) => values[n] ?? null, getChannel: () => null },
    channel: { send: async (p) => sent.push(p), permissionsFor: () => ({ has: () => true }) },
    member: {},
    reply: async () => {},
  };
  await assert.rejects(embed.execute(interaction), /6000/);
  assert.equal(sent.length, 0);
});

test('ui.fitEmbeds : total ramené sous 6000 caractères pour un envoi direct', () => {
  const big = card({ description: 'x'.repeat(4096), fields: Array.from({ length: 10 }, (_, i) => field('🔢', `F${i}`, 'v'.repeat(1024))) });
  assert.ok(embedTotal(big.toJSON()) > LIMITS.total);
  const [fitted] = fitEmbeds(big);
  assert.ok(embedTotal(fitted) <= LIMITS.total);
  assert.equal(fitEmbeds([big, big]).length, 2);
});

// ---------------------------------------------------------------- /emoji

test('/emoji : keycaps acceptés, seul du vrai emoji passe pour « standard »', () => {
  for (const ok of ['1️⃣', '#️⃣', '*️⃣', '😀', '🇫🇷', '👍🏽', '👨‍👩‍👧', '❤️', '😀 🇫🇷 1️⃣']) assert.ok(emoji.parseStandardEmojis(ok), ok);
  for (const bad of ['a', '1', '→', '€', '§', 'é', '😀a', '🇫', '.', '']) assert.equal(emoji.parseStandardEmojis(bad), null, bad);
  assert.equal(emoji.parseStandardEmojis('😀'.repeat(11)), null, '10 emojis au plus');
  assert.deepEqual(emoji.parseStandardEmojis('1️⃣2️⃣'), ['1️⃣', '2️⃣']);
});

// ---------------------------------------------------------------- /roles et /inrole

test('/roles : membres comptés en une passe, sans Role#members', () => {
  const member = (...ids) => ({ roles: { cache: new Map(['g1', ...ids].map((id) => [id, {}])) } });
  const guild = { id: 'g1', name: 'S', iconURL: () => null, members: { cache: new Collection([['a', member('r1', 'r2')], ['b', member('r1')], ['c', member()]]) } };
  const counts = roles.countMembersByRole(guild);
  assert.equal(counts.get('r1'), 2);
  assert.equal(counts.get('r2'), 1);
  const trap = (id) => ({ id, position: 1, toString: () => `<@&${id}>`, get members() { throw new Error('Role#members ne doit pas être utilisé'); } });
  const [page] = roles.buildPages(guild, [trap('r1'), trap('r2'), trap('r3')]);
  const desc = page.toJSON().description;
  assert.match(desc, /<@&r1> · 2/);
  assert.match(desc, /<@&r3> · 0/);
});

test('/inrole : pages construites à la demande', async () => {
  const roleObj = { name: 'Staff', color: 0, toString: () => '<@&1>' };
  const members = Array.from({ length: 95 }, (_, i) => ({ id: String(i), user: { username: `m${i}` }, toString: () => `<@${i}>` }));
  const lazy = inrole.lazyRolePages(roleObj, members);
  assert.equal(lazy.length, 5);
  assert.equal(toJSON(lazy.at(4)).description.includes('<@94>'), true);
  assert.equal(inrole.buildPages(roleObj, members).length, 5);

  let built = 0;
  const pages = lazyPages(5, (i) => { built += 1; return card({ description: `page ${i}` }); });
  let reply;
  const interaction = {
    id: 'i1',
    user: { id: '111111111111111111' },
    reply: async (p) => { reply = p; return { createMessageComponentCollector: () => ({ on() {} }) }; },
  };
  await paginate(interaction, pages);
  assert.equal(built, 1, 'seule la première page est rendue');
  assert.match(toJSON(reply.embeds[0]).footer.text, /Page 1\/5/);
});

// ---------------------------------------------------------------- /help

test('/help : délai par défaut réel (2 s) au lieu de « Aucun »', () => {
  assert.equal(help.cooldownLabel({}), '`2 s` (par défaut)');
  assert.equal(help.cooldownLabel({ cooldown: 10_000 }), '`10 s`');
  assert.equal(help.cooldownLabel({ cooldown: 0 }), 'Aucun');
  const e = help.commandDetailEmbed({ data: { toJSON: () => ({ name: 'x', description: 'd', options: [] }) }, category: 'utility' }).toJSON();
  assert.ok(e.fields.some((f) => f.name.includes('Délai') && f.value.includes('2 s')));
});

// ---------------------------------------------------------------- /timestamp

test('/timestamp : « 14h » et « 14h30 » sont des heures, la durée exige un signe ou une forme non horaire', () => {
  const now = Date.UTC(2026, 9, 8, 8, 0); // 10:00 à Paris (UTC+2)
  const at = (s) => timestamp.parseWhen(s, 'Europe/Paris', now);
  assert.equal(at('14h'), Date.UTC(2026, 9, 8, 12, 0));
  assert.equal(at('14h30'), Date.UTC(2026, 9, 8, 12, 30));
  assert.equal(at('14:30'), Date.UTC(2026, 9, 8, 12, 30));
  assert.equal(at('25/12/2026 18h'), Date.UTC(2026, 11, 25, 17, 0));
  assert.equal(at('+2h'), now + 2 * 3_600_000);
  assert.equal(at('dans 3d'), now + 3 * 86_400_000);
  assert.equal(at('3d'), now + 3 * 86_400_000);
  assert.equal(at('90m'), now + 90 * 60_000);
  for (const bad of ['abc', '+abc', '25h61', '']) assert.equal(at(bad), null, bad);
});

// ---------------------------------------------------------------- /calcul

test('calc : les noms hérités d\'Object.prototype ne sont ni constantes ni fonctions', () => {
  for (const expr of ['constructor', 'constructor(1)', 'valueof(1)', 'hasownproperty(1)']) {
    assert.throws(() => evaluate(expr), (err) => err instanceof CalcError && /inconnue/.test(err.message), expr);
  }
  assert.equal(evaluate('pi * 0'), 0);
  assert.equal(evaluate('sqrt(16)'), 4);
});
