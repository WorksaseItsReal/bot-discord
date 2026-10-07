'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, Collection, ChannelType } = require('discord.js');
const tickets = require('../src/commands/tickets/tickets');
const ticket = require('../src/commands/tickets/ticket');
const ticketComponent = require('../src/components/ticket');
const { TicketService, supportRoles, reasonFromTopic, MAX_REASONS } = require('../src/services/TicketService');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { memoryDb } = require('./db.helper');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');

const GID = '100000000000000001';
const CAT = '200000000000000001';
const TEXT = '200000000000000002';
const PANEL = '200000000000000003';
const STAFF = '300000000000000001';
const STAFF2 = '300000000000000002';
const sf = (base, i) => String(BigInt(base) + BigInt(i));

function world() {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new TicketRepository(db);
  const panelMessages = new Map();
  let seq = 900000000000000000n;
  const makeText = (id) => ({
    id,
    type: ChannelType.GuildText,
    sent: [],
    toString: () => `<#${id}>`,
    async send(p) {
      const msg = { id: String(seq++), payload: p, async edit(np) { msg.payload = np; return msg; } };
      this.sent.push(p);
      panelMessages.set(msg.id, msg);
      return msg;
    },
    messages: { fetch: async (mid) => panelMessages.get(mid) ?? Promise.reject(new Error('Unknown Message')) },
  });
  const channels = new Collection([
    [CAT, { id: CAT, type: ChannelType.GuildCategory }],
    [TEXT, makeText(TEXT)],
    [PANEL, makeText(PANEL)],
  ]);
  const created = [];
  const guild = {
    id: GID,
    name: 'Test',
    iconURL: () => null,
    roles: { everyone: { id: GID }, cache: new Collection([[STAFF, { id: STAFF }], [STAFF2, { id: STAFF2 }], ['300000000000000009', { id: '300000000000000009', name: 'Bot', managed: true }]]) },
    members: { me: { id: '999999999999999999' } },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) ?? null,
      create: async (opts) => {
        const ch = { id: String(seq++), ...opts, sent: [], send: async (p) => ch.sent.push(p), toString: () => `<#${ch.id}>`, url: 'https://discord.com/channels/x/y' };
        created.push(ch);
        return ch;
      },
    },
  };
  const service = new TicketService({ tickets: repo, config, logging: { send: async () => {} } });
  const client = { services: { config, tickets: service }, repositories: { tickets: repo } };
  return { client, guild, config, repo, created, panelMessages };
}

function fake(guild, { perms = PermissionsBitField.All, values, fields, extra } = {}) {
  const calls = { update: [], reply: [], modal: [], editReply: [] };
  return {
    calls,
    guildId: guild.id,
    guild,
    user: { id: '5', username: 'alice', tag: 'alice', toString: () => '<@5>' },
    memberPermissions: new PermissionsBitField(perms),
    values,
    fields: fields ? { getTextInputValue: (id) => fields[id] ?? '' } : undefined,
    async update(p) { calls.update.push(p); },
    async reply(p) { calls.reply.push(p); },
    async showModal(m) { calls.modal.push(m); },
    async deferUpdate() { this.deferred = true; },
    async deferReply() { this.deferred = true; },
    async editReply(p) { calls.editReply.push(p); },
    ...extra,
  };
}

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
const ids = (rows) => rows.map(json).flatMap((r) => r.components.map((c) => c.custom_id).filter(Boolean));

function assertValid(payload, label) {
  const rows = payload.components.map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const seen = [];
  for (const r of rows) {
    assert.ok(r.components.length <= 5, `${label} : rangée trop longue`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      seen.push(c.custom_id);
      assert.ok(c.custom_id.length <= 100);
      const [, cmd, action] = c.custom_id.split(':');
      if (cmd === 'tickets') assert.equal(typeof tickets.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length <= 25);
      if (c.default_values) assert.ok(c.default_values.length <= 25);
    }
  }
  assert.equal(new Set(seen).size, seen.length, `${label} : identifiants en double`);
  assert.ok(payload.embeds.length <= 10);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256));
  }
}

const VIEWS = ['home', 'setup', 'panel', 'reasons', 'open', 'inconnue'];

test('/tickets : commande unique réservée à « Gérer le serveur »', () => {
  const data = tickets.data.toJSON();
  assert.equal((data.options ?? []).length, 0);
  assert.equal(data.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('motifs : saisie validée, valeurs stables et uniques, aller-retour', () => {
  const r = tickets.parseReasons('🛠️ Support technique | Un bug, un souci\n\n🚨 Signalement\nQuestion générale | Autre\nSupport technique');
  assert.deepEqual(r.map((x) => x.value), ['support-technique', 'signalement', 'question-generale', 'support-technique-2']);
  assert.equal(r[0].emoji, '🛠️');
  assert.equal(r[0].description, 'Un bug, un souci');
  assert.equal(r[2].emoji, null);
  assert.deepEqual(tickets.parseReasons(tickets.reasonsToText(r)).map((x) => x.label), r.map((x) => x.label));
  assert.equal(tickets.parseReasons('<:pepe:123456789012345678> Partenariat')[0].emoji, '<:pepe:123456789012345678>');
  assert.deepEqual(tickets.parseReasons(''), []);
  for (const bad of ['🛠️', 'x'.repeat(51), `A | ${'d'.repeat(101)}`, Array.from({ length: MAX_REASONS + 1 }, (_, i) => `M${i}`).join('\n')]) {
    assert.throws(() => tickets.parseReasons(bad), { name: 'UserError' }, bad.slice(0, 20));
  }
});

test('chaque vue respecte les limites Discord et route vers un gestionnaire', () => {
  const { client, guild, config, repo } = world();
  for (const v of VIEWS) assertValid(tickets.render(client, guild, v), `${v} (défaut)`);
  config.update(GID, {
    tickets: {
      categoryId: CAT,
      logChannel: TEXT,
      supportRoleIds: Array.from({ length: 12 }, (_, i) => sf(STAFF, i)),
      reasons: tickets.parseReasons(Array.from({ length: MAX_REASONS }, (_, i) => `🎫 Motif numéro ${i} | ${'détail '.repeat(12).trim()}`).join('\n')),
      panel: { title: 'T'.repeat(200), description: 'D'.repeat(2000), buttonLabel: 'B'.repeat(40) },
      panelChannelId: PANEL,
      panelMessageId: '900000000000000999',
      stats: { opened: 120, closed: 90 },
    },
  });
  for (let i = 0; i < 30; i++) repo.create({ guildId: GID, channelId: sf('500000000000000000', i), userId: sf('600000000000000000', i) });
  repo.setStatus(sf('500000000000000000', 3), 'claimed', { claimedBy: '700000000000000001' });
  for (const v of VIEWS) assertValid(tickets.render(client, guild, v, 'Notification de test'), v);
  const home = JSON.stringify(json(tickets.render(client, guild, 'home').embeds[0]));
  assert.match(home, /\*\*30\*\*/, 'tickets ouverts');
  assert.match(home, /\*\*90\*\*/, 'tickets fermés');
  assert.match(JSON.stringify(json(tickets.render(client, guild, 'open').embeds[0])), /et 10 autre/);
  for (const v of VIEWS) assertValid(tickets.render(client, { id: GID }, v), `${v} (serveur minimal)`);
});

test('tous les gestionnaires refusent sans « Gérer le serveur »', async () => {
  const { client, guild } = world();
  const i = fake(guild, { perms: 0n, values: ['home'], fields: {} });
  for (const [name, handler] of Object.entries(tickets.buttons)) {
    await assert.rejects(handler(i, client, ['home']), { name: 'UserError' }, name);
  }
  assert.equal(i.calls.update.length + i.calls.modal.length, 0);
});

test('salons & staff : catégorie, rôles staff, transcripts, limite', async () => {
  const { client, guild, config } = world();
  await tickets.buttons.category(fake(guild, { values: [CAT] }), client);
  await assert.rejects(tickets.buttons.category(fake(guild, { values: [TEXT] }), client), /catégorie/);
  await tickets.buttons.staff(fake(guild, { values: [STAFF, STAFF2] }), client);
  await tickets.buttons.transcripts(fake(guild, { values: [TEXT] }), client);
  await assert.rejects(tickets.buttons.transcripts(fake(guild, { values: [CAT] }), client), /textuel/);
  await tickets.buttons.limit(fake(guild, { values: ['3'] }), client);
  await assert.rejects(tickets.buttons.limit(fake(guild, { values: ['11'] }), client), { name: 'UserError' });
  const t = config.get(GID).tickets;
  assert.equal(t.categoryId, CAT);
  assert.deepEqual(t.supportRoleIds, [STAFF, STAFF2]);
  assert.equal(t.supportRoleId, STAFF, 'premier rôle conservé pour la compatibilité');
  assert.equal(t.logChannel, TEXT);
  assert.equal(t.maxPerUser, 3);
  // Vider les menus retire les réglages.
  await tickets.buttons.staff(fake(guild, { values: [] }), client);
  await tickets.buttons.category(fake(guild, { values: [] }), client);
  assert.deepEqual(supportRoles(config.get(GID).tickets), []);
  assert.equal(config.get(GID).tickets.categoryId, null);
});

test('panneau : salon, message personnalisé, publication puis mise à jour sans doublon', async () => {
  const { client, guild, config, panelMessages } = world();
  await assert.rejects(tickets.buttons.publish(fake(guild), client), /salon du panneau/);
  await tickets.buttons.panelch(fake(guild, { values: [PANEL] }), client);

  const open = fake(guild);
  await tickets.buttons.panelmsg(open, client);
  const modal = json(open.calls.modal[0]);
  assert.equal(modal.custom_id, 'cmd:tickets:panelmsgsubmit');
  for (const row of modal.components) for (const c of row.components) assert.ok(c.label.length <= 45, c.label);
  await tickets.buttons.panelmsgsubmit(fake(guild, { fields: { title: 'Support Gadget', description: '', buttonLabel: 'Écrire au staff' } }), client);
  assert.deepEqual(config.get(GID).tickets.panel, { title: 'Support Gadget', description: null, buttonLabel: 'Écrire au staff' });

  const first = fake(guild);
  await tickets.buttons.publish(first, client);
  assert.ok(first.deferred);
  const messageId = config.get(GID).tickets.panelMessageId;
  assert.ok(messageId);
  const published = json(panelMessages.get(messageId).payload.embeds[0]);
  assert.match(published.title, /Support Gadget/);
  assert.deepEqual(ids(panelMessages.get(messageId).payload.components), ['ticket:create']);
  assert.equal(json(panelMessages.get(messageId).payload.components[0]).components[0].label, 'Écrire au staff');

  // Republier : le message existant est modifié.
  await tickets.buttons.reasonssubmit(fake(guild, { fields: { reasons: '🛠️ Support | Un souci\n🚨 Signalement' } }), client);
  await tickets.buttons.publish(fake(guild), client);
  assert.equal(config.get(GID).tickets.panelMessageId, messageId);
  assert.equal(guild.channels.cache.get(PANEL).sent.length, 1);
  assert.deepEqual(ids(panelMessages.get(messageId).payload.components), ['ticket:open']);

  // Changer de salon : nouveau panneau au prochain envoi.
  await tickets.buttons.panelch(fake(guild, { values: [TEXT] }), client);
  assert.equal(config.get(GID).tickets.panelMessageId, null);
  await tickets.buttons.panelreset(fake(guild), client);
  assert.equal(config.get(GID).tickets.panel.title, null);
  await tickets.buttons.reasonsclear(fake(guild), client);
  assert.deepEqual(config.get(GID).tickets.reasons, []);
  const reasonsModal = fake(guild);
  await tickets.buttons.reasons(reasonsModal, client);
  assert.equal(json(reasonsModal.calls.modal[0]).custom_id, 'cmd:tickets:reasonssubmit');
});

test('service : rôles staff multiples, motif à l\'ouverture, statistiques', async () => {
  const { client, guild, config, repo, created } = world();
  const service = client.services.tickets;
  config.update(GID, { tickets: { supportRoleIds: [STAFF, STAFF2, '300000000000000404'] } });
  const member = (roles, perms = 0n) => ({ id: '8', guild: { id: GID }, permissions: new PermissionsBitField(perms), roles: { cache: new Collection(roles.map((r) => [r, {}])) } });
  assert.equal(service.isStaff(member([STAFF2])), true);
  assert.equal(service.isStaff(member([])), false);
  assert.equal(service.isStaff(member([], PermissionFlagsBits.ManageChannels)), true);

  await service.create(guild, { id: '5', username: 'alice', tag: 'alice', toString: () => '<@5>' }, { reason: 'Signalement' });
  const ch = created[0];
  assert.equal(reasonFromTopic(ch.topic), 'Signalement');
  assert.deepEqual(ch.permissionOverwrites.filter((o) => o.id.startsWith('3000')).map((o) => o.id), [STAFF, STAFF2], 'rôle supprimé ignoré');
  assert.equal(ch.sent[0].content, `<@5> <@&${STAFF}> <@&${STAFF2}>`);
  const welcome = json(ch.sent[0].embeds[0]);
  assert.ok(welcome.fields.some((f) => f.name.includes('Motif') && f.value === 'Signalement'));
  assert.equal(config.get(GID).tickets.stats.opened, 1);

  // Fermeture : transcript archivé et compteur des fermés.
  Object.assign(ch, { guild: { id: GID, channels: { fetch: async () => null } }, name: 'ticket-alice', messages: { fetch: async () => new Collection() }, delete: async () => {} });
  await service.close(ch, { toString: () => '<@8>' });
  assert.equal(config.get(GID).tickets.stats.closed, 1);
  assert.equal(repo.getByChannel(ch.id), undefined);
});

test('panneau du service : menu de motifs quand ils existent, bouton sinon', () => {
  const { client, guild, config } = world();
  assert.deepEqual(ids(client.services.tickets.panel(guild).components), ['ticket:create']);
  config.update(GID, { tickets: { reasons: tickets.parseReasons('🛠️ Support\nAutre') } });
  const menu = json(client.services.tickets.panel(guild).components[0]).components[0];
  assert.equal(menu.custom_id, 'ticket:open');
  assert.deepEqual(menu.options.map((o) => o.value), ['support', 'autre']);
});

test('composant ticket : fermeture avec confirmation, annulation, ouverture par motif', async () => {
  const { client, guild, config, repo, created } = world();
  const comp = (customId, extra = {}) => fake(guild, { extra: { customId, isButton: () => !extra.select, isStringSelectMenu: () => Boolean(extra.select), channelId: extra.channelId, member: { id: '5', guild: { id: GID }, permissions: new PermissionsBitField(0n), roles: { cache: new Collection() } }, ...extra } });
  repo.create({ guildId: GID, channelId: '500000000000000001', userId: '5' });

  const close = comp('ticket:close', { channelId: '500000000000000001' });
  await ticketComponent.execute(close, client);
  const confirm = close.calls.reply[0];
  assert.equal(confirm.ephemeral, true);
  assert.deepEqual(ids(confirm.components), ['ticket:closeconfirm', 'ticket:transcript', 'ticket:closecancel']);
  assert.match(json(confirm.embeds[0]).description, /Aucun salon de transcripts/);
  assert.ok(repo.getByChannel('500000000000000001'), 'rien n\'est fermé avant confirmation');

  const cancel = comp('ticket:closecancel', { channelId: '500000000000000001' });
  await ticketComponent.execute(cancel, client);
  assert.deepEqual(cancel.calls.update[0].components, []);

  // Un membre étranger au ticket ne peut pas demander la fermeture.
  const stranger = comp('ticket:close', { channelId: '500000000000000001', member: { id: '6', guild: { id: GID }, permissions: new PermissionsBitField(0n), roles: { cache: new Collection() } } });
  await assert.rejects(ticketComponent.execute(stranger, client), /auteur du ticket/);

  // Motifs configurés : le bouton historique propose d'abord le menu.
  config.update(GID, { tickets: { maxPerUser: 2, reasons: tickets.parseReasons('🚨 Signalement\nAutre') } });
  const create = comp('ticket:create');
  await ticketComponent.execute(create, client);
  assert.deepEqual(ids(create.calls.reply[0].components), ['ticket:open']);
  const pick = comp('ticket:open', { select: true, values: ['signalement'] });
  await ticketComponent.execute(pick, client);
  assert.equal(reasonFromTopic(created.at(-1).topic), 'Signalement');
  assert.ok(pick.calls.editReply[0].embeds.length);
});

test('/ticket setup et /ticket panel redirigent vers /tickets', async () => {
  const data = ticket.data.toJSON();
  for (const name of ['setup', 'panel']) {
    const sub = data.options.find((o) => o.name === name);
    assert.equal((sub.options ?? []).length, 0);
    let reply;
    await ticket.execute({ options: { getSubcommand: () => name }, reply: async (p) => { reply = p; } }, { services: {} });
    assert.equal(reply.ephemeral, true);
    assert.deepEqual(ids(reply.components), [`cmd:tickets:go:${name}`]);
  }
  for (const name of ['close', 'claim', 'transcript', 'add', 'remove', 'rename']) assert.ok(data.options.some((o) => o.name === name), name);
});

test('/settings : raccourcis vers les tableaux de bord AntiRaid et Tickets', async () => {
  const settings = require('../src/commands/configuration/settings');
  const antiraid = require('../src/commands/security/antiraid');
  const { client, guild } = world();
  const i = fake({ ...guild, members: { me: null } }, { perms: PermissionFlagsBits.ManageGuild });
  await settings.buttons.view(i, client);
  const rows = i.calls.update[0].components;
  assert.ok(rows.length <= 5);
  const all = ids(rows);
  assert.ok(all.includes('cmd:antiraid:go:home') && all.includes('cmd:tickets:go:home'));
  assert.equal(typeof antiraid.buttons.go, 'function');
  assert.equal(typeof tickets.buttons.go, 'function');
});
