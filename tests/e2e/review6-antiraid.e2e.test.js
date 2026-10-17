'use strict';

/**
 * Revue n° 6, AntiRaid, bout en bout (vrai discord.js, faux Discord) : raid de comptes récents,
 * alertes perdues, whitelist, suppressions faites via le bot, auteur parti, journal des réglages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
/** Cartes de l'AntiRaid liées aux arrivées (hors log « Nouveau membre » des logs Membres). */
const ALERTS = /Nouveau membre (banni|expulsé)|Vague d'arrivées|Raid en cours|Sanction automatique impossible/;

/** Raid de `n` comptes créés il y a quelques heures (préréglage « Strict », salon d'alerte distinct des logs). */
async function freshRaid(h, n) {
  for (let i = 0; i < n; i += 1) {
    const u = h.addUser(`Frais${i}`, { ageDays: 0.2 });
    h.fake.members.set(u.id, { user: u, roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0, pending: false });
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...h.fake.members.get(u.id), guild_id: h.guild.id }, `raider ${i}`);
  }
  await h.settle({ timeout: 30_000 });
}

async function strictRaidHarness() {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { enabled: true, action: 'lockdown', joinThreshold: 6, joinWindowSeconds: 10, minAccountAgeDays: 7, antiBot: true, newAccountAction: 'ban', alertChannel: IDS.channels.staff } });
  return h;
}

test('R29 : raid de comptes récents bannis → vague détectée, lockdown, alertes regroupées', async () => {
  const h = await strictRaidHarness();
  try {
    const mark = h.fake.messageLog.length;
    await freshRaid(h, 40);
    const raiders = [...h.fake.members.values()].filter((m) => /^frais/.test(m.user?.username ?? ''));
    assert.equal(raiders.length, 0, 'raiders encore présents');
    const alerts = botMessages(h, mark, titled(ALERTS));
    assert.ok(alerts.length <= 12, `une alerte par arrivant : ${alerts.length} messages`);
    assert.ok(botMessages(h, mark, titled(/Vague d'arrivées détectée/)).length >= 1, 'vague jamais détectée');
    assert.ok(h.client.services.lockdown.status(h.guild) > 0, 'aucun lockdown');
    // Bannissements regroupés : annoncés dans l'alerte de vague ou dans la carte récapitulative de la minute.
    await h.client.services.antiraid.flushDigest(h.guild.id);
    await h.settle();
    // Comptées dans le salon d'alerte (chaque carte est aussi copiée dans les logs sécurité).
    const inAlerts = (m) => m.channel_id === IDS.channels.staff;
    const cards = botMessages(h, mark, titled(/Vague d'arrivées détectée|récapitulatif/)).filter(inAlerts);
    const grouped = cards.flatMap((m) => m.embeds[0].fields ?? []).filter((f) => /Comptes récents/.test(f.name))
      .reduce((n, f) => n + Number(/\*\*(\d+)\*\* banni/.exec(f.value)?.[1] ?? 0), 0);
    const single = botMessages(h, mark, titled(/Nouveau membre banni/)).filter(inAlerts).length;
    assert.equal(grouped + single, 40, `bannissements annoncés : ${single} un par un + ${grouped} regroupés`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R29 : raid de comptes récents dont le bannissement échoue → alerte d\'échec, vague et lockdown', async () => {
  const h = await strictRaidHarness();
  try {
    h.fake.inject({ method: 'PUT', route: /\/bans\// }, { status: 403, code: 50013, times: 10_000 });
    const mark = h.fake.messageLog.length;
    await freshRaid(h, 40);
    assert.ok(botMessages(h, mark, titled(/Sanction automatique impossible/)).length >= 1, 'échec silencieux');
    assert.ok(botMessages(h, mark, titled(/Vague d'arrivées détectée/)).length >= 1, 'vague jamais détectée');
    assert.ok(h.client.services.lockdown.status(h.guild) > 0, 'raiders présents sans lockdown');
    assert.ok(botMessages(h, mark, titled(ALERTS)).length <= 12, 'alertes non regroupées');
  } finally {
    await h.close();
  }
});

/** Messages du bot dans ses MP avec `userId`. */
const dmsTo = (h, mark, userId) => botMessages(h, mark, (m) => h.fake.dms.get(m.channel_id)?.recipients?.[0]?.id === userId);

test('R30 : nuke qui commence par supprimer #logs (alerte + logs sécurité) → alerte en MP au propriétaire', async () => {
  const h = await createHarness();
  try {
    h.configureAll(); // salon d'alerte = logs sécurité = #logs
    h.configure({ antiraid: { channelDeleteThreshold: 3, punishExecutor: 'strip' } });
    const mark = h.fake.messageLog.length;
    for (const key of ['logs', 'rules', 'announcements', 'staff']) {
      const id = IDS.channels[key];
      const ch = h.fake.channels.get(id);
      h.fake.channels.delete(id);
      h.fake.dispatchNow('CHANNEL_DELETE', ch, `suppression de #${ch.name}`);
      await h.settle();
      await h.auditEntry({ action_type: 12, target_id: id, user_id: IDS.users.mod });
    }
    await h.settle({ timeout: 10_000 });
    assert.equal(h.client.services.config.get(h.guild.id).logChannels.security, null, 'logs sécurité débranchés');
    const dms = dmsTo(h, mark, IDS.users.owner);
    assert.equal(dms.length, 1, 'alerte de destruction perdue sans repli');
    assert.match(dms[0].embeds[0].title, /Activité destructrice/);
    assert.match(dms[0].content, /ni le salon d'alerte ni les logs sécurité/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R30 : catégorie Sécurité mise en pause dans /logs → la vague d\'arrivées arrive quand même au propriétaire', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ logs: { disabledCategories: ['security'] }, antiraid: { joinThreshold: 3, minAccountAgeDays: 0, action: 'lockdown' } });
    const mark = h.fake.messageLog.length;
    for (let i = 0; i < 3; i += 1) await h.memberJoin(h.addUser(`Vague${i}`));
    await h.settle();
    assert.equal(botMessages(h, mark, titled(/Vague d'arrivées/)).filter((m) => !h.fake.dms.has(m.channel_id)).length, 0, 'pause ignorée');
    const dms = dmsTo(h, mark, IDS.users.owner);
    assert.equal(dms.length, 1, 'alerte de vague coupée par la pause des logs');
    assert.match(dms[0].embeds[0].title, /Vague d'arrivées/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/** Rôle « Server Booster » géré par Discord, créé dans le faux serveur. */
async function boosterRole(h) {
  const { nextId } = require('./lib/ids');
  const id = nextId();
  const role = { id, name: 'Server Booster', color: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, hoist: false, icon: null, unicode_emoji: null, position: 2, permissions: '0', managed: true, mentionable: false, flags: 0, tags: { premium_subscriber: null } };
  h.fake.roles.set(id, role);
  h.fake.dispatchNow('GUILD_ROLE_CREATE', { guild_id: h.guild.id, role }, 'rôle Booster');
  await h.settle();
  return id;
}

/** Le modérateur booste (Discord lui donne le rôle géré) puis supprime 6 salons. */
async function boosterNukes(h, boosterId) {
  const { nextId } = require('./lib/ids');
  const mod = h.fake.members.get(IDS.users.mod);
  mod.roles = [...mod.roles, boosterId];
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { guild_id: h.guild.id, ...mod }, 'boost du modo');
  await h.settle();
  for (let i = 0; i < 6; i += 1) await h.auditEntry({ action_type: 12, target_id: nextId(), user_id: IDS.users.mod });
  return h.fake.calls.some((c) => c.method === 'PUT' && c.route.includes(`/bans/${IDS.users.mod}`));
}

test('R31 : le tableau de bord refuse le rôle Booster ; un booster qui nuke est sanctionné', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { channelDeleteThreshold: 3, punishExecutor: 'ban' } });
    const boosterId = await boosterRole(h);
    const dash = await h.slash('antiraid', [], { as: 'admin' });
    await h.click(h.messagesOf(dash)[0], 'cmd:antiraid:nav', { as: 'admin', values: ['whitelist'] });
    const pick = await h.click(h.messagesOf(dash)[0], 'cmd:antiraid:wlroles', { as: 'admin', values: [boosterId] });
    assert.ok(h.isError(pick), 'rôle géré accepté par le tableau de bord');
    assert.deepEqual(h.client.services.config.get(h.guild.id).whitelist.roles, []);
    assert.equal(await boosterNukes(h, boosterId), true, 'booster immunisé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R31 : rôle Booster déjà whitelisté (ancienne configuration) → aucune immunité', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ antiraid: { channelDeleteThreshold: 3, punishExecutor: 'ban' } });
    const boosterId = await boosterRole(h);
    h.configure({ whitelist: { roles: [boosterId] } });
    assert.equal(await boosterNukes(h, boosterId), true, 'booster immunisé par une ancienne whitelist');
  } finally {
    await h.close();
  }
});

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];

/** Espionne les signalements faits à l'AntiRaid au nom d'un humain (pas du bot). */
function spyReports(h) {
  const antiraid = h.client.services.antiraid;
  const reports = [];
  const original = antiraid.handleDestructive.bind(antiraid);
  antiraid.handleDestructive = async (guild, actorId, type, extra) => {
    if (actorId !== h.client.user.id) reports.push({ actorId, type });
    return original(guild, actorId, type, extra);
  };
  return reports;
}

test('R101 : /channel supprimer signale la suppression à l\'AntiRaid même si la réponse échoue', async () => {
  const { throwawayChannel } = require('./lib/overrides');
  const h = await createHarness();
  try {
    h.configureAll();
    const reports = spyReports(h);
    const id = await throwawayChannel(h, 'cible');
    const rec = await h.slash('channel', sub('supprimer', [opt('salon', 7, id)]), { as: 'admin' });
    // Message de confirmation disparu entre-temps : la réponse finale échoue (10008).
    h.fake.inject({ method: 'PATCH', route: /^\/webhooks\/\d+\/[^/]+\/messages\/(@|%40)original$/ }, { status: 404, code: 10008, message: 'Unknown Message', times: 1 });
    await h.confirm(rec);
    await h.settle();
    assert.ok(!h.fake.channels.has(id), 'salon non supprimé');
    assert.deepEqual(reports.filter((r) => r.type === 'channelDelete'), [{ actorId: IDS.users.admin, type: 'channelDelete' }], 'suppression invisible pour l\'AntiRaid');
  } finally {
    await h.close();
  }
});

test('R101 : /role delete sans confirmation acquitte avant la suppression (limite de débit) et la signale', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    h.configure({ moderation: { confirmDangerous: false } });
    const reports = spyReports(h);
    // Limite de débit sur la suppression (fréquente pendant un nuke) ; Discord invalide toute
    // interaction acquittée après 3 s (10062).
    const start = Date.now();
    h.fake.inject({ method: 'DELETE', route: /^\/guilds\/\d+\/roles\/\d+$/ }, { status: 429, retryAfter: 3_200, times: 1 });
    h.fake.inject({ match: (c) => c.method === 'POST' && /^\/interactions\/\d+\/[^/]+\/callback$/.test(c.route) && Date.now() - start > 3_000 }, { status: 404, code: 10062, message: 'Unknown interaction', times: 5 });
    const rec = await h.slash('role', sub('delete', [opt('role', 8, IDS.roles.notif)]), { as: 'admin' });
    await h.waitFor(() => !h.fake.roles.has(IDS.roles.notif), { timeout: 6_000 });
    await h.settle({ timeout: 6_000 });
    assert.ok(!h.fake.roles.has(IDS.roles.notif), 'rôle non supprimé');
    assert.ok(rec.ackType != null && rec.ackedAt - rec.createdAt < 3_000, 'interaction acquittée trop tard (10062)');
    assert.deepEqual(reports.filter((r) => r.type === 'roleDelete'), [{ actorId: IDS.users.admin, type: 'roleDelete' }], 'suppression invisible pour l\'AntiRaid');
    assert.match(h.replyText(rec), /Rôle supprimé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R34 : désactivation et whitelist depuis /antiraid et /whitelist journalisées (logs sécurité, MP au propriétaire)', async () => {
  const h = await createHarness();
  try {
    h.configureAll();
    const mark = h.fake.messageLog.length;
    const dash = await h.slash('antiraid', [], { as: 'admin' });
    await h.click(h.messagesOf(dash)[0], 'cmd:antiraid:toggle:off', { as: 'admin' });
    assert.equal(h.client.services.config.get(h.guild.id).antiraid.enabled, false);
    await h.slash('whitelist', sub('add', [opt('utilisateur', 6, IDS.users.member)]), { as: 'admin' });
    await h.settle();
    const logs = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && titled(/AntiRaid désactivé|Réglages AntiRaid/)(m));
    assert.equal(logs.length, 2, 'désarmement sans trace');
    assert.match(JSON.stringify(logs[0].embeds[0]), new RegExp(IDS.users.admin));
    assert.match(JSON.stringify(logs[1].embeds[0]), new RegExp(IDS.users.member));
    const dms = dmsTo(h, mark, IDS.users.owner);
    assert.equal(dms.length, 1, 'propriétaire non prévenu de la désactivation');
    assert.match(dms[0].content, /désactivé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
