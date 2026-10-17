'use strict';

/**
 * SEC2 — audit de sécurité (utils/securityAudit, pur) et /diagnostics : contrôles C1 à C14, plans
 * de correction, score, groupe « Secur » d'analyze(), salons de transcripts sans « Joindre des
 * fichiers », bouton Audit et corrections (Administrateur, verrou, réponse puis log).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionsBitField, PermissionFlagsBits: P, ChannelType } = require('discord.js');
const { defaultGuildConfig } = require('../src/config/defaults');
const A = require('../src/utils/securityAudit');
const diagnostics = require('../src/commands/configuration/diagnostics');

const G = '100000000000000001';
const BOT = '100000000000000010';
const OWNER = '100000000000000011';
const json = (e) => (typeof e?.toJSON === 'function' ? e.toJSON() : e);
const cfgOf = (patch = {}) => {
  const base = JSON.parse(JSON.stringify(defaultGuildConfig));
  for (const [k, v] of Object.entries(patch)) base[k] = { ...base[k], ...v };
  return base;
};
const sf = (n) => String(BigInt('300000000000000000') + BigInt(n));

/** Faux serveur pour l'audit. */
function guildOf({ everyonePerms = 0n, botPerms = P.Administrator, botPosition = 10, roles = [], members = [], channels = [], props = {} } = {}) {
  const roleCache = new Collection();
  const mkRole = (r) => ({ id: r.id, name: r.name ?? r.id, position: r.position ?? 1, managed: Boolean(r.managed), mentionable: Boolean(r.mentionable), permissions: new PermissionsBitField(r.perms ?? 0n), members: new Collection(), toString: () => `<@&${r.id}>` });
  const everyone = mkRole({ id: G, position: 0, perms: everyonePerms });
  roleCache.set(G, everyone);
  const botRole = mkRole({ id: 'botrole', position: botPosition, perms: botPerms, managed: true });
  roleCache.set('botrole', botRole);
  for (const r of roles) roleCache.set(r.id, mkRole(r));
  const memberCache = new Collection();
  const me = { id: BOT, user: { id: BOT, bot: true }, permissions: new PermissionsBitField(botPerms), roles: { highest: botRole, cache: new Collection([['botrole', botRole]]) }, toString: () => `<@${BOT}>` };
  memberCache.set(BOT, me);
  for (const m of members) {
    const rc = new Collection((m.roles ?? []).map((id) => [id, roleCache.get(id)]));
    let bits = m.perms ?? 0n;
    for (const r of rc.values()) bits |= r.permissions.bitfield;
    const member = { id: m.id, user: { id: m.id, bot: Boolean(m.bot) }, permissions: new PermissionsBitField(m.id === OWNER ? PermissionsBitField.All : bits), roles: { cache: rc }, toString: () => `<@${m.id}>` };
    memberCache.set(m.id, member);
    for (const r of rc.values()) r.members.set(m.id, member);
  }
  for (const r of roles) if (r.count) for (let i = 0; i < r.count; i += 1) roleCache.get(r.id).members.set(`x${i}`, {});
  const channelCache = new Collection();
  for (const c of channels) {
    channelCache.set(c.id, {
      id: c.id,
      type: c.type ?? ChannelType.GuildText,
      position: c.position ?? 0,
      permissionOverwrites: { cache: new Collection((c.overwrites ?? []).map((o) => [o.id, { id: o.id, allow: new PermissionsBitField(o.allow ?? 0n), deny: new PermissionsBitField(o.deny ?? 0n) }])) },
      permissionsFor: () => new PermissionsBitField(c.botPerms ?? botPerms),
      isTextBased: () => true,
      toString: () => `<#${c.id}>`,
    });
  }
  return {
    id: G,
    ownerId: OWNER,
    memberCount: memberCache.size,
    verificationLevel: 2,
    explicitContentFilter: 2,
    mfaLevel: 1,
    defaultMessageNotifications: 1,
    features: [],
    safetyAlertsChannelId: null,
    roles: { cache: roleCache, everyone },
    members: { cache: memberCache, me },
    channels: { cache: channelCache },
    iconURL: () => null,
    ...props,
  };
}

const byId = (audit, id) => audit.checks.find((c) => c.id === id);

test('serveur sain : tous les contrôles OK, note A, aucune correction', () => {
  const audit = A.auditSecurity(guildOf(), cfgOf(), { groups: [] });
  assert.equal(audit.checks.length, 14);
  assert.deepEqual(audit.checks.map((c) => c.id), Array.from({ length: 14 }, (_, i) => `C${i + 1}`));
  for (const c of audit.checks) assert.ok(['ok', 'info'].includes(c.level), `${c.id} : ${c.level} (${c.text})`);
  assert.equal(audit.score, 100);
  assert.equal(audit.grade.letter, 'A');
  assert.deepEqual(audit.fixes, []);
});

test('C1 à C14 : chaque contrôle détecte son problème sur un faux serveur', () => {
  const g = guildOf({
    everyonePerms: P.ManageGuild | P.MentionEveryone | P.SendMessages,
    roles: [
      { id: 'admin', position: 5, perms: P.Administrator },
      { id: 'big', position: 3, mentionable: true, count: 60 },
      { id: 'top', position: 20, perms: P.BanMembers },
      { id: 'wl', position: 2, count: 25 },
    ],
    members: [
      ...Array.from({ length: 7 }, (_, i) => ({ id: sf(i), roles: ['admin'] })),
      { id: 'evilbot', bot: true, roles: ['admin'] },
      { id: 'goodbot', bot: true, roles: ['admin'] },
    ],
    channels: [{ id: 'c1', overwrites: [{ id: G, allow: P.ManageWebhooks | P.ViewChannel }] }, { id: 'alerts' }],
    props: { verificationLevel: 1, explicitContentFilter: 0, mfaLevel: 0, defaultMessageNotifications: 0, memberCount: 1500, features: ['COMMUNITY'] },
  });
  const cfg = cfgOf({ secur: { trustedBots: ['goodbot'] }, whitelist: { users: [], roles: ['wl'] }, antiraid: { alertChannel: 'alerts' } });
  const groups = [{ icon: 'x', label: 'y', checks: [{ level: 'fail', text: 'Salon introuvable' }, { level: 'ok', text: 'ok' }] }];
  const pending = [{ id: 1, kind: 'user', subject_id: 'm', granted_by: 'a' }];
  const audit = A.auditSecurity(g, cfg, { groups, pending });
  const expect = { C1: 'fail', C2: 'fail', C3: 'warn', C4: 'warn', C5: 'warn', C6: 'warn', C7: 'warn', C8: 'warn', C9: 'warn', C10: 'warn', C11: 'warn', C12: 'fail', C13: 'warn', C14: 'warn' };
  for (const [id, level] of Object.entries(expect)) assert.equal(byId(audit, id).level, level, `${id} : ${byId(audit, id).text}`);
  assert.match(byId(audit, 'C1').text, /Gérer le serveur/);
  assert.doesNotMatch(byId(audit, 'C1').text, /Envoyer/);
  assert.match(byId(audit, 'C3').details.join(), /evilbot/);
  assert.doesNotMatch(byId(audit, 'C3').details.join(), /goodbot/, 'bot de confiance signalé');
  assert.ok(byId(audit, 'C4').details.length <= 15);
  assert.match(byId(audit, 'C11').details.join(), /top/);
  assert.match(byId(audit, 'C12').details.join(), /Salon introuvable/);
  // Corrections proposées.
  assert.deepEqual(audit.fixes.map((f) => f.id).sort(), ['default_notifications', 'everyone_overwrites', 'everyone_perms', 'explicit_filter', 'mentionable_roles', 'safety_alerts', 'verification_level'].sort());
  assert.equal(audit.fixes.find((f) => f.id === 'safety_alerts').channelId, 'alerts');
  assert.deepEqual(audit.fixes.find((f) => f.id === 'everyone_perms').bits.sort(), ['ManageGuild', 'MentionEveryone']);
  assert.ok(audit.score < 50);
  // C10 hors communauté : information seulement ; C9 sous 1 000 membres : OK.
  const small = A.auditSecurity(guildOf({ props: { defaultMessageNotifications: 0, memberCount: 200 } }), cfgOf(), {});
  assert.equal(byId(small, 'C9').level, 'ok');
  assert.equal(byId(small, 'C10').level, 'info');
});

test('plans de correction : jamais un rôle au niveau ou au-dessus du bot, ni un rôle géré ; 10 rôles, 50 salons par clic', () => {
  const roles = [
    { id: 'high', position: 15, mentionable: true, count: 80 },
    { id: 'equal', position: 10, mentionable: true, count: 80 },
    { id: 'managed', position: 2, mentionable: true, managed: true, count: 80 },
    ...Array.from({ length: 14 }, (_, i) => ({ id: `low${i}`, position: 1 + (i % 8), mentionable: true, count: 51 + i })),
  ];
  const channels = Array.from({ length: 70 }, (_, i) => ({ id: `c${i}`, position: i, overwrites: [{ id: G, allow: P.MentionEveryone }] }));
  const g = guildOf({ roles, channels });
  const audit = A.auditSecurity(g, cfgOf(), {});
  const plan = audit.fixes.find((f) => f.id === 'mentionable_roles');
  assert.equal(plan.roleIds.length, 10);
  for (const id of ['high', 'equal', 'managed']) assert.ok(!plan.roleIds.includes(id), id);
  const ow = audit.fixes.find((f) => f.id === 'everyone_overwrites');
  assert.equal(ow.items.length, 50);
  assert.equal(ow.remaining, 20);
  assert.ok(byId(audit, 'C2').details.length <= 10);
  // Bot sans « Gérer les rôles » : pas de correction proposée (seulement le contrôle).
  const weak = A.auditSecurity(guildOf({ botPerms: P.ViewChannel | P.SendMessages, roles, channels }), cfgOf(), {});
  assert.equal(weak.fixes.find((f) => f.id === 'mentionable_roles'), undefined);
  assert.equal(byId(weak, 'C5').level, 'warn');
  // @everyone avec une permission que le bot n'a pas : pas de correction (Discord le refuserait).
  const noBits = A.auditSecurity(guildOf({ everyonePerms: P.BanMembers, botPerms: P.ManageRoles }), cfgOf(), {});
  assert.equal(noBits.fixes.find((f) => f.id === 'everyone_perms'), undefined);
  // fixPlan : inconnu ou hérité → null ; recalculé.
  assert.equal(A.fixPlan(g, cfgOf(), 'constructor'), null);
  assert.equal(A.fixPlan(g, cfgOf(), 'inconnu'), null);
  assert.equal(A.fixPlan(g, cfgOf(), 'mentionable_roles').id, 'mentionable_roles');
});

test('score : borné (0-100), stable, pondéré ; info non compté', () => {
  assert.deepEqual(A.scoreOf([]), { score: 100, grade: A.gradeOf(100) });
  assert.equal(A.scoreOf([{ id: 'C1', level: 'fail' }]).score, 0);
  assert.equal(A.scoreOf([{ id: 'C8', level: 'warn' }]).score, 50);
  assert.equal(A.scoreOf([{ id: 'C1', level: 'fail' }, { id: 'C8', level: 'ok' }]).score, 25, 'C1 pèse 3');
  assert.equal(A.scoreOf([{ id: 'C10', level: 'info' }, { id: 'C8', level: 'ok' }]).score, 100);
  const g = guildOf({ everyonePerms: P.Administrator });
  const a = A.auditSecurity(g, cfgOf(), {});
  const b = A.auditSecurity(g, cfgOf(), {});
  assert.equal(a.score, b.score);
  assert.ok(a.score >= 0 && a.score <= 100);
  for (const s of [0, 34, 35, 54, 55, 74, 75, 89, 90, 100]) assert.ok(['A', 'B', 'C', 'D', 'E'].includes(A.gradeOf(s).letter));
  assert.equal(A.gradeOf(90).letter, 'A');
  assert.equal(A.gradeOf(34).letter, 'E');
});

test('C12 = analyze() : mêmes points du diagnostic, rien de dupliqué ; groupe « Secur » d\'analyze()', () => {
  const g = guildOf({ botPerms: P.ViewChannel | P.SendMessages | P.EmbedLinks, botPosition: 1, roles: [{ id: 'r', position: 5 }] });
  const cfg = cfgOf({ logChannels: { moderation: 'gone' } });
  const groups = diagnostics.analyze(g, cfg);
  const bad = groups.flatMap((x) => x.checks).filter((c) => c.level === 'warn' || c.level === 'fail');
  const c12 = byId(A.auditSecurity(g, cfg, { groups }), 'C12');
  assert.equal(c12.level, 'fail');
  assert.match(c12.text, new RegExp(`^${bad.length} point`));
  assert.deepEqual(c12.details, bad.slice(0, 10).map((c) => c.text));
  // Groupe Secur : absent tant que tout est coupé ; présent avec un module actif.
  assert.ok(!groups.some((x) => x.label === 'Secur'));
  const on = cfgOf({ secur: { modules: { ...defaultGuildConfig.secur.modules, channelDelete: { mode: 'on', punish: 'ban', undo: true } }, raidPingRoleId: 'ping' } });
  g.roles.cache.set('ping', { id: 'ping', mentionable: false, toString: () => '<@&ping>' });
  const secur = diagnostics.analyze(g, on).find((x) => x.label === 'Secur');
  const text = secur.checks.map((c) => `${c.level}:${c.text}`).join('\n');
  for (const re of [/warn:Voir les logs du serveur/, /warn:Gérer les salons/, /warn:Bannir des membres/, /warn:Raid ping : <@&ping> n'est pas mentionnable/]) assert.match(text, re);
  const admin = diagnostics.analyze(guildOf(), on).find((x) => x.label === 'Secur');
  assert.equal(admin.checks[0].level, 'ok');
  assert.deepEqual([...A.securRequirements(on).keys()].sort(), ['BanMembers', 'ManageChannels', 'ManageRoles', 'ViewAuditLog']);
});

test('/diagnostics : salon de transcripts où je ne peux pas « Joindre des fichiers » signalé (une fois par salon)', () => {
  const write = P.ViewChannel | P.SendMessages | P.EmbedLinks;
  const g = guildOf({ botPerms: write, channels: [{ id: 'tr', botPerms: write }, { id: 'ok', botPerms: write | P.AttachFiles }] });
  const checks = (cfg) => diagnostics.analyze(g, cfg).flatMap((x) => x.checks).filter((c) => /^Transcripts \(/.test(c.text));
  assert.equal(checks(cfgOf({ tickets: { logChannel: 'tr' }, modmail: { logChannel: 'tr' } })).length, 1);
  assert.match(checks(cfgOf({ tickets: { logChannel: 'tr' }, modmail: { logChannel: 'tr' } }))[0].text, /tickets et ModMail/);
  assert.equal(checks(cfgOf({ tickets: { logChannel: 'tr' } }))[0].level, 'warn');
  assert.equal(checks(cfgOf({ tickets: { logChannel: 'ok' }, modmail: { logChannel: 'ok' } })).length, 0);
});

// ---------------------------------------------------------------- boutons de /diagnostics

function interactionOf(guild, { admin = true, manageGuild = true } = {}) {
  const calls = { update: [], editReply: [], deferUpdate: 0 };
  const flags = (admin ? P.Administrator : 0n) | (manageGuild ? P.ManageGuild : 0n);
  return {
    calls,
    guild,
    guildId: guild.id,
    user: { id: '100000000000000099', tag: 'admin#0001', toString: () => '<@100000000000000099>' },
    memberPermissions: new PermissionsBitField(flags),
    async update(p) { calls.update.push(p); },
    async deferUpdate() { calls.deferUpdate += 1; },
    async editReply(p) { calls.editReply.push(p); },
  };
}

const idsOf = (p) => (p.components ?? []).map(json).flatMap((r) => r.components.map((c) => c.custom_id));

test('/diagnostics : bouton Audit réservé aux administrateurs ; audit (deferUpdate), confirmation, correction, réponse PUIS log', async () => {
  const g = guildOf({ everyonePerms: P.ManageGuild });
  const order = [];
  g.roles.everyone.setPermissions = async (perms, reason) => {
    order.push(['setPermissions', perms.bitfield, reason]);
    g.roles.everyone.permissions = new PermissionsBitField(perms);
  };
  g.members.fetch = async () => order.push(['fetch']);
  const cfg = cfgOf();
  const client = { services: { config: { get: () => cfg }, logging: { send: async (...a) => void order.push(['log', a[1], a[4]?.event]) } } };
  // Rendu : bouton Audit seulement pour un administrateur.
  assert.deepEqual(idsOf(diagnostics.render(g, cfg)), ['cmd:diagnostics:rerun']);
  assert.ok(idsOf(diagnostics.render(g, cfg, { admin: true })).includes('cmd:diagnostics:audit'));
  // Sans Administrateur (même avec « Gérer le serveur ») : refusé partout, rien n'est fait.
  for (const name of ['audit', 'fix', 'fixok']) {
    const i = interactionOf(g, { admin: false });
    await assert.rejects(diagnostics.buttons[name](i, client, ['everyone_perms']), { name: 'UserError' }, name);
    assert.equal(i.calls.update.length + i.calls.editReply.length + i.calls.deferUpdate, 0);
  }
  // Audit : deferUpdate d'abord, lecture des membres, 6 champs et 5 rangées au plus.
  const audit = interactionOf(g);
  await diagnostics.buttons.audit(audit, client);
  assert.equal(audit.calls.deferUpdate, 1);
  const view = audit.calls.editReply[0];
  assert.ok(json(view.embeds[0]).fields.length <= 6);
  assert.ok(view.components.length <= 5);
  assert.ok(idsOf(view).includes('cmd:diagnostics:fix:everyone_perms'));
  for (const id of idsOf(view)) assert.equal(typeof diagnostics.buttons[id.split(':')[2]], 'function', id);
  // Confirmation : changements exacts, rien n'est modifié.
  const confirm = interactionOf(g);
  await diagnostics.buttons.fix(confirm, client, ['everyone_perms']);
  assert.match(JSON.stringify(json(confirm.calls.update[0].embeds[0])), /retirer « Gérer le serveur »/);
  assert.ok(idsOf(confirm.calls.update[0]).includes('cmd:diagnostics:fixok:everyone_perms'));
  assert.equal(order.filter(([k]) => k === 'setPermissions').length, 0);
  await assert.rejects(diagnostics.buttons.fix(interactionOf(g), client, ['constructor']), /inconnue/);
  // Correction : raison d'audit, réponse puis log server.securityFix.
  const ok = interactionOf(g);
  ok.editReply = async (p) => void order.push(['editReply', p]);
  await diagnostics.buttons.fixok(ok, client, ['everyone_perms']);
  const kinds = order.map(([k]) => k).filter((k) => k !== 'fetch');
  assert.deepEqual(kinds, ['setPermissions', 'editReply', 'log']);
  const set = order.find(([k]) => k === 'setPermissions');
  assert.equal(set[1] & P.ManageGuild, 0n);
  assert.match(set[2], /^Audit de sécurité par admin#0001/);
  assert.deepEqual(order.find(([k]) => k === 'log').slice(1), ['server', 'securityFix']);
  // Plus rien à corriger : aucune requête.
  const again = interactionOf(g);
  await diagnostics.buttons.fixok(again, client, ['everyone_perms']);
  assert.equal(order.filter(([k]) => k === 'setPermissions').length, 1);
  assert.match(JSON.stringify(json(again.calls.editReply[0].embeds[0])), /Déjà corrigé/);
});

test('/diagnostics : correction refusée si le bot n\'a pas la permission ; verrou par serveur (un seul clic à la fois)', async () => {
  const g = guildOf({ everyonePerms: P.ManageGuild, botPerms: P.ViewChannel | P.SendMessages | P.EmbedLinks });
  const cfg = cfgOf();
  const client = { services: { config: { get: () => cfg }, logging: { send: async () => true } } };
  await assert.rejects(diagnostics.buttons.fixok(interactionOf(g), client, ['everyone_perms']), /Gérer les rôles/);
  // Verrou : deux clics simultanés → une seule correction.
  const g2 = guildOf({ props: { verificationLevel: 0 } });
  let calls = 0;
  g2.setVerificationLevel = async (level) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    g2.verificationLevel = level;
  };
  const results = await Promise.allSettled([diagnostics.buttons.fixok(interactionOf(g2), client, ['verification_level']), diagnostics.buttons.fixok(interactionOf(g2), client, ['verification_level'])]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && /déjà en cours/.test(r.reason.message)).length, 1);
  assert.equal(g2.verificationLevel, 2);
});

test('applyFix : surcharges (édition neutre), rôles mentionnables revérifiés, paramètres du serveur', async () => {
  const edits = [];
  const g = guildOf({ roles: [{ id: 'r1', position: 3, mentionable: true }, { id: 'r2', position: 12, mentionable: true }] });
  g.channels.cache.set('c1', { id: 'c1', permissionOverwrites: { edit: async (id, perms, o) => void edits.push(['ow', id, perms, o.reason]) } });
  for (const r of g.roles.cache.values()) r.setMentionable = async (v, reason) => void edits.push(['role', r.id, v, reason]);
  g.setExplicitContentFilter = async (v, reason) => void edits.push(['filter', v, reason]);
  g.setDefaultMessageNotifications = async (v) => void edits.push(['notif', v]);
  g.setSafetyAlertsChannel = async (v) => void edits.push(['safety', v]);
  const r1 = await diagnostics.applyFix(g, { id: 'everyone_overwrites', items: [{ channelId: 'c1', bits: ['ManageWebhooks'] }, { channelId: 'gone', bits: ['ManageWebhooks'] }] }, 'raison');
  assert.deepEqual(edits[0], ['ow', G, { ManageWebhooks: null }, 'raison']);
  assert.deepEqual([r1.done, r1.failed], [1, 1]);
  const r2 = await diagnostics.applyFix(g, { id: 'mentionable_roles', roleIds: ['r1', 'r2', 'botrole'] }, 'raison');
  assert.deepEqual(edits.filter(([k]) => k === 'role').map(([, id]) => id), ['r1'], 'rôle au-dessus du bot ou géré modifié');
  assert.deepEqual([r2.done, r2.failed], [1, 2]);
  await diagnostics.applyFix(g, { id: 'explicit_filter' }, 'raison');
  await diagnostics.applyFix(g, { id: 'default_notifications' }, 'raison');
  await diagnostics.applyFix(g, { id: 'safety_alerts', channelId: 'c1' }, 'raison');
  assert.deepEqual(edits.slice(-3).map((e) => e.slice(0, 2)), [['filter', 2], ['notif', 1], ['safety', 'c1']]);
  await assert.rejects(diagnostics.applyFix(g, { id: 'toString' }, 'r'), /inconnue/);
});
