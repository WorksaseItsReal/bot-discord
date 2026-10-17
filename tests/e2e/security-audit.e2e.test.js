'use strict';

/**
 * SEC2 — audit de sécurité de /diagnostics, bout en bout : bouton « Audit de sécurité », correction
 * everyone_perms confirmée puis appliquée (permissions d'@everyone changées, contrôle OK, log
 * server.securityFix), refus d'un modérateur, salon de transcripts sans « Joindre des fichiers ».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore, newStats } = require('./lib/explore');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const ids = (msg) => (msg?.components ?? []).flatMap((r) => r.components ?? []).map((c) => c.custom_id).filter(Boolean);
const everyonePerms = (h) => BigInt(h.fake.roles.get(IDS.roles.everyone).permissions);
const recOf = (h, message) => ({ messages: [message.id], followUps: [], msgMark: h.fake.messageLog.length, modals: [] });

test('/diagnostics → Audit → correction everyone_perms confirmée : permissions d\'@everyone changées, contrôle OK, log ; modérateur refusé', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    // Un modérateur (sans « Gérer le serveur » ni Administrateur) ne lance même pas /diagnostics.
    assert.ok(h.isError(await h.slash('diagnostics', [], { as: 'mod' })));
    // @everyone reçoit « Gérer le serveur » : le modérateur l'a donc aussi, mais pas Administrateur.
    await h.asHuman('owner').editRole(IDS.roles.everyone, { permissions: String(everyonePerms(h) | P.ManageGuild | P.MentionEveryone) });
    assert.ok(h.guild.roles.everyone.permissions.has(P.ManageGuild, false));
    const modDiag = await h.slash('diagnostics', [], { as: 'mod' });
    assert.ok(!ids(h.messagesOf(modDiag)[0]).includes('cmd:diagnostics:audit'), 'bouton Audit proposé sans Administrateur');

    const rec = await h.slash('diagnostics', [], { as: 'admin' });
    const msg = h.messagesOf(rec)[0];
    assert.ok(ids(msg).includes('cmd:diagnostics:audit'), 'bouton Audit absent pour un administrateur');
    const audited = await h.click(msg, 'cmd:diagnostics:audit', { as: 'admin' });
    assert.equal(audited.ackType, 6, 'audit : deferUpdate attendu');
    await h.settle();
    let view = h.message(msg.id);
    assert.match(view.embeds[0].title, /Audit de sécurité/);
    assert.ok(view.embeds[0].fields.length <= 6 && view.components.length <= 5);
    assert.match(view.embeds[0].fields[0].value, /❌ \*\*C1\*\*/);
    assert.ok(ids(view).includes('cmd:diagnostics:fix:everyone_perms'));

    // Boutons de l'audit cliqués par un modérateur : tous refusés, rien ne change.
    const markMod = h.fake.messageLog.length;
    // (« Diagnostic » reste ouvert au modérateur, qui a « Gérer le serveur » via @everyone : ignoré ici.)
    await explore(h, recOf(h, view), { as: 'mod', budget: 12, skip: (a) => a.customId === 'cmd:diagnostics:rerun' });
    assert.match(h.message(msg.id).embeds[0].title, /Audit de sécurité/, 'audit remplacé par un clic refusé');
    assert.ok(h.guild.roles.everyone.permissions.has(P.ManageGuild, false), 'un modérateur a corrigé @everyone');
    assert.equal(botMessages(h, markMod, (m) => /Correction de l'audit/.test(m.embeds?.[0]?.title ?? '')).length, 0);

    // Confirmation (changements exacts), puis application.
    await h.click(h.message(msg.id), 'cmd:diagnostics:fix:everyone_perms', { as: 'admin' });
    view = h.message(msg.id);
    assert.match(view.embeds[0].description, /retirer « Gérer le serveur », « Mentionner @everyone »/);
    assert.ok(h.guild.roles.everyone.permissions.has(P.ManageGuild, false), 'modifié avant confirmation');
    const mark = h.fake.messageLog.length;
    const callMark = h.fake.calls.length;
    await h.click(view, 'cmd:diagnostics:fixok:everyone_perms', { as: 'admin' });
    await h.settle();
    assert.equal(everyonePerms(h) & (P.ManageGuild | P.MentionEveryone), 0n, 'permissions d\'@everyone inchangées');
    assert.ok(everyonePerms(h) & P.SendMessages, 'permissions ordinaires retirées');
    const patch = h.fake.calls.slice(callMark).find((c) => c.method === 'PATCH' && c.route === `/guilds/${h.guild.id}/roles/${IDS.roles.everyone}`);
    assert.match(decodeURIComponent(patch?.reason ?? patch?.headers?.['X-Audit-Log-Reason'] ?? patch?.auditLogReason ?? ''), /Audit de sécurité par/);
    view = h.message(msg.id);
    assert.match(view.embeds[0].description, /appliquée/);
    assert.match(view.embeds[0].fields[0].value, /✅ \*\*C1\*\*/, 'contrôle C1 toujours en erreur');
    const logs = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && /Correction de l'audit/.test(m.embeds?.[0]?.title ?? ''));
    assert.equal(logs.length, 1, 'log server.securityFix absent');
    assert.match(JSON.stringify(logs[0].embeds[0]), new RegExp(IDS.users.admin));

    // Exploration complète de l'audit (autres corrections comprises) : aucune violation.
    const stats = newStats();
    await explore(h, recOf(h, h.message(msg.id)), { as: 'admin', budget: 40, stats });
    assert.ok(stats.keys.has('cmd:diagnostics:fixok'));
    assert.equal(h.guild.verificationLevel, 2, 'correction verification_level non appliquée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/diagnostics : salon de transcripts où je ne peux pas « Joindre des fichiers » signalé ; groupe Secur avec un module actif', async () => {
  const h = await createHarness({ botAdministrator: false });
  try {
    h.configureAll();
    const logs = h.fake.channels.get(IDS.channels.logs);
    logs.permission_overwrites.push({ id: IDS.roles.bot, type: 0, allow: String(P.ViewChannel | P.SendMessages | P.EmbedLinks), deny: String(P.AttachFiles) });
    h.fake.dispatchNow('CHANNEL_UPDATE', logs, 'préparation : salon des transcripts');
    await h.settle();
    h.configure({ secur: { raidPingRoleId: IDS.roles.notif, modules: { channelDelete: { mode: 'on' } } } });
    const rec = await h.slash('diagnostics', [], { as: 'admin' });
    const text = JSON.stringify(h.messagesOf(rec)[0].embeds[0]);
    assert.match(text, /Transcripts \(tickets et ModMail\)/);
    assert.match(text, /je ne peux pas joindre de fichiers/);
    assert.match(text, /Secur/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
