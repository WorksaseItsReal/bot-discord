'use strict';

/**
 * Outils de modération et d'administration : AutoMod des pseudos, /softban, /modstats,
 * levées automatiques (lock, mode lent, lockdown), décroissance des strikes,
 * /role modifier, /channel (gestion) et /emoji (gestion).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ChannelType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { SanctionRepository, sanctionState } = require('../src/database/repositories/SanctionRepository');
const { StrikeRepository } = require('../src/database/repositories/StrikeRepository');
const { ReportRepository } = require('../src/database/repositories/ReportRepository');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { TimedActionRepository } = require('../src/database/repositories/TimedActionRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { StrikeService, DAY_MS } = require('../src/services/StrikeService');
const { ModerationService, TYPE_LABELS } = require('../src/services/ModerationService');
const { AutoModService } = require('../src/services/AutoModService');
const { TimedLockService, timedDuration } = require('../src/services/TimedLockService');
const { parseDuration } = require('../src/utils/time');
const names = require('../src/utils/automod/names');
const modstats = require('../src/commands/moderation/modstats');
const emoji = require('../src/commands/information/emoji');
const role = require('../src/commands/roles/role');
const channel = require('../src/commands/information/channelinfo');
const settings = require('../src/commands/configuration/settings');
const automod = require('../src/commands/automod/automod');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');

const G = '100000000000000001';
const U = '500000000000000001';
const MOD = '500000000000000002';

function db() {
  const { db: raw } = memoryDb();
  return raw;
}

// ---------------------------------------------------------------- migration 21

test('migration 21 : strike_events et timed_channel_actions, reprise des strikes existants', () => {
  const m = migrations.find((x) => x.id === 21);
  assert.ok(m, 'migration 21 présente');
  const ids = migrations.map((x) => x.id);
  assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'ids croissants');
  const raw = db();
  // Reprise : un compteur existant devient une ligne datée de sa dernière mise à jour.
  raw.prepare('DELETE FROM strike_events').run();
  raw.prepare('INSERT INTO strikes (guild_id, user_id, count, updated_at) VALUES (?, ?, ?, ?)').run(G, U, 4, 1_000);
  raw.exec(m.up);
  assert.deepEqual(raw.prepare('SELECT amount, created_at FROM strike_events WHERE user_id = ?').get(U), { amount: 4, created_at: 1_000 });
  const cols = raw.prepare('PRAGMA table_info(timed_channel_actions)').all().map((c) => c.name);
  for (const c of ['guild_id', 'channel_id', 'kind', 'data', 'expires_at', 'active', 'end_reason']) assert.ok(cols.includes(c), c);
});

// ---------------------------------------------------------------- décroissance des strikes

function strikeWorld() {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  const repo = new StrikeRepository(raw);
  return { raw, config, repo, strikes: new StrikeService(repo, config), sanctions: new SanctionRepository(raw) };
}

test('décroissance : les strikes de plus de N jours ne comptent plus, rien n\'est supprimé', () => {
  const { config, repo, strikes } = strikeWorld();
  const now = Date.now();
  repo.add(G, U, 2, now - 40 * DAY_MS);
  repo.add(G, U, 1, now - 10 * DAY_MS);
  repo.add(G, U, 1, now - 1 * DAY_MS);
  assert.equal(strikes.getCount(G, U), 4, 'sans décroissance : tout compte');
  config.update(G, { strikes: { decayDays: 30 } });
  assert.equal(strikes.getCount(G, U), 2, 'strikes de 40 jours ignorés');
  assert.equal(strikes.getTotal(G, U), 4, 'total conservé');
  assert.ok(Math.abs(strikes.nextDecayAt(G, U) - (now - 10 * DAY_MS + 30 * DAY_MS)) < 5_000);
  config.update(G, { strikes: { decayDays: 7 } });
  assert.equal(strikes.getCount(G, U), 1);
  const res = strikes.add(G, U, 1);
  assert.deepEqual([res.count, res.total], [2, 5]);
  config.update(G, { strikes: { decayDays: 0 } });
  assert.equal(strikes.getCount(G, U), 5, 'remis à 0 : tout recompte');
  strikes.reset(G, U);
  assert.equal(strikes.getCount(G, U), 0);
  config.update(G, { strikes: { decayDays: 30 } });
  assert.equal(strikes.getCount(G, U), 0, 'reset : lignes datées effacées aussi');
});

test('décroissance : set() remplace l\'historique daté ; valeur absurde ignorée', () => {
  const { config, repo, strikes } = strikeWorld();
  repo.add(G, U, 3, Date.now() - 100 * DAY_MS);
  repo.set(G, U, 4);
  config.update(G, { strikes: { decayDays: 30 } });
  assert.equal(strikes.getCount(G, U), 4);
  config.update(G, { strikes: { decayDays: -5 } });
  assert.equal(strikes.decayDays(G), 0);
  config.update(G, { strikes: { decayDays: 10_000 } });
  assert.equal(strikes.decayDays(G), 365);
});

test('décroissance : un palier appliqué avant la fenêtre ne bloque plus sa réapplication', () => {
  const { raw, config, strikes, sanctions } = strikeWorld();
  const id = sanctions.create({ guildId: G, userId: U, moderatorId: MOD, type: 'timeout', escalationStep: 3 });
  raw.prepare('UPDATE sanctions SET created_at = ? WHERE id = ?').run(Date.now() - 60 * DAY_MS, id);
  assert.equal(sanctions.maxEscalationStep(G, U), 3);
  config.update(G, { strikes: { decayDays: 30 } });
  const since = strikes.activeSince(G);
  assert.equal(sanctions.maxEscalationStep(G, U, since), 0);
  assert.equal(strikes.pendingEscalation(G, 3, sanctions.maxEscalationStep(G, U, since)).action, 'mute');
});

test('/settings moderation decroissance : bornée et enregistrée', () => {
  const opts = (values) => ({
    getBoolean: () => null,
    getString: () => null,
    getRole: () => null,
    getInteger: (n) => values[n] ?? null,
  });
  const { patch, edited } = settings.readModerationOptions({ options: opts({ decroissance: 30 }), guild: {} }, {});
  assert.deepEqual(patch, { strikes: { decayDays: 30 } });
  assert.ok(edited.has('decroissance'));
  assert.throws(() => settings.readModerationOptions({ options: opts({ decroissance: 999 }), guild: {} }, {}), /365/);
  const card = settings.renderModeration({ moderation: {}, strikes: { enabled: true, thresholds: [], decayDays: 30 } }).toJSON();
  assert.ok(card.fields.some((f) => f.value.includes('30')), 'expiration affichée');
});

// ---------------------------------------------------------------- AutoMod des pseudos (pur)

test('pseudos : dehoist, illisible, usurpation (mots et staff à un homoglyphe près), mots interdits', () => {
  const staff = new Map([[names.nameSkeleton('Alice'), 'Alice']]);
  const v = (name, checks = {}) => names.nameViolation(name, checks, { words: ['arnaque'], staff })?.check ?? null;
  assert.equal(v('!Bob'), 'dehoist');
  assert.equal(v('​Bob'), 'dehoist');
  assert.equal(v('.Zoé'), 'dehoist');
  assert.equal(v('Bob'), null);
  assert.equal(v('Z̷̢̛a̴l̵g̶o̷̊̋'), 'unreadable');
  assert.equal(v('​​'), 'unreadable');
  for (const s of ['xXAdminXx', 'Discord Support', 'Système', 'S.t.a.f.f', '4dm1n', 'Modérateur', 'MrStaff']) assert.equal(v(s), 'impersonation', s);
  for (const s of ['Аlice', 'AIice', 'Al1ce']) assert.equal(v(s), 'impersonation', `homoglyphe ${s}`);
  for (const s of ['Badminton', 'Élodie', '李小龙', 'Jean-Paul', 'Membre 1234']) assert.equal(v(s), null, s);
  assert.equal(v('roi de l\'arnaque'), 'words');
  // Vérification désactivée : ignorée.
  assert.equal(v('!Bob', { dehoist: false }), null);
  assert.equal(v('4dm1n', { impersonation: false }), null);
  assert.equal(v('roi de l\'arnaque', { words: false }), null);
});

test('pseudos : modèle de renommage ({id}), modèles refusés', () => {
  assert.equal(names.replacementName('Membre {id}', '123456789012345678'), 'Membre 5678');
  assert.equal(names.replacementName('', '123456789012345678'), 'Membre 5678');
  assert.equal([...names.replacementName('x'.repeat(40), '1')].length, 32);
  assert.equal(names.templateIssue('Membre {id}'), null);
  assert.match(names.templateIssue('!Membre {id}'), /refusé/);
  assert.match(names.templateIssue('Admin {id}'), /refusé/);
  assert.match(names.templateIssue('@everyone {id}'), /mention/);
  assert.match(names.templateIssue('   '), /vide/);
  assert.match(names.templateIssue('Arnaque {id}', ['arnaque']), /refusé/);
});

// ---------------------------------------------------------------- AutoMod des pseudos (service)

function nameWorld({ badNames = {}, automodEnabled = true } = {}) {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  config.update(G, { automod: { enabled: automodEnabled, filters: { badNames: { enabled: true, ...badNames }, badWords: { words: ['arnaque'] } } } });
  const logs = [];
  const staffMember = fakeMember({ id: MOD, globalName: 'Alice', perms: [PermissionFlagsBits.ModerateMembers] });
  const members = new Map([[MOD, staffMember]]);
  const guild = {
    id: G,
    ownerId: '500000000000000099',
    members: {
      cache: members,
      me: { id: 'bot', permissions: new PermissionsBitField([PermissionFlagsBits.ManageNicknames]) },
      fetch: async (id) => members.get(id) ?? null,
    },
    fetchAuditLogs: async () => ({ entries: { find: () => null } }),
  };
  for (const m of members.values()) m.guild = guild;
  const logging = { client: { user: { id: 'bot' } }, send: async (...args) => { logs.push(args); return true; } };
  const service = new AutoModService({ config, logging, moderation: {} });
  const add = (opts) => {
    const m = fakeMember(opts);
    m.guild = guild;
    members.set(m.id, m);
    return m;
  };
  return { service, config, guild, logs, add };
}

function fakeMember({ id = U, nickname = null, globalName = null, username = 'membre', perms = [], manageable = true, roles = [] } = {}) {
  const m = {
    id,
    nickname,
    manageable,
    partial: false,
    user: { id, globalName, username, bot: false, toString: () => `<@${id}>`, displayAvatarURL: () => null },
    permissions: new PermissionsBitField(perms),
    roles: { cache: { some: (fn) => roles.some((r) => fn({ id: r })), size: roles.length } },
    renames: [],
    toString: () => `<@${id}>`,
    async setNickname(nick) {
      m.renames.push(nick);
      m.nickname = nick;
      return m;
    },
  };
  return m;
}

test('pseudos : renommé à l\'arrivée selon le modèle, log « Pseudos renommés »', async () => {
  const w = nameWorld();
  const m = w.add({ globalName: '!!Hoisté' });
  const res = await w.service.checkMemberName(m, { source: 'join' });
  assert.equal(res.renamed, true);
  assert.deepEqual(m.renames, ['Membre 0001']);
  assert.equal(w.logs.length, 1);
  assert.equal(w.logs[0][1], 'automod');
  assert.equal(w.logs[0][4].event, 'automodNames');
  assert.equal(EVENT_CATEGORY.automodNames, 'automod');
  // La mise à jour provoquée par notre renommage n'est pas refiltrée (pas de boucle).
  const again = await w.service.checkMemberName(m, { previous: { ...m, nickname: null, partial: false }, source: 'update' });
  assert.equal(again, null);
  assert.equal(m.renames.length, 1);
});

test('pseudos : usurpation d\'un modérateur à un homoglyphe près ; staff, rôles ignorés et hiérarchie exemptés', async () => {
  const w = nameWorld({ badNames: { template: 'Invité {id}', exemptRoles: ['300000000000000001'] } });
  const fake = w.add({ id: '500000000000000005', nickname: 'АIice' });
  assert.equal((await w.service.checkMemberName(fake, { source: 'join' })).violation.check, 'impersonation');
  assert.deepEqual(fake.renames, ['Invité 0005']);
  const staff = w.add({ id: '500000000000000006', nickname: '!Modo', perms: [PermissionFlagsBits.ModerateMembers] });
  assert.equal(await w.service.checkMemberName(staff, { source: 'join' }), null);
  const vip = w.add({ id: '500000000000000007', nickname: '!VIP', roles: ['300000000000000001'] });
  assert.equal(await w.service.checkMemberName(vip, { source: 'join' }), null);
  const high = w.add({ id: '500000000000000008', nickname: '!Haut', manageable: false });
  const res = await w.service.checkMemberName(high, { source: 'join' });
  assert.equal(res.renamed, false);
  assert.deepEqual(high.renames, []);
});

test('pseudos : filtre ou AutoMod désactivés, pseudo inchangé, pseudo posé par /pseudo : rien', async () => {
  const off = nameWorld({ badNames: { enabled: false } });
  assert.equal(await off.service.checkMemberName(off.add({ nickname: '!x' }), { source: 'join' }), null);
  const disabled = nameWorld({ automodEnabled: false });
  assert.equal(await disabled.service.checkMemberName(disabled.add({ nickname: '!x' }), { source: 'join' }), null);
  const w = nameWorld();
  const m = w.add({ nickname: '!Same' });
  assert.equal(await w.service.checkMemberName(m, { previous: { ...m }, source: 'update' }), null, 'rôles modifiés seulement');
  w.service.allowName(G, m.id, '!Same');
  assert.equal(await w.service.checkMemberName(m, { source: 'update' }), null, 'choix d\'un modérateur');
  const words = w.add({ id: '500000000000000009', nickname: 'Roi de l arnaque' });
  assert.equal((await w.service.checkMemberName(words, { source: 'join' })).violation.check, 'words');
});

// ---------------------------------------------------------------- tableau de bord /automod (pseudos)

test('/automod : filtre « Pseudos » dans le groupe Sécurité, vue dédiée dans les limites', async () => {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  const client = { services: { config }, guilds: { cache: new Map() } };
  const guild = { id: G };
  const group = await automod.render(client, guild, 'grp:security');
  const menu = group.components.map((r) => r.toJSON())[1].components[0];
  assert.ok(menu.options.some((o) => o.value === 'badNames'));
  const view = await automod.render(client, guild, 'filter:badNames');
  const rows = view.components.map((r) => r.toJSON());
  assert.ok(rows.length <= 5);
  const ids = rows.flatMap((r) => r.components.map((c) => c.custom_id));
  assert.ok(ids.includes('cmd:automod:fexrole:badNames'));
  assert.ok(ids.includes('cmd:automod:pcheck:dehoist:off'));
  assert.ok(ids.includes('cmd:automod:fset:badNames'));
  assert.ok(ids.every((id) => !id || id.length <= 100));
  assert.ok(automod.filterLine('badNames', { enabled: true }).includes('Renommage'));
});

// ---------------------------------------------------------------- softban

test('softban : nouveau type de sanction (libellé, état « appliquée »)', () => {
  assert.equal(TYPE_LABELS.softban, 'Softban');
  assert.equal(sanctionState({ type: 'softban', active: 1, expires_at: null }), 'done');
  assert.equal(sanctionState({ type: 'softban', active: 0, expires_at: null }), 'done');
});

function softbanWorld({ unbanFails = 0, alreadyBanned = false } = {}) {
  const raw = db();
  const config = new ConfigService(new GuildConfigRepository(raw));
  config.update(G, { moderation: { dmOnSanction: false } });
  const sanctions = new SanctionRepository(raw);
  const calls = [];
  const logging = { send: async () => true };
  const moderation = new ModerationService({ sanctions, config, logging });
  let fails = unbanFails;
  const guild = {
    id: G,
    ownerId: '500000000000000099',
    members: { me: { id: 'bot', guild: null, roles: { highest: { position: 50 } } } },
    bans: {
      create: async (id, opts) => calls.push(['ban', id, opts.deleteMessageSeconds]),
      remove: async (id) => {
        if (fails > 0) {
          fails -= 1;
          throw Object.assign(new Error('boom'), { code: 500 });
        }
        calls.push(['unban', id]);
      },
      // discord.js : bans.fetch(id) ou bans.fetch({ user, force }).
      fetch: async (opts) => {
        const id = opts?.user ?? opts;
        if (alreadyBanned) return { user: { id } };
        throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
      },
    },
  };
  guild.members.me.guild = guild;
  const moderator = { id: MOD, guild, roles: { highest: { position: 40 } } };
  const user = { id: U, send: async () => null };
  const member = { id: U, guild, user, bannable: true, joinedTimestamp: 1, roles: { highest: { position: 1 } } };
  return { moderation, sanctions, calls, guild, moderator, user, member };
}

test('softban : ban (messages purgés) puis débannissement immédiat, enregistré comme « softban »', async () => {
  const w = softbanWorld();
  const res = await w.moderation.softban(w.guild, w.user, w.moderator, 'Spam', { deleteMessageSeconds: 2 * 86_400, targetMember: w.member });
  assert.deepEqual(w.calls, [['ban', U, 172_800], ['unban', U]]);
  assert.equal(res.unbanned, true);
  assert.equal(w.sanctions.get(G, res.id).type, 'softban');
  assert.equal(w.moderation.isRecentBotAction('unban', G, U), true, 'débannissement marqué comme action du bot');
});

test('softban : débannissement en échec réessayé, puis signalé (sanction gardée) ; déjà banni refusé', async () => {
  const retry = softbanWorld({ unbanFails: 1 });
  assert.equal((await retry.moderation.softban(retry.guild, retry.user, retry.moderator, null, { targetMember: retry.member })).unbanned, true);
  const fail = softbanWorld({ unbanFails: 5 });
  const res = await fail.moderation.softban(fail.guild, fail.user, fail.moderator, null, { targetMember: fail.member });
  assert.equal(res.unbanned, false);
  assert.equal(fail.sanctions.get(G, res.id).type, 'softban');
  const banned = softbanWorld({ alreadyBanned: true });
  await assert.rejects(banned.moderation.softban(banned.guild, banned.user, banned.moderator, null), /déjà banni/);
  assert.deepEqual(banned.calls, []);
});

// ---------------------------------------------------------------- /modstats

test('modstats : regroupement, mini-histogramme, tendance, période', () => {
  const s = modstats.summarize([
    { moderator_id: 'a', type: 'warn', n: 3 },
    { moderator_id: 'b', type: 'ban', n: 1 },
    { moderator_id: 'a', type: 'kick', n: 1 },
  ]);
  assert.equal(s.total, 5);
  assert.deepEqual(s.byType, { warn: 3, ban: 1, kick: 1 });
  assert.deepEqual(s.moderators.map((m) => [m.id, m.total]), [['a', 4], ['b', 1]]);
  const { line, counts } = modstats.sparkline([0, 1, 5, 9, 9, 50], 0, 10, 5);
  assert.deepEqual(counts, [2, 0, 1, 0, 2]);
  assert.equal(line.length, 5);
  assert.match(modstats.trendText(15, 10, 30), /\+50 %/);
  assert.match(modstats.trendText(5, 10, 30), /-50 %/);
  assert.match(modstats.trendText(3, 0, 7), /aucune/);
  assert.match(modstats.trendText(0, 0, 7), /Aucune/);
  assert.equal(modstats.parsePeriod('90'), 90);
  assert.equal(modstats.parsePeriod('12'), 30);
  assert.equal(modstats.bucketsFor(90), 13);
});

test('modstats : statistiques lues dans les tables (sanctions, signalements, tickets), carte dans les limites', () => {
  const raw = db();
  const sanctions = new SanctionRepository(raw);
  const reports = new ReportRepository(raw);
  const tickets = new TicketRepository(raw);
  for (let i = 0; i < 4; i += 1) sanctions.create({ guildId: G, userId: U, moderatorId: MOD, type: 'warn', reason: 'Spam' });
  sanctions.create({ guildId: G, userId: U, moderatorId: 'bot', type: 'softban', reason: 'spam ' });
  const old = sanctions.create({ guildId: G, userId: U, moderatorId: MOD, type: 'ban', reason: 'Ancien' });
  raw.prepare('UPDATE sanctions SET created_at = ? WHERE id = ?').run(Date.now() - 40 * DAY_MS, old);
  const r1 = reports.create({ guildId: G, reporterId: U, targetId: '500000000000000003', channelId: '1', messageId: '2' });
  reports.close(G, r1, 'handled', MOD);
  const r2 = reports.create({ guildId: G, reporterId: U, targetId: '500000000000000003', channelId: '1', messageId: '3' });
  reports.close(G, r2, 'dismissed', MOD);
  tickets.create({ guildId: G, channelId: '9', userId: U });
  tickets.setStatus('9', 'claimed', { claimedBy: MOD });

  const stats = sanctions.stats(G, { since: Date.now() - 30 * DAY_MS });
  assert.equal(stats.times.length, 5);
  assert.deepEqual(stats.reasons[0], { reason: 'spam', n: 5 });
  assert.equal(sanctions.stats(G, { since: Date.now() - 30 * DAY_MS, moderatorId: 'bot' }).times.length, 1);
  assert.deepEqual(reports.handledStats(G, { since: 0 }).map((r) => [r.handled_by, r.status, r.n]).sort(), [[MOD, 'dismissed', 1], [MOD, 'handled', 1]]);
  assert.deepEqual(tickets.claimedStats(G, { since: 0 }), [{ claimed_by: MOD, n: 1 }]);

  const client = { user: { id: 'bot' }, repositories: { sanctions, reports, tickets } };
  for (const days of [7, 30, 90]) {
    for (const moderatorId of [null, MOD]) {
      const view = modstats.statsView(client, { id: G }, { days, moderatorId });
      const e = view.embeds[0].toJSON();
      const size = (e.title?.length ?? 0) + (e.description?.length ?? 0) + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
      assert.ok(size < 6000);
      assert.ok(view.components.length <= 5);
      const expected = (days === 90 ? 1 : 0) + (moderatorId ? 4 : 5); // le ban de 40 jours n'entre que dans 90 jours
      assert.match(e.description, new RegExp(`\\*\\*${expected}\\*\\* sanction`));
    }
  }
});

// ---------------------------------------------------------------- levées automatiques

test('actions temporaires : une seule ligne active par cible, annulation, échéances', () => {
  const repo = new TimedActionRepository(db());
  const a = repo.schedule({ guildId: G, channelId: 'c1', kind: 'lock', expiresAt: 1_000 });
  const b = repo.schedule({ guildId: G, channelId: 'c1', kind: 'lock', expiresAt: 2_000 });
  assert.notEqual(a, b);
  assert.equal(repo.byId(a).active, 0);
  assert.equal(repo.byId(a).end_reason, 'replaced');
  assert.equal(repo.activeFor(G, 'lock', 'c1').id, b);
  repo.schedule({ guildId: G, channelId: 'c2', kind: 'slowmode', data: { applied: 10, previous: 0 }, expiresAt: 5_000 });
  assert.deepEqual(repo.findDue(3_000).map((r) => r.id), [b]);
  assert.deepEqual(repo.activeFor(G, 'slowmode', 'c2').data, { applied: 10, previous: 0 });
  assert.equal(repo.cancel(G, 'lock', 'c1'), true);
  assert.equal(repo.cancel(G, 'lock', 'c1'), false);
  assert.throws(() => repo.schedule({ guildId: G, channelId: 'c', kind: 'nope', expiresAt: 1 }));
  assert.throws(() => timedDuration('30s', parseDuration), /minimale/);
  assert.throws(() => timedDuration('xyz', parseDuration), /invalide/);
  assert.equal(timedDuration('2h', parseDuration), 7_200_000);
});

function timedWorld() {
  const raw = db();
  const repo = new TimedActionRepository(raw);
  const logs = [];
  const saved = new Map();
  const unlocked = [];
  let lockdownCount = 0;
  const disabled = [];
  const lockdown = {
    locks: { get: (g, c) => saved.get(c), save: (g, c, data) => saved.set(c, { data }) },
    status: () => lockdownCount,
    async unlockChannel(ch, reason, { timerReason } = {}) {
      unlocked.push([ch.id, reason]);
      saved.delete(ch.id);
      repo.cancel(G, 'lock', ch.id, timerReason);
    },
    async disable(guild, moderator, opts) {
      disabled.push(opts);
      repo.cancel(G, 'lockdown', G, opts.timerReason);
      lockdownCount = 0;
      return 3;
    },
  };
  const channels = new Map();
  const guild = { id: G, available: true, channels: { cache: channels } };
  const client = {
    user: { id: 'bot' },
    isReady: () => true,
    guilds: { cache: new Map([[G, guild]]) },
    channels: { fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); } },
    services: { lockdown, logging: { send: async (...a) => { logs.push(a); return true; } } },
  };
  const service = new TimedLockService({ client, timed: repo });
  const addChannel = (id, extra = {}) => {
    const ch = { id, guildId: G, toString: () => `<#${id}>`, ...extra };
    channels.set(id, ch);
    return ch;
  };
  return { raw, repo, service, saved, unlocked, disabled, logs, addChannel, setLockdown: (n) => { lockdownCount = n; } };
}

const past = () => Date.now() - 1_000;

test('levée automatique : verrouillage levé à l\'échéance ; déjà déverrouillé ou salon supprimé : rien', async () => {
  const w = timedWorld();
  w.addChannel('c1');
  w.saved.set('c1', { data: { v: 2, scope: 'manual', perms: { SendMessages: null } } });
  const until = w.service.schedule({ guildId: G, channelId: 'c1', kind: 'lock', durationMs: 60_000, moderatorId: MOD });
  assert.ok(until > Date.now());
  const { id } = w.repo.activeFor(G, 'lock', 'c1');
  await w.service.processDue();
  assert.deepEqual(w.unlocked, [], 'pas encore échu');
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ?').run(past());
  await w.service.processDue();
  assert.deepEqual(w.unlocked.map((u) => u[0]), ['c1']);
  assert.equal(w.repo.byId(id).end_reason, 'expired');
  assert.equal(w.logs[0][4].event, 'timedLift');
  // Déjà déverrouillé à la main : clôturé sans action.
  w.addChannel('c2');
  w.service.schedule({ guildId: G, channelId: 'c2', kind: 'lock', durationMs: 60_000 });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ? WHERE active = 1').run(past());
  await w.service.processDue();
  assert.equal(w.unlocked.length, 1);
  assert.equal(w.repo.activeFor(G, 'lock', 'c2'), null);
  // Salon supprimé : clôturé.
  w.service.schedule({ guildId: G, channelId: 'gone', kind: 'lock', durationMs: 60_000 });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ? WHERE active = 1').run(past());
  await w.service.processDue();
  assert.equal(w.repo.activeFor(G, 'lock', 'gone'), null);
  assert.ok(id > 0);
});

test('levée automatique : échec réessayé avec attente croissante, abandon signalé après 24 h', async () => {
  const w = timedWorld();
  const ch = w.addChannel('c1');
  let attempts = 0;
  const lockdown = w.service.lockdown;
  lockdown.unlockChannel = async () => {
    attempts += 1;
    throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
  };
  w.saved.set('c1', { data: { v: 2, scope: 'manual', perms: {} } });
  w.service.schedule({ guildId: G, channelId: 'c1', kind: 'lock', durationMs: 60_000 });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ?').run(past());
  await w.service.processDue();
  await w.service.processDue();
  assert.equal(attempts, 1, 'nouvel essai immédiat (appel voué à l\'échec répété)');
  assert.ok(w.repo.activeFor(G, 'lock', 'c1'), 'ligne abandonnée trop tôt');
  // Plus de 24 h de retard : abandon, signalé dans les logs.
  w.service.retries.clear();
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ?').run(Date.now() - 25 * 3_600_000);
  await w.service.processDue();
  assert.equal(w.repo.activeFor(G, 'lock', 'c1'), null);
  assert.match(w.logs.at(-1)[2].toJSON().title, /impossible/);
  assert.ok(ch);
});

test('levée automatique : pendant un lockdown, le salon reste verrouillé et rejoint le lockdown', async () => {
  const w = timedWorld();
  w.addChannel('c1');
  w.saved.set('c1', { data: { v: 2, scope: 'manual', perms: { SendMessages: true } } });
  w.service.schedule({ guildId: G, channelId: 'c1', kind: 'lock', durationMs: 60_000 });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ?').run(past());
  w.setLockdown(4);
  await w.service.processDue();
  assert.deepEqual(w.unlocked, []);
  assert.equal(w.saved.get('c1').data.scope, 'lockdown');
  assert.equal(w.repo.activeFor(G, 'lock', 'c1'), null);
});

test('levée automatique : mode lent rétabli s\'il n\'a pas changé ; changé à la main : intact', async () => {
  const w = timedWorld();
  const set = [];
  const ch = w.addChannel('c1', { rateLimitPerUser: 30, async setRateLimitPerUser(s) { set.push(s); ch.rateLimitPerUser = s; } });
  w.service.schedule({ guildId: G, channelId: 'c1', kind: 'slowmode', durationMs: 60_000, data: { applied: 30, previous: 5 } });
  const other = w.addChannel('c2', { rateLimitPerUser: 60, async setRateLimitPerUser(s) { set.push(['c2', s]); } });
  w.service.schedule({ guildId: G, channelId: 'c2', kind: 'slowmode', durationMs: 60_000, data: { applied: 30, previous: 0 } });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ?').run(past());
  await w.service.processDue();
  assert.deepEqual(set, [5]);
  assert.equal(ch.rateLimitPerUser, 5);
  assert.equal(other.rateLimitPerUser, 60);
  assert.equal(w.repo.activeFor(G, 'slowmode', 'c2'), null);
});

test('levée automatique : lockdown levé via LockdownService ; déjà levé : rien', async () => {
  const w = timedWorld();
  w.setLockdown(5);
  w.service.schedule({ guildId: G, channelId: G, kind: 'lockdown', durationMs: 60_000 });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ?').run(past());
  await w.service.processDue();
  assert.equal(w.disabled.length, 1);
  assert.equal(w.disabled[0].timerReason, 'expired');
  assert.match(w.disabled[0].reason, /automatique/);
  w.service.schedule({ guildId: G, channelId: G, kind: 'lockdown', durationMs: 60_000 });
  w.raw.prepare('UPDATE timed_channel_actions SET expires_at = ? WHERE active = 1').run(past());
  await w.service.processDue();
  assert.equal(w.disabled.length, 1, 'déjà levé : pas de second appel');
});

// ---------------------------------------------------------------- /emoji (gestion)

test('/emoji : seules les URL d\'emojis de cdn.discordapp.com sont acceptées', () => {
  assert.equal(emoji.emojiSourceUrl('https://cdn.discordapp.com/emojis/123456789012345678.png?size=64'), 'https://cdn.discordapp.com/emojis/123456789012345678.png');
  assert.equal(emoji.emojiSourceUrl('<a:dance:123456789012345678>'), 'https://cdn.discordapp.com/emojis/123456789012345678.gif');
  for (const bad of ['https://example.com/emojis/123456789012345678.png', 'http://cdn.discordapp.com/emojis/123456789012345678.png', 'https://cdn.discordapp.com.evil.com/emojis/1.png', 'https://localhost/emojis/123456789012345678.png', 'https://127.0.0.1/a.png', 'https://cdn.discordapp.com/attachments/1/2/a.png', 'https://user:pass@cdn.discordapp.com/emojis/123456789012345678.png', 'pas une url']) {
    assert.throws(() => emoji.emojiSourceUrl(bad), { name: 'UserError' }, bad);
  }
  assert.throws(() => emoji.attachmentSourceUrl({ size: 300 * 1024, url: 'https://cdn.discordapp.com/attachments/1/2/a.png', contentType: 'image/png' }), /256 Ko/);
  assert.throws(() => emoji.attachmentSourceUrl({ size: 10, url: 'https://cdn.discordapp.com/attachments/1/2/a.txt', contentType: 'text/plain' }), /image/);
  assert.throws(() => emoji.attachmentSourceUrl({ size: 10, url: 'https://evil.example/a.png', contentType: 'image/png' }), /hors de Discord/);
  assert.equal(emoji.attachmentSourceUrl({ size: 10, url: 'https://cdn.discordapp.com/attachments/1/2/a.png', contentType: 'image/png' }), 'https://cdn.discordapp.com/attachments/1/2/a.png');
  assert.equal(emoji.assertEmojiName(':gadget_ok:'), 'gadget_ok');
  assert.throws(() => emoji.assertEmojiName('é'), /Nom invalide/);
  assert.equal(emoji.emojiLimit({ premiumTier: 0 }), 50);
  assert.equal(emoji.emojiLimit({ premiumTier: 3 }), 250);
  assert.equal(emoji.emojiLimit({ premiumTier: 1, features: ['MORE_EMOJI'] }), 200);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('/emoji : téléchargement borné (10 s, 256 Ko, sans redirection), format lu dans le contenu', async () => {
  const seen = [];
  const ok = async (url, init) => {
    seen.push([url, init.redirect, typeof init.signal]);
    return new Response(PNG, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const img = await emoji.downloadEmojiImage('https://cdn.discordapp.com/emojis/123456789012345678.png', { fetchImpl: ok });
  assert.equal(img.mime, 'image/png');
  assert.equal(img.animated, false);
  assert.deepEqual(seen[0], ['https://cdn.discordapp.com/emojis/123456789012345678.png', 'error', 'object']);
  const big = async () => new Response(Buffer.alloc(300 * 1024, 1), { status: 200 });
  await assert.rejects(emoji.downloadEmojiImage('https://cdn.discordapp.com/emojis/1.png', { fetchImpl: big }), /trop lourde/);
  const html = async () => new Response('<html>', { status: 200 });
  await assert.rejects(emoji.downloadEmojiImage('https://cdn.discordapp.com/emojis/1.png', { fetchImpl: html }), /PNG, JPEG/);
  const notFound = async () => new Response('', { status: 404 });
  await assert.rejects(emoji.downloadEmojiImage('https://cdn.discordapp.com/emojis/1.png', { fetchImpl: notFound }), /introuvable/);
  const timeout = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
  await assert.rejects(emoji.downloadEmojiImage('https://cdn.discordapp.com/emojis/1.png', { fetchImpl: timeout }), /10 s/);
  let called = false;
  await assert.rejects(emoji.downloadEmojiImage('https://example.com/a.png', { fetchImpl: async () => { called = true; } }), /Hôte refusé/);
  assert.equal(called, false);
  assert.equal(emoji.imageType(Buffer.from('GIF89a......')).animated, true);
  assert.equal(emoji.imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
});

// ---------------------------------------------------------------- /role modifier, /channel

test('/role modifier : couleur hexadécimale ou « aucune » ; sous-commande déclarée', () => {
  assert.equal(role.parseRoleColor('#5865F2'), 0x5865f2);
  assert.equal(role.parseRoleColor('ff8800'), 0xff8800);
  assert.equal(role.parseRoleColor('aucune'), 0);
  assert.throws(() => role.parseRoleColor('rouge'), /Couleur invalide/);
  const sub = role.data.toJSON().options.find((o) => o.name === 'modifier');
  assert.deepEqual(sub.options.map((o) => o.name), ['role', 'nom', 'couleur', 'affiche_separement', 'mentionnable']);
});

test('/channel : info + sous-commandes de gestion ; noms nettoyés', () => {
  const subs = channel.data.toJSON().options.map((o) => o.name);
  assert.deepEqual(subs, ['info', 'creer', 'supprimer', 'cloner', 'renommer', 'sujet', 'nsfw']);
  assert.equal(channel.cleanChannelName('  mon   salon '), 'mon salon');
  assert.throws(() => channel.cleanChannelName('   '), /vide/);
  assert.throws(() => channel.cleanChannelName('x'.repeat(101)), /trop long/);
  assert.equal(channel.CREATE_TYPES.categorie, ChannelType.GuildCategory);
  const emojiSubs = emoji.data.toJSON().options.map((o) => o.name);
  assert.deepEqual(emojiSubs, ['info', 'ajouter', 'supprimer', 'renommer']);
});
