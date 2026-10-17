'use strict';

/**
 * Bout en bout : régressions de la revue n° 6 (AutoMod) sur le vrai discord.js — mots interdits
 * piégés (ReDoS), liens et invitations déguisés, quarantaine, AutoMod natif, boutons de levée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHarness, IDS } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });

/** AutoMod réduit aux filtres donnés (les autres désactivés). */
function onlyFilters(h, keys, extra = {}) {
  const filters = Object.fromEntries(Object.keys(h.client.services.config.get(h.guild.id).automod.filters).map((k) => [k, { enabled: keys.includes(k) }]));
  h.configure({ antiraid: { enabled: false }, automod: { enabled: true, filters, newMembers: { enabled: false }, ...extra } });
}

/** Le message d'un membre ordinaire est-il supprimé par le bot ? */
async function isDeleted(h, content, channel = 'general') {
  const mark = h.fake.calls.length;
  const msg = await h.userMessage({ as: 'member', channel, content });
  await h.settle();
  return h.fake.calls.slice(mark).some((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${msg.id}`));
}

/** Plus long blocage de la boucle d'événements pendant `fn`. */
async function maxLoopBlock(fn) {
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return Math.max(max, performance.now() - last);
}

test('R38 : « k.k.k » ajouté par le formulaire, message piégé d\'un membre — le bot ne gèle plus', async () => {
  const h = await createHarness();
  h.configureAll();
  onlyFilters(h, []);
  try {
    const home = await h.slash('automod');
    const lists = await h.click(h.messagesOf(home)[0], 'cmd:automod:nav', { values: ['lists'] });
    const open = await h.click(h.messagesOf(lists)[0], 'cmd:automod:list:words');
    await h.submitModal(open, { add: 'k.k.k\na a a a a a a a a a', remove: '' });
    const cfg = h.client.services.config.get(h.guild.id).automod.filters.badWords;
    assert.ok(cfg.words.includes('k.k.k') && cfg.words.includes('a a a a a a a a a a'), JSON.stringify(cfg.words));
    assert.equal(cfg.enabled, true);

    let deleted = null;
    const block = await maxLoopBlock(async () => {
      deleted = await isDeleted(h, `${'k'.repeat(1999)}b`);
    });
    assert.equal(deleted, false);
    // Avant le correctif : 7 s de boucle bloquée (tous les serveurs figés).
    assert.ok(block < 500, `boucle d'événements bloquée ${Math.round(block)} ms`);
    assert.equal(await isDeleted(h, 'espèce de k k k'), true, 'le mot composé est toujours détecté');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R39 / R40 : liens déguisés (« ?@ », point idéographique, adresse IP) supprimés ; /afk les refuse', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    // Anti-arnaques seul : le faux Nitro est vu derrière « ?@discord.com » ou « 。 ».
    onlyFilters(h, ['antiPhishing']);
    for (const url of ['https://dlscord-gift.ru/claim', 'https://dlscord-gift.ru?@discord.com/claim', 'https://dlscord-gift.ru#@discord.com/claim',
      'https://dlscord-gift.ru\\@discord.com/claim', 'https://dlscord-gift。ru/claim', 'https://dlscord-gift．ru/claim', 'http://45.13.227.9/discord-nitro']) {
      assert.equal(await isDeleted(h, `Nitro gratuit !! ${url} @everyone`), true, `arnaque non supprimée : ${url}`);
    }
    assert.equal(await isDeleted(h, 'le salon des annonces : https://discord.com/channels/1/2'), false, 'lien Discord légitime');

    // Anti-liens seul : n'importe quel domaine caché derrière discord.com, ou une adresse IP.
    onlyFilters(h, ['antiLink']);
    for (const content of ['regarde https://evil.ru?@discord.com/login', 'regarde https://evil%2eru/login', 'regarde http://755623689/', 'regarde http://[2a01:4f8::1]/']) {
      assert.equal(await isDeleted(h, content), true, `lien non supprimé : ${content}`);
    }
    assert.equal(await isDeleted(h, 'regarde https://discord.com\\@evil.ru (le navigateur reste sur discord.com)'), false);

    // /afk : la raison passe par les mêmes filtres.
    const rec = await h.slash('afk', [opt('raison', 3, 'ici https://evil.ru?@discord.com/x')], { as: 'member' });
    assert.equal(h.isError(rec), true, 'raison avec lien déguisé acceptée');
    assert.equal(h.client.repositories.afk.get(h.guild.id, IDS.users.member) ?? null, null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R41 : invitations encodées supprimées par l\'anti-invitations', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    onlyFilters(h, ['antiInvite']);
    for (const url of ['https://discord.gg/./raidzone', 'https://discord.com/x/../invite/raidzone', 'https://disc%6Frd.gg/raidzone',
      'https://discord.gg\\raidzone', 'https://discord。gg/raidzone']) {
      assert.equal(await isDeleted(h, `rejoins ${url}`), true, `invitation non supprimée : ${url}`);
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const hasRole = (h, userId, roleId) => Boolean(h.fake.members.get(userId)?.roles.includes(roleId));

/** Quarantaine d'un compte piraté (rôles retirés) sur le membre « target » ; renvoie le log. */
async function quarantineTarget(h) {
  h.configure({ antiraid: { enabled: false }, levels: { enabled: false }, automod: { enabled: true, notify: 'none', escalation: { enabled: false }, newMembers: { enabled: false }, filters: {
    antiHacked: { enabled: true, removeRoles: true, scamScore: 5, channels: 3, action: 'quarantine', duration: '1d', purgeMinutes: 10 },
  } } });
  const mark = h.fake.messageLog.length;
  await h.userMessage({ as: 'target', content: 'Nitro gratuit !! https://dlscord-gift.ru/claim @everyone' });
  await h.settle();
  const log = h.fake.messageLog.slice(mark).map((id) => h.message(id)).find((m) => m?.embeds?.[0]?.title?.includes('quarantaine'));
  assert.ok(log, 'quarantaine non posée');
  return log;
}

test('R42 : levée de quarantaine — un rôle temporaire ou un mute arrivé à échéance pendant la quarantaine n\'est pas rendu', async () => {
  const h = await createHarness();
  h.configureAll();
  const T = IDS.users.target;
  try {
    await h.slash('role', sub('temporaire', [opt('membre', 6, T), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '2h')]));
    await h.slash('mute', [opt('membre', 6, T), opt('duree', 3, '1h')]);
    const mutedRoleId = h.client.services.config.get(h.guild.id).moderation.mutedRoleId;
    assert.ok(hasRole(h, T, IDS.roles.gamer) && hasRole(h, T, mutedRoleId));
    const log = await quarantineTarget(h);
    assert.equal(hasRole(h, T, IDS.roles.gamer) || hasRole(h, T, mutedRoleId), false, 'rôles non retirés par la quarantaine');

    // Les deux échéances passent pendant la quarantaine (vrai scheduler).
    const db = h.client.database.db;
    db.prepare('UPDATE temp_roles SET expires_at = ? WHERE active = 1').run(Date.now() - 1000);
    db.prepare("UPDATE sanctions SET expires_at = ? WHERE active = 1 AND type = 'mute'").run(Date.now() - 1000);
    await h.client.services.scheduler.tick();
    await h.settle();

    const lift = buttonsOf(log).find((c) => c.custom_id.startsWith('cmd:automod:qlift:'));
    const rec = await h.click(log, lift.custom_id, { as: 'admin' });
    await h.settle();
    assert.equal(hasRole(h, T, IDS.roles.gamer), false, 'rôle temporaire expiré rendu définitivement');
    assert.equal(hasRole(h, T, mutedRoleId), false, 'rôle muet d\'un mute terminé rendu définitivement');
    const text = h.replyText(rec);
    assert.match(text, /Quarantaine levée/);
    assert.match(text, /échéance/i, 'les rôles écartés sont signalés');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R42 : levée de quarantaine — rôle temporaire et mute toujours en cours rendus (le scheduler les retirera)', async () => {
  const h = await createHarness();
  h.configureAll();
  const T = IDS.users.target;
  try {
    await h.slash('role', sub('temporaire', [opt('membre', 6, T), opt('role', 8, IDS.roles.gamer), opt('duree', 3, '2h')]));
    await h.slash('mute', [opt('membre', 6, T), opt('duree', 3, '1h')]);
    const mutedRoleId = h.client.services.config.get(h.guild.id).moderation.mutedRoleId;
    const log = await quarantineTarget(h);
    const lift = buttonsOf(log).find((c) => c.custom_id.startsWith('cmd:automod:qlift:'));
    await h.click(log, lift.custom_id, { as: 'admin' });
    await h.settle();
    assert.equal(hasRole(h, T, IDS.roles.gamer), true);
    assert.equal(hasRole(h, T, mutedRoleId), true);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R44 : message publié via une application installée par le membre — analysé et attribué au membre', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    onlyFilters(h, ['badWords'], { notify: 'none' });
    h.configure({ automod: { filters: { badWords: { enabled: true, words: ['connard'], action: 'warn' } } } });
    const app = h.addUser('AppExterne', { bot: true });
    const member = h.fake.users.get(IDS.users.member);
    const viaApp = async (content, owners) => {
      const mark = h.fake.calls.length;
      const logMark = h.fake.messageLog.length;
      const msg = await h.userMessage({ as: app.id, content, extra: {
        webhook_id: app.id, application_id: app.id,
        interaction_metadata: { id: String(BigInt(app.id) + 1n), type: 2, user: member, authorizing_integration_owners: owners },
      } });
      await h.settle();
      const deleted = h.fake.calls.slice(mark).some((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${msg.id}`));
      const logs = h.fake.messageLog.slice(logMark).map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs);
      return { deleted, logs };
    };
    // Application installée sur le compte du membre (pas sur le serveur) : le texte est le sien.
    const r = await viaApp('sale connard', { 1: IDS.users.member });
    assert.equal(r.deleted, true, 'message via une application externe non analysé');
    const log = r.logs.find((m) => /Message filtré/.test(m.embeds?.[0]?.title ?? ''));
    assert.ok(log, 'pas de log AutoMod');
    assert.match(JSON.stringify(log.embeds), new RegExp(IDS.users.member), 'infraction non attribuée au membre');
    const warns = h.client.repositories.sanctions.listByUser(h.guild.id, IDS.users.member).filter((s) => s.type === 'warn');
    assert.equal(warns.length, 1, 'avertissement non attribué au membre');
    assert.equal(h.client.repositories.sanctions.listByUser(h.guild.id, app.id).length, 0);
    // Application installée par le serveur (son propre contenu) : jamais analysée.
    assert.equal((await viaApp('sale connard', { 0: h.guild.id, 1: IDS.users.member })).deleted, false);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R45 : listes de domaines et d\'invitations autorisés plafonnées (retraits toujours possibles)', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const openList = async (kind) => {
      const home = await h.slash('automod');
      const lists = await h.click(h.messagesOf(home)[0], 'cmd:automod:nav', { values: ['lists'] });
      return h.click(h.messagesOf(lists)[0], `cmd:automod:list:${kind}`);
    };
    const filters = () => h.client.services.config.get(h.guild.id).automod.filters;
    h.configure({ automod: { filters: { antiLink: { allowedDomains: Array.from({ length: 499 }, (_, i) => `site${i}.com`) } } } });
    let rec = await h.submitModal(await openList('domains'), { add: 'nouveau1.com\nnouveau2.com', remove: '' });
    assert.equal(h.isError(rec), true, 'liste de domaines non plafonnée');
    assert.match(h.replyText(rec), /500/);
    assert.equal(filters().antiLink.allowedDomains.length, 499);
    rec = await h.submitModal(await openList('domains'), { add: 'nouveau1.com', remove: '' });
    assert.equal(h.isError(rec), false);
    assert.equal(filters().antiLink.allowedDomains.length, 500);

    // Liste déjà trop longue (ancienne configuration) : un retrait reste possible.
    h.configure({ automod: { filters: { antiInvite: { allowedCodes: Array.from({ length: 600 }, (_, i) => `code${i}`) } } } });
    rec = await h.submitModal(await openList('invites'), { add: 'encore', remove: '' });
    assert.equal(h.isError(rec), true, 'liste d\'invitations non plafonnée');
    rec = await h.submitModal(await openList('invites'), { add: '', remove: 'code1' });
    assert.equal(h.isError(rec), false, 'retrait refusé sur une liste trop longue');
    assert.equal(filters().antiInvite.allowedCodes.length, 599);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R46 : AutoMod natif — double « Synchroniser » sans doublon, doublon existant supprimé, aucune règle AutoMod désactivé', async () => {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 5;
  try {
    h.configure({ automod: { enabled: true, filters: { badWords: { enabled: true, words: ['interdit', 'ancienmot'] } } } });
    const KW = 'Gadget · Mots interdits';
    const kw = () => [...h.fake.autoModRules.values()].filter((r) => r.name === KW);
    const rec = await h.slash('automod');
    const view = h.messagesOf(await h.click(h.messagesOf(rec)[0], 'cmd:automod:nav', { values: ['native'] }))[0];
    await Promise.all([h.click(view, 'cmd:automod:native:sync'), h.click(view, 'cmd:automod:native:sync', { as: 'owner' })]);
    await h.settle();
    assert.equal(kw().length, 1, `règle native en double : ${kw().length}`);

    // Doublon déjà présent (ancienne version) : supprimé à la synchronisation suivante.
    await h.guild.autoModerationRules.create({ name: KW, eventType: 1, triggerType: 1, triggerMetadata: { keywordFilter: ['ancienmot'] }, actions: [{ type: 1 }], enabled: true });
    assert.equal(kw().length, 2);
    h.configure({ automod: { filters: { badWords: { words: ['interdit'] } } } });
    await h.click(view, 'cmd:automod:native:sync');
    await h.settle();
    assert.deepEqual(kw().map((r) => r.trigger_metadata?.keyword_filter), [['interdit']], 'doublon non supprimé ou liste non mise à jour');

    // AutoMod désactivé : les règles natives sont retirées, et aucune n'est recréée.
    const home = h.messagesOf(await h.slash('automod'))[0];
    const off = await h.click(home, 'cmd:automod:toggle:off');
    await h.settle();
    assert.equal(h.client.services.config.get(h.guild.id).automod.enabled, false);
    assert.equal([...h.fake.autoModRules.values()].filter((r) => r.name.startsWith('Gadget · ')).length, 0, 'règles natives actives AutoMod désactivé');
    assert.match(h.replyText(off), /native/i);
    await h.click(view, 'cmd:automod:native:sync');
    await h.settle();
    assert.equal([...h.fake.autoModRules.values()].filter((r) => r.name.startsWith('Gadget · ')).length, 0, 'règles recréées AutoMod désactivé');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/** Confirmation éphémère « Bannir » (cmd:automod:qbanok) d'une quarantaine. */
function banConfirmMessage(h, userId) {
  return h.fake.buildMessage({
    channelId: IDS.channels.logs,
    body: { embeds: [{ title: 'Confirmer le bannissement', description: `Bannir <@${userId}> ?` }], components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Bannir', custom_id: `cmd:automod:qbanok:${userId}` }] }] },
    flags: 64,
  });
}

test('R51 : double clic sur « Bannir » d\'une quarantaine — un seul ban, l\'AntiRaid ne dépouille pas le modérateur', async () => {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { enabled: true, banThreshold: 5, destructiveWindowSeconds: 10, punishExecutor: 'strip' } });
  h.fake.latency = 2;
  try {
    const victims = ['Pirate1', 'Pirate2', 'Pirate3'].map((n) => h.addUser(n, { ageDays: 900 }).id);
    for (const id of victims) {
      const msg = banConfirmMessage(h, id);
      await Promise.all([1, 2].map(() => h.click(msg, `cmd:automod:qbanok:${id}`, { as: 'mod' })));
      await h.settle();
    }
    const bans = () => h.client.database.db.prepare("SELECT COUNT(*) AS n FROM sanctions WHERE type = 'ban' AND moderator_id = ?").get(IDS.users.mod).n;
    assert.equal(bans(), 3, `sanctions « ban » enregistrées : ${bans()}`);
    assert.equal(h.fake.members.get(IDS.users.mod).roles.includes(IDS.roles.mod), true, 'rôles du modérateur retirés par l\'AntiRaid');
    // Clic tardif sur une confirmation restée ouverte : déjà banni, rien de plus.
    const late = await h.click(banConfirmMessage(h, victims[0]), `cmd:automod:qbanok:${victims[0]}`, { as: 'mod' });
    assert.match(h.replyText(late), /déjà banni/i);
    assert.equal(bans(), 3);
    assert.equal(h.fake.calls.filter((c) => c.method === 'PUT' && c.route.endsWith(`/bans/${victims[0]}`)).length, 1);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R50 : double clic sur « Lever la quarantaine » et « Faux positif » — une seule levée, un seul log', async () => {
  const h = await createHarness();
  h.configureAll();
  h.fake.latency = 5;
  const T = IDS.users.target;
  const timeoutPatches = (userId, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'PATCH' && c.route.includes(`/members/${userId}`) && c.body && 'communication_disabled_until' in c.body).length;
  const logTitles = (mark) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs).map((m) => m.embeds?.[0]?.title ?? '');
  try {
    // Quarantaine levée par deux modérateurs en même temps.
    const qlog = await quarantineTarget(h);
    const lift = buttonsOf(qlog).find((c) => c.custom_id.startsWith('cmd:automod:qlift:')).custom_id;
    let mark = h.fake.calls.length;
    let logMark = h.fake.messageLog.length;
    await Promise.all([h.click(qlog, lift, { as: 'admin' }), h.click(qlog, lift, { as: 'owner' })]);
    await h.settle();
    assert.equal(timeoutPatches(T, mark), 1, 'timeout levé deux fois');
    assert.equal(logTitles(logMark).filter((t) => /Timeout retiré/i.test(t)).length, 1, 'deux logs « Timeout retiré »');

    // « Faux positif » cliqué deux fois sur un log de timeout.
    h.configure({ automod: { filters: { antiHacked: { enabled: false }, badWords: { enabled: true, words: ['interdit'], action: 'timeout', duration: '10m' } } } });
    logMark = h.fake.messageLog.length;
    await h.userMessage({ as: 'member', content: 'mot interdit ici' });
    await h.settle();
    const log = h.fake.messageLog.slice(logMark).map((id) => h.message(id)).find((m) => m?.channel_id === IDS.channels.logs && buttonsOf(m).some((c) => c.custom_id.startsWith('cmd:automod:fp:')));
    assert.ok(log, 'log AutoMod avec « Faux positif » introuvable');
    const fp = buttonsOf(log).find((c) => c.custom_id.startsWith('cmd:automod:fp:')).custom_id;
    mark = h.fake.calls.length;
    logMark = h.fake.messageLog.length;
    await Promise.all([h.click(log, fp, { as: 'mod' }), h.click(log, fp, { as: 'admin' })]);
    await h.settle();
    assert.equal(timeoutPatches(IDS.users.member, mark), 1, 'timeout levé deux fois (faux positif)');
    assert.equal(logTitles(logMark).filter((t) => /Timeout retiré/i.test(t)).length, 1, 'deux logs « Timeout retiré » (faux positif)');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
