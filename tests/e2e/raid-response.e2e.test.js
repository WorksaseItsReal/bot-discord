'use strict';

/**
 * SEC3 — riposte native de Discord (incident-actions), bout en bout : /lockdown suspendre,
 * status, reprendre et riposte ; bouton « Rétablir » ; bot sans « Gérer le serveur » ; vague
 * d'arrivées de l'AntiRaid avec la riposte active (un seul PUT, champ dans l'alerte).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS, EPHEMERAL } = require('./harness');
const { explore } = require('./lib/explore');

const sub = (name, options = []) => [{ name, type: 1, options }];
const opt = (name, type, value) => ({ name, type, value });
const HOUR = 3_600_000;
const puts = (h, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'PUT' && /\/incident-actions$/.test(c.route));
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
const until = (h, key) => (h.fake.guild.incidents_data?.[key] ? Date.parse(h.fake.guild.incidents_data[key]) : null);

test('/lockdown suspendre → invites_disabled_until dans ]maintenant, +24 h] ; status l\'affiche ; jamais raccourcie ; reprendre → null ; bouton « Rétablir » ; log incident', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    let mark = h.fake.calls.length;
    let msgMark = h.fake.messageLog.length;
    const before = Date.now();
    const rec = await h.slash('lockdown', sub('suspendre', [opt('duree', 4, 24)]));
    assert.ok(!h.isError(rec), h.replyText(rec));
    assert.ok(h.messagesOf(rec)[0].flags & EPHEMERAL);
    assert.match(h.messagesOf(rec)[0].embeds[0].title, /Mesures d'incident activées/);
    assert.equal(puts(h, mark).length, 1);
    const inv = until(h, 'invites_disabled_until');
    assert.ok(inv > before && inv <= Date.now() + 24 * HOUR, `échéance hors bornes : ${new Date(inv).toISOString()}`);
    assert.ok(inv <= Date.now() + 24 * HOUR - 60_000 + 5_000, 'échéance non plafonnée à 24 h − 1 min');
    assert.equal(h.fake.guild.incidents_data.dms_disabled_until, null, 'MP suspendus sans le demander');
    // Les deux échéances sont toujours envoyées.
    assert.deepEqual(Object.keys(puts(h, mark)[0].body).sort(), ['dms_disabled_until', 'invites_disabled_until']);
    assert.equal(botMessages(h, msgMark, (m) => m.channel_id === IDS.channels.logs && titled(/Mesures d'incident activées/)(m)).length, 1, 'log incident absent');

    // Une seconde pause plus courte ne raccourcit pas l'échéance ; les MP s'ajoutent.
    await h.slash('lockdown', sub('suspendre', [opt('duree', 4, 1), opt('messages_prives', 5, true)]));
    assert.equal(until(h, 'invites_disabled_until'), inv, 'échéance raccourcie');
    const dms = until(h, 'dms_disabled_until');
    assert.ok(dms > Date.now() && dms <= Date.now() + HOUR, 'MP : 1 h attendue');

    // status : lecture chez Discord (deferReply), échéances et raid détecté affichés.
    h.fake.guild.incidents_data.raid_detected_at = new Date(Date.now() - 60_000).toISOString();
    const status = await h.slash('lockdown', sub('status'));
    const fields = h.messagesOf(status)[0].embeds[0].fields;
    assert.match(fields.find((f) => f.name.includes('Invitations')).value, /Suspendues jusqu'à <t:\d+:f>/);
    assert.match(fields.find((f) => f.name.includes('MP')).value, /Suspendus jusqu'à/);
    assert.ok(fields.some((f) => /Raid détecté/.test(f.name)));
    assert.ok(h.findComponent(h.messagesOf(status)[0], 'cmd:lockdown:resume:all'));
    await explore(h, status, { as: 'member', budget: 6 });
    assert.ok(until(h, 'invites_disabled_until'), 'un membre a rétabli les invitations');

    // Bouton « Rétablir les MP » (Administrateur) puis /lockdown reprendre.
    mark = h.fake.calls.length;
    const resumeDms = await h.click(h.messagesOf(status)[0], 'cmd:lockdown:resume:dms');
    assert.ok(!h.isError(resumeDms), h.replyText(resumeDms));
    assert.equal(h.fake.guild.incidents_data.dms_disabled_until, null);
    assert.equal(until(h, 'invites_disabled_until'), inv, 'invitations rétablies avec les MP');
    msgMark = h.fake.messageLog.length;
    const resume = await h.slash('lockdown', sub('reprendre'));
    assert.ok(!h.isError(resume), h.replyText(resume));
    assert.equal(h.fake.guild.incidents_data.invites_disabled_until, null);
    assert.equal(h.fake.guild.incidents_data.dms_disabled_until, null);
    assert.equal(puts(h, mark).length, 2);
    assert.equal(botMessages(h, msgMark, (m) => m.channel_id === IDS.channels.logs && titled(/Mesures d'incident levées/)(m)).length, 1);

    // Ni invitations ni MP : refus clair, aucun appel.
    mark = h.fake.calls.length;
    assert.ok(h.isError(await h.slash('lockdown', sub('suspendre', [opt('invitations', 5, false)]))));
    assert.equal(puts(h, mark).length, 0);
    // Membre : refus en embed.
    const denied = await h.slash('lockdown', sub('suspendre'), { as: 'member' });
    assert.ok(h.isError(denied));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('bot sans « Gérer le serveur » : erreur claire, aucune requête vouée au 403', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    // Rôle du bot sans Administrateur ni Gérer le serveur.
    const role = h.fake.roles.get(IDS.roles.bot);
    role.permissions = (BigInt(P.BanMembers) | BigInt(P.ManageRoles) | BigInt(P.SendMessages) | BigInt(P.ViewChannel) | BigInt(P.EmbedLinks)).toString();
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role });
    await h.settle();
    assert.equal(h.guild.members.me.permissions.has(P.ManageGuild), false);
    const mark = h.fake.calls.length;
    const rec = await h.slash('lockdown', sub('suspendre'));
    assert.ok(h.isError(rec));
    assert.match(h.replyText(rec), /Gérer le serveur/);
    const resume = await h.slash('lockdown', sub('reprendre'));
    assert.match(h.replyText(resume), /Gérer le serveur/);
    assert.equal(puts(h, mark).length, 0);
    // La riposte s'active quand même, avec un avertissement.
    const riposte = await h.slash('lockdown', sub('riposte', [opt('actif', 5, true)]));
    assert.match(JSON.stringify(h.messagesOf(riposte)[0].embeds[0]), /Gérer le serveur/);
    // Erreur 403 de Discord (permission retirée entre-temps) : traduite aussi.
    role.permissions = String(P.Administrator);
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role });
    await h.settle();
    h.fake.inject({ method: 'PUT', route: /\/incident-actions$/ }, { status: 403, code: 50013 });
    const refused = await h.slash('lockdown', sub('suspendre'));
    assert.match(h.replyText(refused), /Gérer le serveur/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('riposte active : une vague d\'arrivées → un seul PUT (même avec une seconde vague), champ « Invitations » dans l\'alerte ; riposte coupée → aucun PUT', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    // Riposte coupée : une vague ne touche pas aux invitations.
    let mark = h.fake.calls.length;
    for (let i = 0; i < 3; i += 1) await h.memberJoin(h.addUser(`Calme${i}`, { ageDays: 400 }));
    await h.settle();
    assert.equal(puts(h, mark).length, 0, 'riposte coupée par défaut');
    h.client.services.antiraid.joinAlertAt.clear();

    const rip = await h.slash('lockdown', sub('riposte', [opt('actif', 5, true), opt('duree', 4, 3)]));
    assert.ok(!h.isError(rip), h.replyText(rip));
    assert.deepEqual(h.client.services.config.get(h.guild.id).raidResponse, { onWave: true, invites: true, dms: false, hours: 3 });
    mark = h.fake.calls.length;
    const msgMark = h.fake.messageLog.length;
    for (let i = 0; i < 3; i += 1) await h.memberJoin(h.addUser(`Raider${i}`, { ageDays: 400 }));
    await h.settle();
    assert.equal(puts(h, mark).length, 1, 'riposte absente');
    const inv = until(h, 'invites_disabled_until');
    assert.ok(inv > Date.now() + 2.9 * HOUR && inv <= Date.now() + 3 * HOUR);
    const [alert] = botMessages(h, msgMark, titled(/Vague d'arrivées détectée/));
    assert.ok(alert, 'alerte de vague absente');
    assert.match(alert.embeds[0].fields.find((f) => f.name.includes('Invitations')).value, /Invitations suspendues jusqu'à/);
    // Seconde vague juste après (fenêtre de l'AntiRaid réarmée) : aucune nouvelle pause (10 min).
    for (let i = 0; i < 3; i += 1) await h.memberJoin(h.addUser(`Vague2-${i}`, { ageDays: 400 }));
    await h.settle();
    assert.equal(puts(h, mark).length, 1, 'deux pauses en 10 minutes');
    // Journal des réglages de sécurité (securConfig) et refus pour un membre.
    assert.ok(botMessages(h, 0, (m) => m.channel_id === IDS.channels.logs && titled(/Réglages de sécurité modifiés/)(m)).length >= 1, 'riposte non journalisée');
    assert.ok(h.isError(await h.slash('lockdown', sub('riposte', [opt('actif', 5, false)]), { as: 'member' })));
    const off = await h.slash('lockdown', sub('riposte', [opt('actif', 5, false)]));
    assert.match(h.messagesOf(off)[0].embeds[0].description, /coupée/);
    assert.equal(h.client.services.config.get(h.guild.id).raidResponse.onWave, false);
    assert.ok(h.isError(await h.slash('lockdown', sub('riposte', [opt('actif', 5, true), opt('invitations', 5, false)]))), 'riposte sans rien à suspendre');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
