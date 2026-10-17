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

// ---------------------------------------------------------------- R65

test('R65 ModMail : le sélecteur de serveur fonctionne en MP (routeur, refus propre d\'un choix expiré)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const { selectMenu, row } = require('../../src/utils/components');
    const user = await h.client.users.fetch(IDS.users.target);
    const sent = await user.send({ content: 'Choix', components: [row(selectMenu({ id: 'cmd:modmail:pick', placeholder: 'Serveur', options: [{ value: h.guild.id, label: 'Serveur' }] }))] });
    const rec = await h.click(h.message(sent.id), 'cmd:modmail:pick', { as: 'target', values: [h.guild.id] });
    assert.ok(h.isError(rec), h.replyText(rec));
    assert.match(h.replyText(rec), /expiré/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R66 / R67

const { attachmentsOf } = require('../../src/utils/transcriptArchive');

/** Cartes relayées au staff (messages du membre) dans un salon ModMail. */
const relayedCards = (h, channelId) => messagesIn(h, channelId).filter((m) => m.author.id === h.client.user.id && /a écrit/.test(m.embeds?.[0]?.author?.name ?? ''));

test('R66 ModMail : message transféré relayé au staff (texte et pièce jointe), repris par l\'archive', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const snapshot = {
      message: {
        type: 0,
        content: 'Message de harcèlement reçu : « je sais où tu habites »',
        embeds: [],
        attachments: [{ id: '1400000000000000001', filename: 'preuve.png', size: 1234, url: 'https://cdn.discordapp.com/attachments/1/1400000000000000001/preuve.png', proxy_url: 'https://media.discordapp.net/attachments/1/1400000000000000001/preuve.png', content_type: 'image/png' }],
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        flags: 0,
        mentions: [],
        mention_roles: [],
      },
    };
    await h.userMessage({ as: 'target', channel: 'dm', content: '', extra: { message_reference: { type: 1, channel_id: '1300000000000000001', message_id: '1300000000000000002', guild_id: IDS.guild }, message_snapshots: [snapshot], flags: 1 << 14 } });
    const channel = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    const cards = relayedCards(h, channel.id);
    const all = cards.map(embedText).join('\n');
    assert.match(all, /je sais où tu habites/, `texte transféré perdu : ${all}`);
    assert.match(all, /preuve\.png/, 'pièce jointe transférée perdue');
    assert.doesNotMatch(all, /pièce jointe uniquement/);
    const found = cards.flatMap((m) => attachmentsOf({ id: m.id, author: m.author, attachments: new Map(), embeds: m.embeds }));
    assert.deepEqual(found.map((a) => a.name), ['preuve.png']);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R67 ModMail : 10 pièces jointes → les 10 liens restent visibles du staff et repris par l\'archive', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const hm = 'a'.repeat(64);
    const attachments = Array.from({ length: 10 }, (_, i) => {
      const id = `13${String(i).padStart(17, '0')}`;
      const filename = `capture-${i + 1}.png`;
      return { id, filename, size: 200_000, content_type: 'image/png', width: 800, height: 600,
        url: `https://cdn.discordapp.com/attachments/1300000000000000000/${id}/${filename}?ex=6720f3a1&is=671fa221&hm=${hm}&`,
        proxy_url: `https://media.discordapp.net/attachments/1300000000000000000/${id}/${filename}?ex=6720f3a1&is=671fa221&hm=${hm}&` };
    });
    await h.userMessage({ as: 'target', channel: 'dm', content: 'x'.repeat(3900), extra: { attachments } });
    const channel = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    const cards = relayedCards(h, channel.id);
    const found = cards.flatMap((m) => attachmentsOf({ id: m.id, author: m.author, attachments: new Map(), embeds: m.embeds }));
    assert.deepEqual(found.map((a) => a.name), attachments.map((a) => a.filename), `${found.length} / 10 liens`);
    assert.ok(embedText(cards[0]).includes('x'.repeat(3000)), 'texte du membre tronqué');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R68

test('R68 bouton « Transcript » : un transcript en cours par salon, délai par membre', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const { channelId, welcome } = await openTicket(h);
    const author = h.fake.users.get(IDS.users.member);
    for (let i = 0; i < 250; i++) h.fake.buildMessage({ channelId, body: { content: `message ${i}` }, author });
    const historyGets = (mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'GET' && c.route === `/channels/${channelId}/messages`).length;
    // Coût d'UNE génération (lectures d'historique).
    const base = h.fake.calls.length;
    await h.client.services.tickets.generateTranscript(h.client.channels.cache.get(channelId));
    const one = historyGets(base);
    assert.ok(one >= 3);
    const before = h.fake.calls.length;
    const recs = await Promise.all([
      ...Array.from({ length: 10 }, () => h.click(welcome, 'ticket:transcript', { as: 'member' })),
      h.click(welcome, 'ticket:transcript', { as: 'mod' }),
    ]);
    await h.settle({ timeout: 10_000 });
    const calls = h.fake.calls.slice(before);
    const gets = historyGets(before);
    const uploads = calls.filter((c) => c.files.some((f) => /transcript-\d+\.txt/.test(f.name))).length;
    assert.ok(gets <= one, `${gets} lectures d'historique pour 11 clics (une génération : ${one})`);
    assert.equal(uploads, 2, `${uploads} transcripts envoyés (attendu : 1 pour l'auteur, 1 pour le support)`);
    const refused = recs.filter((r) => h.isError(r));
    assert.equal(refused.length, 9);
    assert.match(h.replyText(refused[0]), /Patientez|patientez/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R69

test('R69 candidatures : « Gérer les permissions » sur le seul salon de réception ne suffit pas pour accepter', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const service = h.client.services.applications;
    const form = service.createForm(h.guild.id, { name: 'Recrutement', questions: [{ label: 'Âge ?', long: false }] });
    service.updateForm(h.guild.id, form.id, { reviewChannelId: IDS.channels.staff, roleIds: [IDS.roles.notif], panelChannelId: IDS.channels.general, open: true });
    const { form: published } = await service.publishPanel(h.guild, service.form(h.guild.id, form.id));
    const panel = h.message(published.panel_message_id);
    // « Membre » reçoit, sur #staff uniquement, Voir le salon + Gérer les permissions (bit Gérer les rôles).
    setOverwrites(h, IDS.channels.staff, [{ id: IDS.users.member, type: 1, allow: String(P.ViewChannel | P.ManageRoles), deny: '0' }]);
    await h.settle();
    assert.ok(!h.guild.members.cache.get(IDS.users.member).permissions.has(P.ManageRoles));
    const mark = h.fake.messageLog.length;
    const open = await h.click(panel, `cmd:candidature:apply:${form.id}`, { as: 'target' });
    await h.submitModal(open, { q0: '20 ans' }, { as: 'target' });
    const cardMsg = messagesIn(h, IDS.channels.staff, mark).find((m) => m.author.id === h.client.user.id);
    const app = h.client.repositories.applications.listPending(h.guild.id)[0];
    const res = await h.click(cardMsg, `cmd:candidatures:accept:${app.id}`, { as: 'member' });
    assert.ok(h.isError(res), 'candidature acceptée avec une simple surcharge de salon');
    assert.equal(h.client.repositories.applications.getApplication(h.guild.id, app.id).status, 'pending');
    assert.ok(!h.fake.members.get(IDS.users.target).roles.includes(IDS.roles.notif), 'rôle attribué');
    // Le modérateur sans « Gérer les rôles » sur le serveur non plus ; l'administrateur oui.
    const ok = await h.click(cardMsg, `cmd:candidatures:accept:${app.id}`, { as: 'admin' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R70

test('R70 tickets fantômes : réinvitation (guildCreate) et salon supprimé à la main → le membre peut rouvrir un ticket', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const { channelId } = await openTicket(h);
    // Bot expulsé ; pendant son absence, le salon du ticket est supprimé ; puis réinvitation.
    h.fake.dispatchNow('GUILD_DELETE', { id: IDS.guild, unavailable: false }, 'guildDelete');
    await h.settle();
    h.fake.channels.delete(channelId);
    const raw = {
      ...h.fake.guild,
      id: IDS.guild,
      roles: [...h.fake.roles.values()],
      channels: [...h.fake.channels.values()].filter((c) => ![10, 11, 12].includes(c.type)),
      threads: [],
      members: [...h.fake.members.values()],
      emojis: h.fake.guild.emojis ?? [],
      stickers: [],
      voice_states: [],
      presences: [],
      member_count: h.fake.members.size,
    };
    h.fake.dispatchNow('GUILD_CREATE', raw, 'guildCreate');
    await h.settle();
    await h.waitFor(() => !h.client.repositories.tickets.getByChannel(channelId));
    assert.equal(h.client.repositories.tickets.getByChannel(channelId), undefined, 'ligne fantôme après réinvitation');

    // Bot en ligne : un salon de ticket supprimé à la main ne bloque pas la limite du membre.
    h.client.services.tickets.lastOpened.clear();
    const second = await openTicket(h);
    const ch = h.fake.channels.get(second.channelId);
    h.fake.channels.delete(second.channelId);
    h.fake.dispatchNow('CHANNEL_DELETE', ch);
    await h.settle();
    h.client.services.tickets.lastOpened.clear();
    const third = await openTicket(h);
    assert.ok(third.channelId && third.channelId !== second.channelId);
    assert.equal(h.client.repositories.tickets.getByChannel(second.channelId), undefined);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R71

test('R71 entretien de candidature : fermé par l\'équipe seulement, sans notation ; la carte retrouve « Entretien »', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const service = h.client.services.applications;
    const form = service.createForm(h.guild.id, { name: 'Recrutement', questions: [{ label: 'Âge ?', long: false }] });
    service.updateForm(h.guild.id, form.id, { reviewChannelId: IDS.channels.staff, panelChannelId: IDS.channels.general, open: true });
    const { form: published } = await service.publishPanel(h.guild, service.form(h.guild.id, form.id));
    let mark = h.fake.messageLog.length;
    const open = await h.click(h.message(published.panel_message_id), `cmd:candidature:apply:${form.id}`, { as: 'member' });
    await h.submitModal(open, { q0: '25 ans' }, { as: 'member' });
    const cardMsg = messagesIn(h, IDS.channels.staff, mark).find((m) => m.author.id === h.client.user.id);
    const app = h.client.repositories.applications.listPending(h.guild.id)[0];
    const before = new Set(h.fake.channels.keys());
    const iv = await h.click(cardMsg, `cmd:candidatures:interview:${app.id}`, { as: 'admin' });
    assert.ok(!h.isError(iv), h.replyText(iv));
    const ticketId = [...h.fake.channels.keys()].find((k) => !before.has(k));
    assert.ok(h.client.repositories.tickets.getByChannel(ticketId), 'entretien non ouvert en ticket');
    const welcome = messagesIn(h, ticketId).find((m) => buttonIds(m).includes('ticket:close'));

    // Le candidat ne peut pas clore son entretien (bouton ni commande).
    const self = await h.click(welcome, 'ticket:close', { as: 'member' });
    assert.ok(h.isError(self), 'le candidat a pu fermer son entretien');
    const selfCmd = await h.slash('ticket', sub('close'), { as: 'member', channel: ticketId });
    assert.ok(h.isError(selfCmd));

    // L'équipe ferme : pas de MP de notation au candidat ; la carte propose à nouveau « Entretien ».
    mark = h.fake.messageLog.length;
    const close = await h.click(welcome, 'ticket:close', { as: 'mod' });
    await h.click(h.message(close.original), 'ticket:closeconfirm', { as: 'mod' });
    await sleep(5_400);
    await h.settle();
    assert.ok(!h.fake.channels.has(ticketId));
    const dms = messagesIn(h, h.dmChannel('member').id, mark);
    assert.ok(!dms.some((m) => buttonIds(m).some((b) => b.startsWith('cmd:tickets:rate:'))), 'MP de notation envoyé pour un entretien');
    await h.waitFor(() => buttonIds(h.message(cardMsg.id)).includes(`cmd:candidatures:interview:${app.id}`));
    const card = h.message(cardMsg.id);
    assert.ok(buttonIds(card).includes(`cmd:candidatures:interview:${app.id}`), `boutons : ${buttonIds(card)}`);
    assert.doesNotMatch(embedText(card), new RegExp(`<#${ticketId}>`), 'lien mort vers l\'entretien');
    const again = await h.click(card, `cmd:candidatures:interview:${app.id}`, { as: 'admin' });
    assert.ok(!h.isError(again), h.replyText(again));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- R72

test('R72 prise en charge pendant les 5 s de fermeture : refusée, instantané cohérent', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const { channelId, welcome } = await openTicket(h);
    const row = h.client.repositories.tickets.getByChannel(channelId);
    const close = await h.click(welcome, 'ticket:close', { as: 'member' });
    const pending = h.click(h.message(close.original), 'ticket:closeconfirm', { as: 'member' });
    await sleep(800);
    const claim = await h.click(h.message(welcome.id), 'ticket:claim', { as: 'mod' });
    assert.ok(h.isError(claim), 'prise en charge acceptée pendant la fermeture');
    assert.match(h.replyText(claim), /fermeture/);
    await pending;
    await sleep(4_800);
    await h.settle();
    const snap = h.client.repositories.ticketRatings.get(row.id);
    assert.ok(snap, 'instantané absent');
    assert.equal(snap.claimed_by, null);
    assert.equal(snap.claimed_at ?? null, null, 'claimed_at sans claimed_by');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
