'use strict';

/**
 * Bout en bout : régressions de la revue n° 4 (signalements, invitations, niveaux,
 * sauvegardes, compteurs, lockdown).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');

const REPORT = 'Signaler le message';
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
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
