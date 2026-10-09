'use strict';

/**
 * Bout en bout : régressions de la revue n° 4 (signalements, invitations, niveaux,
 * sauvegardes, compteurs, lockdown).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { nextId } = require('./lib/ids');

const REPORT = 'Signaler le message';
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const allText = (h, rec) => h.messagesOf(rec).flatMap((m) => m.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');
const authoredBy = (h, as, content, channelId = IDS.channels.general) => h.fake.buildMessage({ channelId, body: { content }, author: h.fake.users.get(IDS.users[as] ?? as) });

/** Signale `message` (menu + formulaire) et renvoie la carte publiée dans #staff. */
async function reportCard(h, message, as) {
  const mark = h.fake.messageLog.length;
  const menu = await h.contextMenu(REPORT, message, { as });
  assert.ok(menu.modals.length, `formulaire non ouvert : ${h.replyText(menu)}`);
  await h.submitModal(menu, { raison: 'Test' });
  const card = botMessages(h, mark, (m) => m.channel_id === IDS.channels.staff)[0];
  assert.ok(card, 'carte de signalement absente');
  return card;
}

test('signalement « Supprimer » : Gérer les messages exigé dans le salon du message, hiérarchie modérateur ↔ auteur seulement', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ reports: { channelId: IDS.channels.staff } });
  try {
    // « member » n'a « Gérer les messages » QUE dans #staff (surcharge de salon).
    const staff = h.guild.channels.cache.get(IDS.channels.staff);
    staff.permissionOverwrites._add({ id: IDS.users.member, type: 1, allow: String(P.ViewChannel | P.ManageMessages), deny: '0' });
    assert.equal(h.guild.channels.cache.get(IDS.channels.general).permissionsFor(IDS.users.member).has(P.ManageMessages), false);

    const msg = authoredBy(h, 'target', 'Message signalé');
    const card = await reportCard(h, msg, 'admin');
    const denied = await h.click(card, 'cmd:signalements:del:1', { as: 'member' });
    assert.ok(h.isError(denied), 'suppression acceptée sans « Gérer les messages » dans le salon du message');
    assert.match(h.replyText(denied), /Gérer les messages/);
    assert.ok(h.message(msg.id), 'message supprimé par un membre sans permission dans son salon');
    assert.equal(h.client.repositories.reports.get(h.guild.id, 1).actions.length, 0);

    // Auteur placé AU-DESSUS du bot mais sous le modérateur : la suppression reste possible.
    h.guild.roles.cache.get(IDS.roles.bot).rawPosition = 2; // sous « Joueur » (3)
    const high = authoredBy(h, 'member', 'Message d\'un membre « Joueur »');
    const card2 = await reportCard(h, high, 'admin');
    const ok = await h.click(card2, 'cmd:signalements:del:2', { as: 'mod' });
    assert.ok(!h.isError(ok), h.replyText(ok));
    assert.ok(!h.message(high.id), 'message non supprimé : la hiérarchie du bot ne devrait pas compter');

    // Auteur de rang égal ou supérieur au modérateur : refus.
    const adminMsg = authoredBy(h, 'admin', 'Message d\'un admin');
    const card3 = await reportCard(h, adminMsg, 'member');
    const refused = await h.click(card3, 'cmd:signalements:del:3', { as: 'mod' });
    assert.ok(h.isError(refused));
    assert.match(h.replyText(refused), /supérieur ou égal/);
    assert.ok(h.message(adminMsg.id));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('sauvegarde : compteurs, leur catégorie et vocaux temporaires exclus (jamais recréés figés)', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { enabled: false } });
  try {
    await h.client.services.counters.create(h.guild, ['members', 'bots']);
    await h.voice('member', 'hub');
    const tempId = h.fake.voiceStates.get(IDS.users.member)?.channel_id;
    assert.ok(tempId && tempId !== IDS.channels.hub, 'vocal temporaire non créé');
    const cfg = h.client.services.config.get(h.guild.id).statsCounters;
    const generated = [cfg.categoryId, cfg.counters.members.channelId, cfg.counters.bots.channelId, tempId];

    const backup = h.client.services.backup.create(h.guild, h.client.users.cache.get(IDS.users.admin), 'Test');
    const names = backup.data.channels.map((c) => c.name);
    for (const id of generated) {
      const name = h.guild.channels.cache.get(id)?.name;
      assert.ok(name, `salon ${id} absent du cache`);
      assert.ok(!names.includes(name), `« ${name} » sauvegardé`);
    }
    assert.ok(names.includes('général'), 'salons ordinaires absents de la sauvegarde');

    // Le compteur change de valeur (renommé) : la restauration ne recrée rien.
    await h.memberJoin(h.addUser('nouveau'));
    h.client.services.config.update(h.guild.id, { statsCounters: { counters: { members: { renamedAt: 0 } } } });
    await h.client.services.counters.update(h.guild);
    const res = await h.client.services.backup.restore(h.guild, backup.id);
    assert.equal(res.channels, 0, `salons recréés : ${res.channels}`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/** Pièce jointe brute (format API) d'un message utilisateur. */
const rawAttachment = (channelId, filename, size) => ({ id: nextId(), filename, size, url: `https://cdn.discordapp.com/attachments/${channelId}/${nextId()}/${filename}`, proxy_url: `https://media.discordapp.net/attachments/${channelId}/1/${filename}`, content_type: 'image/png' });

test('arrêt du bot pendant la fermeture d\'un ticket : archive sans téléchargement, salon supprimé', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ tickets: { archiveAttachments: true } });
  try {
    const downloads = [];
    // Téléchargement qui ne se termine qu'à l'abandon (CDN lent).
    h.client.services.tickets.fetch = (url, { signal } = {}) => {
      downloads.push(url);
      return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('abandon'), { name: 'AbortError' }))));
    };
    const channel = await h.client.services.tickets.create(h.guild, h.client.users.cache.get(IDS.users.member));
    await h.settle();
    await h.userMessage({ as: 'member', channel: channel.id, content: 'Capture', extra: { attachments: [rawAttachment(channel.id, 'capture.png', 2048)] } });
    const mark = h.fake.calls.length;
    await h.slash('ticket', [{ name: 'close', type: 1, options: [] }], { as: 'member', channel: channel.id });
    const started = Date.now();
    await h.client.services.tickets.flush(); // arrêt du bot pendant le délai de fermeture
    assert.ok(Date.now() - started < 2_000, `fermeture trop lente à l'arrêt : ${Date.now() - started} ms`);
    await h.settle();
    assert.equal(downloads.length, 0, 'pièce jointe téléchargée pendant l\'arrêt');
    const archive = h.fake.calls.slice(mark).find((c) => c.route === `/channels/${IDS.channels.logs}/messages` && c.files.length);
    assert.ok(archive, 'transcript non archivé');
    assert.deepEqual(archive.files.map((f) => f.name).filter((n) => !n.endsWith('.txt')), []);
    assert.ok(!h.fake.channels.has(channel.id), 'salon du ticket non supprimé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('salon des signalements supprimé : débranché, repli sur les logs Modération, signalé par /diagnostics', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ reports: { channelId: IDS.channels.staff } });
  try {
    // Salon disparu pendant que le bot était hors ligne : repli immédiat (pas de refus).
    h.configure({ reports: { channelId: '123456789012345678' } });
    const diag = await h.slash('diagnostics');
    assert.match(allText(h, diag), /Salon des signalements : salon introuvable/);
    const mark = h.fake.messageLog.length;
    const menu = await h.contextMenu(REPORT, authoredBy(h, 'target', 'Premier'), { as: 'member' });
    assert.ok(menu.modals.length, `signalement refusé : ${h.replyText(menu)}`);
    await h.submitModal(menu, { raison: 'x' });
    assert.ok(botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && /Signalement #1/.test(m.embeds?.[0]?.title ?? '')).length, 'carte non repliée sur les logs Modération');
    const dash = await h.slash('signalements');
    assert.match(allText(h, dash), /introuvable : repli/);

    // Salon supprimé en direct : la configuration est remise à zéro.
    h.configure({ reports: { channelId: IDS.channels.staff } });
    h.fake.deleteChannel(IDS.channels.staff);
    await h.settle();
    assert.equal(h.client.services.config.get(h.guild.id).reports.channelId, null, 'reports.channelId non remis à zéro');
    const mark2 = h.fake.messageLog.length;
    const menu2 = await h.contextMenu(REPORT, authoredBy(h, 'target', 'Second'), { as: 'admin' });
    await h.submitModal(menu2, { raison: 'y' });
    assert.ok(botMessages(h, mark2, (m) => m.channel_id === IDS.channels.logs && /Signalement #2/.test(m.embeds?.[0]?.title ?? '')).length);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
