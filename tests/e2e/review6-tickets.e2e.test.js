'use strict';

/**
 * Revue n° 6, bout en bout (vrai discord.js, faux Discord) : tickets, ModMail, candidatures.
 * Chaque test échoue sans le correctif correspondant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { rawMember } = require('./lib/fixtures');
const { nextId } = require('./lib/ids');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonIds = (msg) => (msg?.components ?? []).flatMap((r) => r.components ?? []).map((c) => c.custom_id).filter(Boolean);
const embedText = (msg) => (msg?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');
const messagesIn = (h, channelId, mark = 0) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId);

/** Remplace des surcharges de permissions d'un salon (et prévient discord.js). */
function setOverwrites(h, channelId, extra) {
  const ch = h.fake.channels.get(channelId);
  const updated = { ...ch, permission_overwrites: [...(ch.permission_overwrites ?? []).filter((o) => !extra.some((e) => e.id === o.id)), ...extra] };
  h.fake.channels.set(channelId, updated);
  h.fake.dispatchNow('CHANNEL_UPDATE', updated);
}

/** #logs (salon des transcripts) réservé au staff : le rôle du bot n'y a pas été ajouté. */
function privateLogs(h) {
  setOverwrites(h, IDS.channels.logs, [
    { id: IDS.roles.everyone, type: 0, allow: '0', deny: String(P.ViewChannel) },
    { id: IDS.roles.mod, type: 0, allow: String(P.ViewChannel | P.ReadMessageHistory), deny: '0' },
  ]);
}

/** Le rôle du bot reçoit enfin l'accès complet à #logs. */
function fixLogs(h) {
  setOverwrites(h, IDS.channels.logs, [
    { id: IDS.roles.bot, type: 0, allow: String(P.ViewChannel | P.SendMessages | P.EmbedLinks | P.AttachFiles | P.ReadMessageHistory), deny: '0' },
  ]);
}

/** Ouvre un ticket par le panneau ; renvoie le salon et la carte d'accueil. */
async function openTicket(h, as = 'member') {
  const general = h.client.channels.cache.get(IDS.channels.general);
  const panel = await general.send(h.client.services.tickets.panel(h.guild));
  const before = new Set(h.fake.channels.keys());
  const open = await h.click(h.message(panel.id), 'ticket:create', { as });
  assert.ok(!h.isError(open), h.replyText(open));
  const channelId = [...h.fake.channels.keys()].find((k) => !before.has(k));
  const welcome = messagesIn(h, channelId).find((m) => buttonIds(m).includes('ticket:claim'));
  return { channelId, welcome };
}

/** Archives publiées dans #logs depuis `mark`. */
const archivesIn = (h, mark, re) => messagesIn(h, IDS.channels.logs, mark).filter((m) => re.test(m.embeds?.[0]?.title ?? '') && m.attachments?.length);

// ---------------------------------------------------------------- R62

test('R62 ticket : archive impossible (bot sans accès à #transcripts) → salon conservé, fermé, signalé ; refermer après correction archive et supprime', async () => {
  const h = await createHarness({ botAdministrator: false });
  try {
    h.configureAll();
    privateLogs(h);
    await h.settle();
    const { channelId, welcome } = await openTicket(h);
    await h.userMessage({ as: 'member', channel: channelId, content: 'Facture 2026-0042 débitée deux fois.' });
    const row = h.client.repositories.tickets.getByChannel(channelId);
    const dmMark = h.fake.messageLog.length;

    // La confirmation ne promet pas une archive que le bot ne peut pas publier.
    const close = await h.click(welcome, 'ticket:close', { as: 'member' });
    assert.doesNotMatch(h.replyText(close), /sera archivé dans/, h.replyText(close));
    assert.match(h.replyText(close), /conservé/);
    const mark = h.fake.messageLog.length;
    await h.click(h.message(close.original), 'ticket:closeconfirm', { as: 'member' });
    await sleep(5_400);
    await h.settle();

    assert.equal(archivesIn(h, mark, /Ticket #/).length, 0);
    assert.ok(h.fake.channels.has(channelId), 'salon du ticket supprimé alors que l\'archive a échoué');
    const kept = h.client.repositories.tickets.getByChannel(channelId);
    assert.ok(kept, 'ligne du ticket supprimée');
    assert.equal(kept.status, 'closed', 'le ticket doit rester fermé');
    const warning = messagesIn(h, channelId, mark).find((m) => /Archive impossible/.test(m.embeds?.[0]?.title ?? ''));
    assert.ok(warning, 'aucun avertissement dans le salon conservé');
    assert.match(embedText(warning), new RegExp(`<#${IDS.channels.logs}>`));
    assert.ok(buttonIds(warning).includes('ticket:close'), 'pas de bouton pour refermer');
    assert.ok(h.warnLogs().some((l) => /archive/i.test(l)), 'échec non journalisé');
    // Fermé : le membre peut rouvrir un ticket ; la prise en charge est refusée.
    assert.equal(h.client.repositories.tickets.countOpenByUser(h.guild.id, IDS.users.member), 0);
    const claim = await h.click(h.message(welcome.id), 'ticket:claim', { as: 'mod' });
    assert.ok(h.isError(claim), 'prise en charge d\'un ticket fermé acceptée');
    assert.match(h.replyText(claim), /fermé/);
    assert.equal(h.client.repositories.tickets.getByChannel(channelId).status, 'closed');
    const ratingDms = () => messagesIn(h, h.dmChannel('member').id, dmMark).filter((m) => buttonIds(m).some((b) => b.startsWith('cmd:tickets:rate:'))).length;
    assert.equal(ratingDms(), 1);

    // Permissions corrigées : /ticket close archive puis supprime (sans second MP de notation).
    fixLogs(h);
    await h.settle();
    const mark2 = h.fake.messageLog.length;
    const retry = await h.slash('ticket', sub('close'), { as: 'mod', channel: channelId });
    assert.ok(!h.isError(retry), h.replyText(retry));
    await sleep(5_400);
    await h.settle();
    assert.equal(archivesIn(h, mark2, new RegExp(`Ticket #${row.id} fermé`)).length, 1, 'archive non publiée après correction');
    assert.ok(!h.fake.channels.has(channelId), 'salon non supprimé après archive réussie');
    assert.equal(h.client.repositories.tickets.getByChannel(channelId), undefined);
    assert.equal(ratingDms(), 1, 'second MP de notation');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R62 ticket : erreur 500 persistante sur l\'envoi de l\'archive → salon conservé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const { channelId, welcome } = await openTicket(h);
    h.fake.inject({ method: 'POST', route: `/channels/${IDS.channels.logs}/messages` }, { status: 500, code: 0, message: 'Internal Server Error', times: 20 });
    const close = await h.click(welcome, 'ticket:close', { as: 'member' });
    await h.click(h.message(close.original), 'ticket:closeconfirm', { as: 'member' });
    await sleep(5_400);
    await h.settle({ timeout: 8_000 });
    assert.ok(h.fake.channels.has(channelId), 'salon supprimé malgré l\'échec de l\'archive');
    assert.equal(h.client.repositories.tickets.getByChannel(channelId)?.status, 'closed');
  } finally {
    await h.close();
  }
});

test('R62 ticket : salon de transcripts supprimé (annoncé à la confirmation) → fermeture normale', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ tickets: { logChannel: '999999999999999999' } });
    const { channelId, welcome } = await openTicket(h);
    const close = await h.click(welcome, 'ticket:close', { as: 'member' });
    assert.match(h.replyText(close), /n'existe plus/);
    await h.click(h.message(close.original), 'ticket:closeconfirm', { as: 'member' });
    await sleep(5_400);
    await h.settle();
    assert.ok(!h.fake.channels.has(channelId));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R62 ModMail : archive impossible → conversation fermée, salon conservé et signalé ; /modmail close après correction archive et supprime', async () => {
  const h = await createHarness({ botAdministrator: false });
  try {
    h.configureAll();
    privateLogs(h);
    await h.settle();
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Je signale un harcèlement (captures jointes).' });
    const channel = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    assert.ok(channel, 'conversation non créée');
    const thread = h.client.repositories.modmail.getByChannel(channel.id);
    const dmMark = h.fake.messageLog.length;
    const mark = h.fake.messageLog.length;
    const closeRec = await h.slash('modmail', sub('close'), { as: 'mod', channel: channel.id });
    assert.ok(!h.isError(closeRec), h.replyText(closeRec));
    await h.settle();
    assert.equal(archivesIn(h, mark, /ModMail/).length, 0);
    assert.ok(h.fake.channels.has(channel.id), 'salon ModMail supprimé alors que l\'archive a échoué');
    assert.equal(h.client.repositories.modmail.getByChannel(channel.id).status, 'closed');
    const warning = messagesIn(h, channel.id, mark).find((m) => /Archive impossible/.test(m.embeds?.[0]?.title ?? ''));
    assert.ok(warning, 'aucun avertissement dans le salon conservé');
    const closedDms = () => messagesIn(h, h.dmChannel('target').id, dmMark).filter((m) => /Conversation fermée/.test(m.embeds?.[0]?.title ?? '')).length;
    assert.equal(closedDms(), 1);

    fixLogs(h);
    await h.settle();
    const mark2 = h.fake.messageLog.length;
    const retry = await h.slash('modmail', sub('close'), { as: 'mod', channel: channel.id });
    assert.ok(!h.isError(retry), h.replyText(retry));
    await h.settle();
    assert.equal(archivesIn(h, mark2, new RegExp(`ModMail #${thread.id}`)).length, 1, 'archive non publiée après correction');
    assert.ok(!h.fake.channels.has(channel.id), 'salon non supprimé après archive réussie');
    assert.equal(closedDms(), 1, 'second MP de fermeture');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R63

test('R63 ModMail : accès perdu à un salon encore en cache → conversation fermée, nouvelle conversation, MP transmis', async () => {
  const h = await createHarness({ botAdministrator: false });
  try {
    h.configureAll();
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Bonjour, j\'ai un souci' });
    const first = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    const oldThread = h.client.repositories.modmail.getByChannel(first.id);
    // Un admin retire la surcharge du bot (synchronisation avec la catégorie…) : salon toujours en cache.
    const updated = { ...first, permission_overwrites: first.permission_overwrites.filter((o) => o.id !== IDS.users.bot) };
    h.fake.channels.set(first.id, updated);
    h.fake.dispatchNow('CHANNEL_UPDATE', updated);
    await h.settle();
    assert.ok(h.client.channels.cache.has(first.id));

    const dm = h.dmChannel('target');
    const mark = h.fake.messageLog.length;
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Message après la perte d\'accès' });
    await h.settle();
    const replies = messagesIn(h, dm.id, mark).filter((m) => m.author.id === h.client.user.id);
    assert.ok(!replies.some((m) => /non transmis/i.test(embedText(m))), `MP refusé : ${replies.map(embedText).join(' | ')}`);
    const thread = h.client.repositories.modmail.getOpenByUser(IDS.users.target);
    assert.ok(thread && thread.channel_id !== first.id, 'conversation toujours rattachée au salon inaccessible');
    assert.equal(h.client.repositories.modmail.getByChannel(first.id).status, 'closed');
    const relayed = messagesIn(h, thread.channel_id).map(embedText).join('\n');
    assert.match(relayed, /Message après la perte d'accès/);
    assert.match(relayed, new RegExp(`#${oldThread.id}`), 'le staff n\'est pas prévenu de la conversation précédente');
    assert.ok(h.warnLogs().some((l) => /accès perdu/i.test(l)));
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R64

/** Membre « Gérer le serveur » seulement, qui ne voit pas #staff. */
async function addManager(h) {
  const roleId = nextId();
  const role = { id: roleId, name: 'Gestion', color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position: 4, permissions: String(P.ManageGuild), managed: false, mentionable: false, flags: 0 };
  h.fake.roles.set(roleId, role);
  h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: h.guild.id, role });
  const user = h.addUser('Gestionnaire', { ageDays: 800 });
  const raw = rawMember(user, [roleId, IDS.roles.member], 300);
  h.fake.members.set(user.id, raw);
  h.guild.members._add(JSON.parse(JSON.stringify(raw)));
  await h.settle();
  const perms = h.client.channels.cache.get(IDS.channels.staff).permissionsFor(h.guild.members.cache.get(user.id));
  assert.ok(!perms.has(P.ViewChannel), 'le gestionnaire ne doit pas voir #staff');
  return user.id;
}

test('R64 publication par procuration : panneaux /tickets, /candidatures et test /bienvenue refusés dans un salon fermé à l\'auteur', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { enabled: false } });
    const manager = await addManager(h);
    const staffMessages = (mark) => messagesIn(h, IDS.channels.staff, mark).filter((m) => m.author.id === h.client.user.id);

    // /tickets : choix du salon puis publication.
    const view = (rec) => h.messagesOf(rec).at(-1);
    const dash = await h.slash('tickets', [], { as: manager });
    const panelV = await h.click(view(dash), 'cmd:tickets:nav', { as: manager, values: ['panel'] });
    const pick = await h.click(view(panelV), 'cmd:tickets:panelch', { as: manager, values: [IDS.channels.staff] });
    assert.ok(h.isError(pick), `salon du panneau accepté : ${h.replyText(pick)}`);
    assert.match(h.replyText(pick), /Vous ne pouvez pas écrire/);
    assert.notEqual(h.client.services.config.get(h.guild.id).tickets.panelChannelId, IDS.channels.staff);
    h.configure({ tickets: { panelChannelId: IDS.channels.staff, panel: { title: 'Annonce officielle', description: 'Le serveur ferme : [ce site](https://exemple.invalid)' } } });
    let mark = h.fake.messageLog.length;
    const pub = await h.click(view(panelV), 'cmd:tickets:publish', { as: manager });
    assert.ok(h.isError(pub), `panneau publié : ${h.replyText(pub)}`);
    assert.match(h.replyText(pub), /Vous ne pouvez pas écrire/);
    assert.equal(staffMessages(mark).length, 0, 'panneau de tickets publié dans #staff');
    // Un administrateur qui voit le salon peut toujours publier.
    const adminDash = await h.slash('tickets');
    const ok = await h.click(view(adminDash), 'cmd:tickets:publish');
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(staffMessages(mark).length, 1, 'publication refusée à un administrateur');

    // /candidatures : choix du salon puis publication.
    const service = h.client.services.applications;
    const formId = service.createForm(h.guild.id, { name: 'Recrutement', questions: [{ label: 'Pourquoi vous ?', long: false }] }).id;
    const home = await h.slash('candidatures', [], { as: manager });
    const formV = await h.click(view(home), 'cmd:candidatures:pick', { as: manager, values: [String(formId)] });
    const cpick = await h.click(view(formV), `cmd:candidatures:panelch:${formId}`, { as: manager, values: [IDS.channels.staff] });
    assert.ok(h.isError(cpick), `salon du panneau de candidature accepté : ${h.replyText(cpick)}`);
    service.updateForm(h.guild.id, formId, { panelChannelId: IDS.channels.staff });
    mark = h.fake.messageLog.length;
    const cpub = await h.click(view(formV), `cmd:candidatures:publish:${formId}`, { as: manager });
    assert.ok(h.isError(cpub), `panneau de candidature publié : ${h.replyText(cpub)}`);
    assert.equal(staffMessages(mark).length, 0, 'panneau de candidature publié dans #staff');

    // /bienvenue : salon du message d'arrivée, puis « Tester ».
    const wdash = await h.slash('bienvenue', [], { as: manager });
    const joinV = await h.click(view(wdash), 'cmd:bienvenue:nav', { as: manager, values: ['join'] });
    const wpick = await h.click(view(joinV), 'cmd:bienvenue:channel:join', { as: manager, values: [IDS.channels.staff] });
    assert.ok(h.isError(wpick), `salon de bienvenue accepté : ${h.replyText(wpick)}`);
    h.configure({ welcome: { join: { channelId: IDS.channels.staff, title: 'Annonce officielle', description: 'https://exemple.invalid' } } });
    const prevV = await h.click(view(joinV), 'cmd:bienvenue:go:preview', { as: manager });
    mark = h.fake.messageLog.length;
    const wtest = await h.click(view(prevV), 'cmd:bienvenue:test:join', { as: manager });
    assert.ok(h.isError(wtest), `test envoyé : ${h.replyText(wtest)}`);
    assert.equal(staffMessages(mark).length, 0, 'message de test publié dans #staff');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
