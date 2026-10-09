'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Collection, ChannelType, PermissionsBitField, ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { ReportRepository } = require('../src/database/repositories/ReportRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const { ReportService, excerpt, normalizeReportReason, MAX_REPORT_REASON } = require('../src/services/ReportService');
const { CommandHandler, isContextMenu, commandLabel, contextMenuWhere } = require('../src/core/CommandHandler');
const { CooldownManager } = require('../src/core/cooldowns');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');
const help = require('../src/commands/information/help');

const GID = '100000000000000001';
const STAFF = '200000000000000001';
const LOGS = '200000000000000002';
const GENERAL = '200000000000000003';
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const ids = (payload) => payload.components.flatMap((r) => json(r).components.map((c) => c.custom_id)).filter(Boolean);

function world({ sendFails = false } = {}) {
  const { db } = memoryDb();
  const reports = new ReportRepository(db);
  const config = new ConfigService(new GuildConfigRepository(db));
  const sent = [];
  const logs = [];
  const channel = (id) => ({
    id,
    type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    send: async (p) => {
      if (sendFails) throw Object.assign(new Error('Missing Access'), { code: 50001 });
      sent.push({ channel: id, payload: p });
      return { id: `9${sent.length}0000000000000000`, channelId: id };
    },
  });
  const guild = {
    id: GID,
    ownerId: '1',
    channels: { cache: new Collection([[STAFF, channel(STAFF)], [LOGS, channel(LOGS)], [GENERAL, channel(GENERAL)]]) },
    roles: { cache: new Collection([['300000000000000001', { id: '300000000000000001' }]]) },
    members: { me: { id: '999' } },
  };
  const logging = { send: async (...args) => (logs.push(args), true) };
  const service = new ReportService({ reports, config, logging });
  return { db, reports, config, service, guild, sent, logs };
}

const message = (over = {}) => ({
  id: '400000000000000001',
  channelId: GENERAL,
  content: 'Contenu signalé',
  author: { id: '500000000000000001', bot: false },
  attachments: new Collection([['a', { name: 'preuve.png' }]]),
  embeds: [],
  ...over,
});

test('migration 13 : table reports, ajoutée à la fin', () => {
  const last = migrations[migrations.length - 1];
  assert.equal(last.id, 13);
  assert.match(last.up, /CREATE TABLE IF NOT EXISTS reports/);
  assert.match(last.up, /UNIQUE INDEX[^;]+WHERE status = 'open'/);
});

test('ReportRepository : un seul signalement ouvert par (signaleur, message), clôture unique, actions, isolation', () => {
  const { reports } = world();
  const base = { guildId: GID, reporterId: 'R1', targetId: 'T1', channelId: 'C1', messageId: 'M1', content: 'x', attachments: ['a.png'] };
  const id = reports.create(base);
  assert.equal(id, 1);
  assert.equal(reports.create(base), null, 'doublon ouvert accepté');
  const id2 = reports.create({ ...base, reporterId: 'R2' });
  assert.ok(id2 > id, 'un autre signaleur doit pouvoir signaler');
  assert.equal(reports.findOpen(GID, 'R1', 'M1').id, 1);
  assert.deepEqual(reports.get(GID, 1).attachments, ['a.png']);
  assert.equal(reports.get('autre', 1), null, 'fuite entre serveurs');

  assert.equal(reports.close(GID, 1, 'handled', 'MOD'), true);
  assert.equal(reports.close(GID, 1, 'dismissed', 'MOD2'), false, 'double clôture');
  assert.equal(reports.get(GID, 1).handled_by, 'MOD');
  assert.throws(() => reports.close(GID, id2, 'open', 'X'));
  // Clos : un nouveau signalement du même message redevient possible.
  const id3 = reports.create(base);
  assert.ok(id3 > id2);

  const updated = reports.recordAction(GID, id2, { type: 'warn', by: 'MOD' });
  assert.deepEqual(updated.actions.map((a) => a.type), ['warn']);
  assert.ok(updated.actions[0].at > 0);
  assert.deepEqual(reports.counts(GID), { open: 2, handled: 1, dismissed: 0, total: 3 });
  assert.deepEqual(reports.list(GID, 'open').map((r) => r.id), [id3, id2]);
  assert.equal(reports.delete(GID, id3), true);
});

test('excerpt et raison : troncature, pièces jointes, intégrations, limite de 500', () => {
  const e = excerpt(message({ content: 'a'.repeat(5000) }));
  assert.ok(e.content.length <= 1500);
  assert.deepEqual(e.attachments, ['preuve.png']);
  assert.match(excerpt(message({ content: '', embeds: [{}], attachments: new Collection() })).content, /1 intégration/);
  assert.equal(excerpt(message({ content: '  ', attachments: new Collection() })).content, null);
  assert.equal(normalizeReportReason('   '), null);
  assert.equal(normalizeReportReason(' spam '), 'spam');
  assert.throws(() => normalizeReportReason('x'.repeat(MAX_REPORT_REASON + 1)), /trop longue/);
});

test('destination : salon dédié, repli sur les logs Modération, désactivation, non configuré', () => {
  const { service, config, guild } = world();
  assert.equal(service.destination(guild).status, 'unset');
  assert.throws(() => service.assertAvailable(guild), /pas encore configurés/);
  config.update(GID, { logChannels: { moderation: LOGS } });
  assert.deepEqual([service.destination(guild).channelId, service.destination(guild).fallback], [LOGS, true]);
  config.update(GID, { reports: { channelId: STAFF } });
  assert.deepEqual([service.destination(guild).channelId, service.destination(guild).fallback], [STAFF, false]);
  config.update(GID, { reports: { channelId: '200000000000000099' } });
  assert.equal(service.destination(guild).status, 'missing');
  config.update(GID, { reports: { channelId: STAFF, enabled: false } });
  assert.throws(() => service.assertAvailable(guild), /désactivés/);
});

test('anti-abus : bot, webhook, système, soi-même, déjà signalé', () => {
  const { service, reports } = world();
  assert.throws(() => service.assertReportable(GID, 'R1', message({ author: { id: 'B', bot: true } })), /bot/);
  assert.throws(() => service.assertReportable(GID, 'R1', message({ webhookId: 'W' })), /webhook/);
  assert.throws(() => service.assertReportable(GID, 'R1', message({ system: true })), /système/);
  assert.throws(() => service.assertReportable(GID, '500000000000000001', message()), /propre message/);
  reports.create({ guildId: GID, reporterId: 'R1', targetId: 'T', channelId: GENERAL, messageId: '400000000000000001' });
  assert.throws(() => service.assertReportable(GID, 'R1', message()), /déjà signalé/);
  assert.doesNotThrow(() => service.assertReportable(GID, 'R2', message()));
});

test('submit : carte (mention de rôle explicite, anonymat), log, échec de publication', async () => {
  const w = world();
  w.config.update(GID, { logChannels: { moderation: LOGS }, reports: { channelId: STAFF, pingRoleId: '300000000000000001' } });
  const r = await w.service.submit(w.guild, { reporter: { id: 'R1' }, message: message(), reason: 'Insulte' });
  assert.equal(r.card_channel_id, STAFF);
  const { payload } = w.sent[0];
  assert.equal(payload.content, '<@&300000000000000001>');
  assert.deepEqual(payload.allowedMentions, { parse: [], roles: ['300000000000000001'] });
  assert.equal(w.logs.length, 1);
  assert.equal(w.logs[0][1], 'moderation');
  assert.equal(w.logs[0][4].event, 'report');
  assert.equal(EVENT_CATEGORY.report, 'moderation');

  // Rôle @everyone ou inconnu : jamais de mention.
  w.config.update(GID, { reports: { pingRoleId: GID, showReporter: false } });
  await w.service.submit(w.guild, { reporter: { id: 'R2' }, message: message(), reason: null });
  assert.equal(w.sent[1].payload.content, undefined);
  assert.deepEqual(w.sent[1].payload.allowedMentions, { parse: [] });
  const fields = JSON.stringify(w.sent[1].payload.embeds);
  assert.match(fields, /Anonyme/);
  assert.doesNotMatch(fields, /R2/);
  assert.doesNotMatch(JSON.stringify(json(w.logs[1][2])), /<@R2>/, 'signaleur révélé dans le log malgré l\'anonymat');

  // Carte publiée DANS le salon de logs Modération : pas de log en double.
  w.config.update(GID, { reports: { channelId: null } });
  await w.service.submit(w.guild, { reporter: { id: 'R3' }, message: message(), reason: null });
  assert.equal(w.logs.length, 2);

  const broken = world({ sendFails: true });
  broken.config.update(GID, { reports: { channelId: STAFF } });
  await assert.rejects(broken.service.submit(broken.guild, { reporter: { id: 'R1' }, message: message(), reason: null }), /pas pu transmettre/);
  assert.equal(broken.reports.counts(GID).total, 0, 'signalement orphelin conservé');
});

test('carte : boutons selon le statut et les actions, limites Discord', async () => {
  const w = world();
  w.config.update(GID, { reports: { channelId: STAFF } });
  const r = await w.service.submit(w.guild, { reporter: { id: 'R1' }, message: message({ content: 'z'.repeat(5000), attachments: new Collection(Array.from({ length: 10 }, (_, i) => [String(i), { name: `${'f'.repeat(90)}${i}.png` }])) }), reason: 'r'.repeat(500) });
  const open = w.service.cardPayload(w.guild, r);
  assert.deepEqual(ids(open).filter((i) => i.startsWith('cmd:signalements')), ['cmd:signalements:del:1', 'cmd:signalements:warn:1', 'cmd:signalements:mute:1', 'cmd:signalements:resolve:1:handled', 'cmd:signalements:resolve:1:dismissed']);
  assert.ok(ids(open).includes('cmd:sanctions:history:500000000000000001'));
  assert.ok(open.components.length <= 5);
  assert.ok(ids(open).every((i) => i.length <= 100));
  const fitted = w.service.cardPayload(w.guild, r, { fit: true }).embeds[0];
  const size = JSON.stringify([fitted.title, fitted.description, fitted.footer, fitted.author, fitted.fields]).length;
  assert.ok(size < 6500, `carte trop longue (${size})`);

  // Action : signalement traité, bouton de l'action retiré ; double action refusée.
  let calls = 0;
  const updated = await w.service.act(w.guild, w.reports.get(GID, 1), { type: 'warn', moderator: { id: 'MOD' }, run: async () => (calls += 1, 'Sanction #1') });
  assert.equal(updated.status, 'handled');
  assert.equal(updated.actions[0].note, 'Sanction #1');
  assert.ok(!ids(w.service.cardPayload(w.guild, updated)).includes('cmd:signalements:warn:1'));
  assert.ok(!ids(w.service.cardPayload(w.guild, updated)).some((i) => i.includes(':resolve:')));
  await assert.rejects(w.service.act(w.guild, updated, { type: 'warn', moderator: { id: 'MOD' }, run: async () => {} }), /Déjà fait/);

  // Double clic simultané : une seule exécution.
  const fresh = w.reports.get(GID, 1);
  let slow = 0;
  const run = () => new Promise((resolve) => setTimeout(() => resolve((slow += 1, null)), 10));
  const results = await Promise.allSettled([
    w.service.act(w.guild, fresh, { type: 'timeout', moderator: { id: 'MOD' }, run }),
    w.service.act(w.guild, fresh, { type: 'timeout', moderator: { id: 'MOD' }, run }),
  ]);
  assert.equal(slow, 1);
  assert.equal(results.filter((x) => x.status === 'rejected').length, 1);

  // Échec de l'action : rien n'est enregistré.
  await assert.rejects(w.service.act(w.guild, w.reports.get(GID, 1), { type: 'delete', moderator: { id: 'MOD' }, run: async () => { throw new Error('boom'); } }), /boom/);
  assert.ok(!w.reports.get(GID, 1).actions.some((a) => a.type === 'delete'));

  // Rejet : plus aucun bouton d'action.
  const r2 = await w.service.submit(w.guild, { reporter: { id: 'R2' }, message: message({ id: '400000000000000002' }), reason: null });
  const dismissed = await w.service.resolve(w.guild, r2, 'dismissed', { id: 'MOD' });
  assert.deepEqual(ids(w.service.cardPayload(w.guild, dismissed)).filter((i) => i.startsWith('cmd:signalements')), []);
  await assert.rejects(w.service.resolve(w.guild, dismissed, 'handled', { id: 'MOD' }), /déjà été traité/);
  await assert.rejects(w.service.act(w.guild, dismissed, { type: 'warn', moderator: { id: 'MOD' }, run: async () => {} }), /rejeté/);
});

test('CooldownManager.remaining : lecture sans consommation', () => {
  const c = new CooldownManager();
  assert.equal(c.remaining('k', 1000), 0);
  c.hit('k', 30_000, 1000);
  assert.equal(c.remaining('k', 11_000), 20_000);
  assert.equal(c.hit('k', 30_000, 11_000), 20_000, 'remaining ne doit pas prolonger le délai');
  assert.equal(c.remaining('k', 40_000), 0);
});

test('menus contextuels : détection, libellé, /help sans plantage (fiche, catégorie, autocomplétion)', async () => {
  const handler = new CommandHandler();
  const commands = handler.loadAll(path.join(__dirname, '..', 'src', 'commands'));
  const menus = [...commands.values()].filter(isContextMenu);
  assert.deepEqual(menus.map((c) => c.data.name).sort(), ['Infos du membre', 'Note de modération', 'Sanctions du membre', 'Signaler le message']);
  assert.equal(commandLabel(commands.get('ban')), '/ban');
  assert.equal(commandLabel(commands.get('Signaler le message')), '« Signaler le message »');
  assert.match(contextMenuWhere(commands.get('Signaler le message')), /message/);
  assert.match(contextMenuWhere(commands.get('Infos du membre')), /membre/);
  // Un menu contextuel minimal (sans description exportée) ne fait pas planter l'aide.
  const bare = { data: new ContextMenuCommandBuilder().setName('Test nu').setType(ApplicationCommandType.User), category: 'moderation', execute() {} };
  for (const cmd of [...menus, bare]) {
    const embed = json(help.commandDetailEmbed(cmd));
    assert.ok(embed.title.includes(cmd.data.name));
    assert.ok(embed.fields.some((f) => /Utilisation/.test(f.name)));
    assert.doesNotMatch(JSON.stringify(embed), /undefined/);
  }
  assert.equal(help.findCommand(commands, 'signaler LE message').data.name, 'Signaler le message');
  assert.equal(help.findCommand(commands, '/BAN').data.name, 'ban');
  const grouped = help.groupByCategory(commands);
  assert.doesNotMatch(JSON.stringify(json(help.categoryEmbed('moderation', grouped.get('moderation')))), /undefined/);
  const responded = [];
  await help.autocomplete({ options: { getFocused: () => 'sanction' }, respond: async (c) => responded.push(...c) }, { commands: new Collection([...commands.entries(), ['Test nu', bare]]) });
  assert.ok(responded.some((c) => c.value === 'Sanctions du membre'));
  assert.ok(responded.every((c) => c.name.length <= 100 && !c.name.includes('undefined')));
});
