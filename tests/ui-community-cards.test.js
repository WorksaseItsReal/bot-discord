'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { TONES } = require('../src/utils/ui');
const { TicketRepository } = require('../src/database/repositories/TicketRepository');
const { GiveawayRepository } = require('../src/database/repositories/GiveawayRepository');
const { SuggestionRepository } = require('../src/database/repositories/SuggestionRepository');
const { TicketService } = require('../src/services/TicketService');
const { GiveawayService } = require('../src/services/GiveawayService');
const { SuggestionService, voteSummary } = require('../src/services/SuggestionService');
const { ModmailService } = require('../src/services/ModmailService');
const role = require('../src/commands/roles/role');
const voice = require('../src/commands/voice/voice');
const tempvoice = require('../src/commands/voice/tempvoice');
const giveaway = require('../src/commands/giveaways/giveaway');
const modmail = require('../src/commands/tickets/modmail');
const { progressCard } = require('../src/commands/roles/massrole');
const { panelCard } = require('../src/commands/roles/rolemenu');

const SNOWFLAKE = '123456789012345678';
const json = (payload) => ({
  embeds: payload.embeds.map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e)),
  components: (payload.components ?? []).map((r) => (typeof r.toJSON === 'function' ? r.toJSON() : r)),
});
const ids = (rows) => rows.flatMap((r) => r.components.map((c) => c.custom_id));

/** Limites Discord sur les composants d'un message. */
function assertComponentLimits(rows) {
  assert.ok(rows.length <= 5, '≤ 5 rangées');
  for (const r of rows) {
    assert.ok(r.components.length <= 5, '≤ 5 boutons par rangée');
    for (const c of r.components) if (c.custom_id) assert.ok(c.custom_id.length <= 100, `customId trop long : ${c.custom_id}`);
  }
}

test('ticket : panneau accueillant avec bouton Primary rétrocompatible', () => {
  const service = new TicketService({ tickets: null, config: { get: () => ({ tickets: { maxPerUser: 2 } }) }, logging: null });
  const { embeds, components } = json(service.panel({ id: 'g', iconURL: () => null }));
  assert.equal(embeds[0].color, TONES.brand);
  assert.ok(embeds[0].title.includes('🎫'));
  assert.ok(embeds[0].fields.some((f) => f.name.includes('Délai')));
  assert.deepEqual(ids(components), ['ticket:create']);
  assert.equal(components[0].components[0].style, 1, 'Primary');
  assert.ok(components[0].components[0].label.includes('Ouvrir un ticket'));
});

test('ticket : carte d\'accueil (Auteur/Ouvert/Statut) et boutons prise en charge / fermer / transcript', () => {
  const service = new TicketService({ tickets: null, config: null, logging: null });
  const open = json(service.welcome({ id: 7, user_id: 'u', status: 'open', created_at: Date.now() }));
  const names = open.embeds[0].fields.map((f) => f.name);
  assert.ok(names.some((n) => n.includes('Auteur')) && names.some((n) => n.includes('Ouvert')) && names.some((n) => n.includes('Statut')));
  assert.deepEqual(ids(open.components), ['ticket:claim', 'ticket:close', 'ticket:transcript']);
  assert.equal(open.components[0].components[0].disabled, undefined);
  const claimed = json(service.welcome({ id: 7, user_id: 'u', status: 'claimed', claimed_by: 's', created_at: Date.now() }));
  assert.equal(claimed.components[0].components[0].disabled, true);
  assert.ok(claimed.embeds[0].fields.find((f) => f.name.includes('Statut')).value.includes('<@s>'));
});

test('ticket : transcript réservé à l\'auteur et au support', () => {
  const service = new TicketService({ tickets: null, config: { get: () => ({ tickets: {} }) }, logging: null });
  const member = (id) => ({ id, guild: { id: 'g' }, permissions: { has: () => false }, roles: { cache: new Collection() } });
  assert.doesNotThrow(() => service.assertParticipant(member('author'), { user_id: 'author' }));
  assert.throws(() => service.assertParticipant(member('other'), { user_id: 'author' }), /auteur du ticket/);
});

test('ticket : création → mention + carte d\'accueil dans le salon', async () => {
  const { db } = memoryDb();
  const repo = new TicketRepository(db);
  const sent = [];
  const service = new TicketService({ tickets: repo, config: { get: () => ({ tickets: {} }) }, logging: { send: async () => {} } });
  const guild = {
    id: 'g',
    roles: { everyone: { id: 'g' }, cache: new Collection() },
    members: { me: { id: 'bot' } },
    channels: { cache: new Collection(), create: async () => ({ id: 'chan', send: async (p) => sent.push(p), toString: () => '<#chan>' }) },
  };
  await service.create(guild, { id: 'u', username: 'u', tag: 'u', toString: () => '<@u>' });
  assert.equal(sent[0].content, '<@u>');
  const { embeds, components } = json(sent[0]);
  assert.ok(embeds[0].title.includes('Ticket #'));
  assert.ok(ids(components).includes('ticket:transcript'));
});

function giveawaySetup() {
  const { db } = memoryDb();
  const repo = new GiveawayRepository(db);
  const sent = [];
  const edits = [];
  const message = { id: 'm1', edit: async (p) => edits.push(p) };
  const channel = {
    guild: { id: 'g1' },
    id: 'c1',
    isTextBased: () => true,
    send: async (p) => { sent.push(p); return message; },
    messages: { fetch: async () => message },
  };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async (id) => ({ id, bot: false }) } };
  return { repo, service: new GiveawayService({ client, giveaways: repo }), sent, edits, channel };
}

test('giveaway : carte festive, champs clés et bouton Participer avec compteur', async () => {
  const { repo, service, sent, channel } = giveawaySetup();
  const { id } = await service.create(channel, { id: 'host' }, { prize: 'Nitro', winners: 2, durationMs: 60_000, requiredRole: 'r1' });
  const { embeds, components } = json(sent[0]);
  assert.equal(embeds[0].color, TONES.celebrate);
  assert.ok(embeds[0].title.includes('Nitro'));
  const names = embeds[0].fields.map((f) => f.name).join('|');
  for (const label of ['Gagnants', 'Fin', 'Organisateur', 'Participants', 'Conditions']) assert.ok(names.includes(label), label);
  assert.ok(embeds[0].fields.find((f) => f.name.includes('Fin')).value.includes(':R>'));
  assert.deepEqual(ids(components), [`giveaway:enter:${id}`]);
  repo.toggleEntry(id, 'u1');
  const after = json(service.render(repo.get(id)));
  assert.ok(after.components[0].components[0].label.includes('1'));
});

test('giveaway : fin → annonce avec mentions, carte terminée et bouton Relancer', async () => {
  const { repo, service, sent, edits, channel } = giveawaySetup();
  const { id } = await service.create(channel, { id: 'host' }, { prize: 'Nitro', winners: 1, durationMs: 60_000 });
  repo.toggleEntry(id, 'u1');
  await service.end(id, { guildId: 'g1' });
  const announce = sent[1];
  assert.equal(announce.content, '<@u1>');
  assert.equal(json(announce).embeds[0].color, TONES.celebrate);
  const ended = json(edits.at(-1));
  assert.ok(ended.embeds[0].fields.some((f) => f.value.includes('<@u1>')));
  assert.deepEqual(ids(ended.components), [`cmd:giveaway:reroll:${id}`]);
});

test('giveaway : le bouton Relancer revérifie « Gérer les événements »', async () => {
  const interaction = { memberPermissions: { has: () => false } };
  await assert.rejects(giveaway.buttons.reroll(interaction, {}, ['1']), /Gérer les événements/);
});

test('suggestion : barre de votes, statut et tons de décision', () => {
  assert.match(voteSummary({ up: 3, down: 1 }), /75 % pour/);
  assert.match(voteSummary({ up: 0, down: 0 }), /Aucun vote/);
  const service = new SuggestionService({ client: {}, suggestions: null, config: null });
  const base = { id: 4, author_id: 'a', content: 'Idée', created_at: Date.now() };
  const pending = json(service.render({ ...base, status: 'pending' }, { up: 2, down: 1 }, { avatar: 'https://cdn.discordapp.com/a.png' }));
  assert.equal(pending.embeds[0].color, TONES.info);
  assert.equal(pending.embeds[0].thumbnail.url, 'https://cdn.discordapp.com/a.png');
  assert.deepEqual(ids(pending.components), ['suggestion:up:4', 'suggestion:down:4']);
  const approved = json(service.render({ ...base, status: 'approved' }, { up: 2, down: 1 }, { decision: { by: '<@s>', reason: 'Bonne idée' } }));
  assert.equal(approved.embeds[0].color, TONES.success);
  assert.ok(approved.embeds[0].fields.some((f) => f.value.includes('Bonne idée')));
  assert.equal(approved.components[0].components[0].disabled, true);
  const denied = json(service.render({ ...base, status: 'denied' }, { up: 0, down: 3 }));
  assert.equal(denied.embeds[0].color, TONES.danger);
});

test('suggestion : création publie la carte avec la miniature de l\'auteur', async () => {
  const { db } = memoryDb();
  const repo = new SuggestionRepository(db);
  const sent = [];
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); return { id: 'm' }; } };
  const service = new SuggestionService({ client: {}, suggestions: repo, config: { get: () => ({ suggestions: { channelId: 'c' } }) } });
  const guild = { id: 'g', channels: { fetch: async () => channel } };
  await service.create(guild, { id: 'a', displayAvatarURL: () => 'https://cdn.discordapp.com/x.png' }, 'Une idée');
  assert.equal(json(sent[0]).embeds[0].thumbnail.url, 'https://cdn.discordapp.com/x.png');
});

test('rôles : les boutons inverses revérifient Gérer les rôles', async () => {
  const interaction = { memberPermissions: { has: () => false } };
  await assert.rejects(role.buttons.take(interaction, {}, [SNOWFLAKE, SNOWFLAKE, SNOWFLAKE]), /Gérer les rôles/);
  await assert.rejects(role.buttons.give(interaction, {}, [SNOWFLAKE, SNOWFLAKE, SNOWFLAKE]), /Gérer les rôles/);
  await assert.rejects(role.buttons.uncreate(interaction, {}, [SNOWFLAKE, SNOWFLAKE]), /Gérer les rôles/);
});

test('rôles : les boutons revérifient la hiérarchie', async () => {
  const highRole = { id: 'r', position: 10, managed: false };
  const interaction = {
    memberPermissions: { has: () => true },
    user: { id: 'mod' },
    member: { roles: { highest: { position: 5 } } },
    guild: { id: 'g', ownerId: 'owner', roles: { cache: new Collection([['r', highRole]]) }, members: { me: { roles: { highest: { position: 50 } } } } },
  };
  await assert.rejects(role.buttons.take(interaction, {}, ['m', 'r', 'mod']), /au-dessus/);
});

test('vocal et vocaux temporaires : permissions revérifiées dans les boutons', async () => {
  const interaction = { memberPermissions: { has: () => false } };
  await assert.rejects(voice.buttons.mute(interaction, {}, [SNOWFLAKE, SNOWFLAKE]), /Couper le micro/);
  await assert.rejects(voice.buttons.unmute(interaction, {}, [SNOWFLAKE, SNOWFLAKE]), /Couper le micro/);
  await assert.rejects(voice.buttons.moveback(interaction, {}, [SNOWFLAKE, SNOWFLAKE, SNOWFLAKE]), /Déplacer des membres/);
  await assert.rejects(tempvoice.buttons.toggle(interaction, {}), /Gérer les salons/);
  await assert.rejects(tempvoice.buttons.refresh(interaction, {}), /Gérer les salons/);
});

test('modmail : boutons réservés au staff, carte d\'ouverture avec Répondre / Fermer', async () => {
  const config = { get: () => ({ modmail: { staffRoleId: 'staff' } }) };
  const service = new ModmailService({ client: {}, modmail: { getByChannel: () => ({ status: 'open' }) }, config });
  const client = { services: { modmail: service } };
  const outsider = { member: { guild: { id: 'g' }, permissions: { has: () => false }, roles: { cache: new Collection() } }, channelId: 'c' };
  await assert.rejects(modmail.buttons.close(outsider, client), /staff ModMail/);
  await assert.rejects(modmail.buttons.reply(outsider, client), /staff ModMail/);
  const rows = service.controls().map((r) => r.toJSON());
  assert.deepEqual(ids(rows), ['cmd:modmail:reply', 'cmd:modmail:close']);
});

test('tempvoice : panneau d\'état avec Actualiser et Activer/Désactiver', () => {
  const cfg = { enabled: true, hubChannelId: 'hub', categoryId: null };
  const client = { services: { config: { get: () => ({ tempVoice: cfg }) }, tempVoice: { listByGuild: () => [{ channel_id: 'v', owner_id: 'o' }] } } };
  const guild = { id: 'g', channels: { cache: new Collection([['hub', {}]]) } };
  const { embeds, components } = json(tempvoice.statusPanel(client, guild));
  assert.equal(embeds[0].color, TONES.info);
  assert.ok(embeds[0].fields.some((f) => f.name.includes('Vocaux actifs') && f.value.includes('1')));
  assert.deepEqual(ids(components), ['cmd:tempvoice:refresh', 'cmd:tempvoice:toggle']);
});

test('massrole et rolemenu : cartes de progression et panneau', () => {
  const base = { action: 'add', role: '<@&r>', target: 'humans', total: 10, done: 4, failed: 1, startedAt: Date.now() - 5000 };
  const running = progressCard({ ...base, finished: false }).toJSON();
  assert.equal(running.color, TONES.info);
  assert.match(running.description, /50 %/);
  assert.equal(progressCard({ ...base, done: 9, finished: true }).toJSON().color, TONES.warning);
  assert.equal(progressCard({ ...base, done: 10, failed: 0, finished: true }).toJSON().color, TONES.success);
  const panel = panelCard({ title: 'Notifications', roles: [{ roleId: '1', label: 'A', description: 'Annonces' }, { roleId: '2', label: 'B' }] }).toJSON();
  assert.ok(panel.description.includes('<@&1>') && panel.description.includes('Annonces'));
});

test('customIds des nouveaux boutons sous la limite Discord avec de vrais snowflakes', () => {
  const service = new GiveawayService({ client: {}, giveaways: { countEntries: () => 3 } });
  const g = { id: 99999, prize: 'x', winners: 1, host_id: SNOWFLAKE, guild_id: SNOWFLAKE, channel_id: SNOWFLAKE, message_id: SNOWFLAKE, ends_at: Date.now() };
  assertComponentLimits(json(service.render(g)).components);
  assertComponentLimits(json(service.renderEnded(g, [SNOWFLAKE])).components);
  const { actionButton } = require('../src/utils/ui');
  assert.ok(actionButton({ command: 'voice', action: 'moveback', args: [SNOWFLAKE, SNOWFLAKE, SNOWFLAKE], label: 'x' }).toJSON().custom_id.length <= 100);
  assert.ok(actionButton({ command: 'role', action: 'take', args: [SNOWFLAKE, SNOWFLAKE, SNOWFLAKE], label: 'x' }).toJSON().custom_id.length <= 100);
});
