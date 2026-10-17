'use strict';

/**
 * Bout en bout : notation des tickets sur le vrai discord.js. Ticket ouvert par le panneau,
 * pris en charge, fermé : l'auteur reçoit en MP cinq boutons ⭐ (interactions hors serveur),
 * note une seule fois, commente ; un autre utilisateur ne peut pas noter ; statistiques de
 * /tickets ; notation désactivable (aucun MP).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buttonIds = (msg) => (msg?.components ?? []).flatMap((r) => r.components ?? []).map((c) => c.custom_id).filter(Boolean);
const embedText = (msg) => (msg?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');

/** Messages privés reçus par un utilisateur depuis `mark`. */
function dmsOf(h, as, mark = 0) {
  const dm = h.dmChannel(as);
  return h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === dm.id);
}

/** Ouvre un ticket par le panneau (membre), le fait prendre en charge (modérateur), puis le ferme. */
async function ticketLifecycle(h, { as = 'member', claimBy = 'mod' } = {}) {
  const channel = h.client.channels.cache.get(IDS.channels.general);
  const panel = await channel.send(h.client.services.tickets.panel(h.guild));
  const before = new Set(h.fake.channels.keys());
  const open = await h.click(h.message(panel.id), 'ticket:create', { as });
  assert.ok(!h.isError(open), h.replyText(open));
  const ticketChannel = [...h.fake.channels.keys()].find((k) => !before.has(k));
  const welcome = h.fake.messageLog.map((id) => h.message(id)).find((m) => m?.channel_id === ticketChannel && buttonIds(m).includes('ticket:claim'));
  if (claimBy) {
    await sleep(15); // délai de prise en charge mesurable
    const claim = await h.click(welcome, 'ticket:claim', { as: claimBy });
    assert.ok(!h.isError(claim), h.replyText(claim));
  }
  const ticket = h.client.repositories.tickets.getByChannel(ticketChannel);
  const close = await h.click(h.message(welcome.id), 'ticket:close', { as });
  await h.click(h.message(close.original), 'ticket:closeconfirm', { as });
  await sleep(5_300); // délai de fermeture du bot (5 s)
  await h.settle();
  assert.ok(!h.fake.channels.has(ticketChannel), 'ticket non supprimé après fermeture');
  return ticket;
}

test('notation des tickets : MP à la fermeture, une note par l\'auteur seulement, commentaire, statistiques', async () => {
  const h = await createHarness();
  h.configureAll();
  const repo = () => h.client.repositories.ticketRatings;
  try {
    let mark = h.fake.messageLog.length;
    const ticket = await ticketLifecycle(h);
    assert.ok(ticket.claimed_at && ticket.claimed_at >= ticket.created_at, 'claimed_at non enregistré à la prise en charge');
    const row = repo().get(ticket.id);
    assert.ok(row, 'instantané du ticket fermé absent');
    assert.equal(row.user_id, IDS.users.member);
    assert.equal(row.claimed_by, IDS.users.mod);
    assert.equal(row.rating, null);

    // MP de notation : cinq boutons ⭐ portant l'identifiant du ticket.
    const dm = dmsOf(h, 'member', mark).find((m) => buttonIds(m).some((b) => b.startsWith('cmd:tickets:rate:')));
    assert.ok(dm, 'MP de notation non reçu');
    assert.deepEqual(buttonIds(dm), [1, 2, 3, 4, 5].map((n) => `cmd:tickets:rate:${ticket.id}:${n}`));
    assert.match(embedText(dm), /Comment s'est passé votre ticket/);
    const original = JSON.parse(JSON.stringify(dm));

    // Un autre utilisateur (MP transféré, customId rejoué) : refusé, vérifié en base.
    const intruder = await h.click(original, `cmd:tickets:rate:${ticket.id}:1`, { as: 'target' });
    assert.ok(h.isError(intruder), 'un autre utilisateur a pu noter');
    assert.match(h.replyText(intruder), /auteur du ticket/);
    assert.equal(repo().get(ticket.id).rating, null);

    // L'auteur note 4 ⭐ (hors serveur) : message remplacé par un remerciement.
    const rated = await h.click(dm, `cmd:tickets:rate:${ticket.id}:4`, { as: 'member' });
    assert.ok(!h.isError(rated), h.replyText(rated));
    assert.equal(repo().get(ticket.id).rating, 4);
    assert.match(embedText(h.message(dm.id)), /Merci pour votre avis/);
    assert.deepEqual(buttonIds(h.message(dm.id)), [`cmd:tickets:ratecomment:${ticket.id}`]);

    // Deuxième note (ancien message) : refusée, la première est conservée.
    const twice = await h.click(original, `cmd:tickets:rate:${ticket.id}:1`, { as: 'member' });
    assert.ok(h.isError(twice));
    assert.match(h.replyText(twice), /déjà noté/);
    assert.equal(repo().get(ticket.id).rating, 4);

    // Commentaire facultatif.
    const comment = await h.click(h.message(dm.id), `cmd:tickets:ratecomment:${ticket.id}`, { as: 'member' });
    assert.equal(comment.modals.length, 1);
    const sent = await h.submitModal(comment, { commentaire: 'Réponse rapide, merci ! @everyone' }, { as: 'member' });
    assert.ok(!h.isError(sent), h.replyText(sent));
    assert.equal(repo().get(ticket.id).comment, 'Réponse rapide, merci ! @everyone');
    assert.deepEqual(buttonIds(h.message(dm.id)), []);

    // Journal : note dans les logs de modération.
    const logs = h.fake.messageLog.map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs).map(embedText).join('\n');
    assert.match(logs, new RegExp(`Ticket #${ticket.id} noté 4/5`));

    // Statistiques : note moyenne, staff, délais.
    const dash = await h.slash('tickets');
    const stats = await h.click(h.messagesOf(dash)[0], 'cmd:tickets:nav', { values: ['stats'] });
    const text = embedText(h.messagesOf(stats)[0]);
    assert.match(text, /Statistiques des tickets/);
    assert.match(text, /4,0 \/ 5/);
    assert.match(text, new RegExp(`<@${IDS.users.mod}> · \\*\\*1\\*\\* ticket`));
    assert.match(text, /Réponse rapide/);
    const period = await h.click(h.messagesOf(stats)[0], 'cmd:tickets:period', { values: ['7'] });
    assert.match(h.replyText(period), /7 derniers jours/);
    await explore(h, stats, { budget: 20 });
    h.configure({ tickets: { ratings: true } }); // l'exploration a pu basculer la notation

    // Notation désactivée : aucun MP à la fermeture, l'instantané reste tenu.
    const fresh = await h.click(h.messagesOf(await h.slash('tickets'))[0], 'cmd:tickets:nav', { values: ['stats'] });
    assert.ok(buttonIds(h.messagesOf(fresh)[0]).includes('cmd:tickets:ratings:off'), `${h.replyText(fresh)} ${buttonIds(h.messagesOf(fresh)[0])}`);
    const off = await h.click(h.messagesOf(fresh)[0], 'cmd:tickets:ratings:off');
    assert.match(h.replyText(off), /Notation désactivée/);
    assert.equal(h.client.services.config.get(h.guild.id).tickets.ratings, false);
    mark = h.fake.messageLog.length;
    const second = await ticketLifecycle(h, { as: 'target', claimBy: null });
    assert.equal(dmsOf(h, 'target', mark).filter((m) => buttonIds(m).some((b) => b.startsWith('cmd:tickets:rate:'))).length, 0, 'MP de notation envoyé malgré la désactivation');
    assert.ok(repo().get(second.id), 'instantané absent sans notation');

    // Membre sans permission : la vue statistiques et le bouton de notation du tableau de bord refusés.
    const denied = await h.click(h.messagesOf(fresh)[0], 'cmd:tickets:ratings:on', { as: 'member' });
    assert.ok(h.isError(denied));
    assert.equal(h.client.services.config.get(h.guild.id).tickets.ratings, false);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
