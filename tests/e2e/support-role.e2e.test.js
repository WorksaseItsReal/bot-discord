'use strict';

/**
 * Bout en bout : rôle soutien (/automatisations › Rôle soutien) sur le vrai discord.js. Le tag du
 * serveur arrive par un paquet brut GUILD_MEMBER_UPDATE (primary_guild), le statut par
 * PRESENCE_UPDATE avec l'intent des présences (PRESENCE_INTENT=on), sans l'intent : rien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { config: botConfig } = require('../../src/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROLE = () => IDS.roles.temp; // rôle dédié, porté par personne dans le serveur de test
const roleCalls = (h, mark, method) => h.fake.calls.slice(mark).filter((c) => c.method === method && c.route.endsWith(`/roles/${ROLE()}`));
const hasRole = (h, userId) => h.fake.members.get(userId)?.roles.includes(ROLE());

/** Ouvre la vue Rôle soutien (interaction du menu, dont le message est la vue). */
async function openSupport(h) {
  const dash = await h.slash('automatisations');
  return h.click(h.messagesOf(dash)[0], 'cmd:automatisations:nav', { values: ['support'] });
}
const supportView = async (h) => h.messagesOf(await openSupport(h))[0];

/** Rôle, condition (et texte), activation : par le tableau de bord. */
async function setup(h, { source = 'tag', text = null, enable = true } = {}) {
  let msg = await supportView(h);
  let rec = await h.click(msg, 'cmd:automatisations:surole', { values: [ROLE()] });
  assert.match(h.replyText(rec), /Rôle soutien : /);
  msg = h.messagesOf(rec)[0];
  if (source !== 'tag') {
    rec = await h.click(msg, 'cmd:automatisations:susource', { values: [source] });
    msg = h.messagesOf(rec)[0];
  }
  if (text) {
    const form = await h.click(msg, 'cmd:automatisations:sutext');
    rec = await h.submitModal(form, { text });
    msg = h.messagesOf(rec)[0];
  }
  if (enable) {
    rec = await h.click(msg, 'cmd:automatisations:sutoggle:on');
    msg = h.messagesOf(rec)[0];
  }
  const svc = h.client.services.supportRole;
  svc.debounceMs = 60;
  return { rec, msg, svc };
}

/** Le membre affiche (ou retire) le tag du serveur : paquet brut GUILD_MEMBER_UPDATE. */
function setTag(h, userId, on) {
  const m = h.fake.members.get(userId);
  const primary = on ? { identity_guild_id: h.guild.id, identity_enabled: true, tag: 'GDGT', badge: null } : null;
  m.user = { ...m.user, primary_guild: primary };
  h.fake.users.set(userId, m.user);
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', h.fake.memberWithGuild(m), `tag ${on ? 'affiché' : 'retiré'}`);
}

function presence(h, userId, status, state) {
  h.fake.dispatchNow('PRESENCE_UPDATE', {
    user: { id: userId },
    guild_id: h.guild.id,
    status,
    activities: state ? [{ type: 4, name: 'Custom Status', state, created_at: Date.now() }] : [],
    client_status: status === 'offline' ? {} : { desktop: status },
  }, `présence ${status} ${state ?? ''}`);
}

test('/automatisations › Rôle soutien : chaque vue, menu, formulaire ; Source /bot ; refus sans permission', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const rec = await h.slash('automatisations');
    const stats = await explore(h, rec, { budget: 300 });
    assert.ok(stats.navChosen.has('cmd:automatisations:nav=support'), 'vue Rôle soutien jamais ouverte');
    const walked = await explore(h, await openSupport(h), { budget: 40, skip: (a) => a.customId === 'cmd:automatisations:nav' || a.customId === 'cmd:automatisations:go:home' });
    for (const key of ['surole', 'susource', 'sutoggle']) assert.ok(walked.keys.has(`cmd:automatisations:${key}`), `${key} jamais utilisé`);
    // Rôles refusés : rôle sensible (Modérateur), rôle déjà porté, rôle d'une autre attribution automatique.
    const fresh = await supportView(h);
    assert.ok(h.isError(await h.click(fresh, 'cmd:automatisations:surole', { values: [IDS.roles.mod] })), 'rôle sensible refusé');
    assert.ok(h.isError(await h.click(fresh, 'cmd:automatisations:surole', { values: [IDS.roles.gamer] })), 'rôle déjà porté refusé');
    assert.ok(h.isError(await h.click(fresh, 'cmd:automatisations:surole', { values: [IDS.roles.member] })), 'rôle automatique d\'arrivée refusé');
    h.resetProblems();

    // Présence : « Source : /bot » quand le propriétaire du bot impose les statuts.
    h.client.services.botProfile = { presenceSource: () => 'bot', presenceSettings: () => ({ statuses: [{ type: 3, text: 'la maintenance' }], intervalMs: 60_000, source: 'bot', invalid: [] }) };
    const dash = await h.slash('automatisations');
    const pres = await h.click(h.messagesOf(dash)[0], 'cmd:automatisations:nav', { values: ['presence'] });
    const fields = h.messagesOf(pres)[0].embeds[0].fields;
    assert.equal(fields.find((f) => /Source/.test(f.name)).value, '/bot');
    delete h.client.services.botProfile;

    const denied = await h.slash('automatisations', [], { as: 'member' });
    assert.ok(h.isError(denied));
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).support);
    await explore(h, await openSupport(h), { as: 'member', budget: 20 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).support), before, 'un membre a modifié la configuration');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('tag du serveur : paquet GUILD_MEMBER_UPDATE (primary_guild) → rôle ajouté puis retiré ; désactivation → retiré', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    await setup(h);
    const target = IDS.users.target;
    let mark = h.fake.calls.length;
    setTag(h, target, true);
    assert.ok(await h.waitFor(() => hasRole(h, target)), 'rôle soutien non donné');
    assert.equal(roleCalls(h, mark, 'PUT').length, 1);
    // Retrait (après l'anti-rebond).
    mark = h.fake.calls.length;
    setTag(h, target, false);
    assert.ok(await h.waitFor(() => !hasRole(h, target), { timeout: 2_000 }), 'rôle soutien non retiré');
    assert.equal(roleCalls(h, mark, 'DELETE').length, 1);
    // Paquets sans changement (le bot lui-même, mises à jour répétées) : aucune requête.
    mark = h.fake.calls.length;
    setTag(h, target, false);
    await sleep(100);
    await h.settle();
    assert.equal(roleCalls(h, mark, 'PUT').length + roleCalls(h, mark, 'DELETE').length, 0);

    // Désactivation : le rôle est retiré à ses porteurs.
    setTag(h, target, true);
    assert.ok(await h.waitFor(() => hasRole(h, target), { timeout: 2_000 }));
    const view = await supportView(h);
    await h.click(view, 'cmd:automatisations:sutoggle:off');
    assert.ok(await h.waitFor(() => !hasRole(h, target), { timeout: 2_000 }), 'rôle non retiré à la désactivation');
    // « Resynchroniser » : refusé tant que la fonction est coupée.
    const again = await supportView(h);
    assert.ok(h.isError(await h.click(again, 'cmd:automatisations:susync', { componentType: 2 })));
    h.resetProblems();
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('statut avec PRESENCE_INTENT=on : PRESENCE_UPDATE → rôle ajouté puis retiré ; cache vide ; /compteurs sans « En ligne »', async () => {
  const before = botConfig.presenceIntent;
  botConfig.presenceIntent = true;
  let h;
  try {
    h = await createHarness();
  } finally {
    botConfig.presenceIntent = before;
  }
  h.configureAll();
  try {
    assert.equal(h.client.presenceCacheDisabled, true);
    const { msg } = await setup(h, { source: 'statut', text: 'gadget' });
    assert.doesNotMatch(msg.embeds[0].description, /Indisponible/);
    const target = IDS.users.target;
    let mark = h.fake.calls.length;
    presence(h, target, 'offline', 'Fan de Gadget');
    await sleep(80);
    await h.settle();
    assert.equal(roleCalls(h, mark, 'PUT').length, 0, 'hors ligne : rien');
    presence(h, target, 'idle', 'Fan de GADGET 🎉');
    assert.ok(await h.waitFor(() => hasRole(h, target)), 'rôle soutien non donné');
    assert.equal(h.guild.presences.cache.size, 0, 'présences jamais gardées en cache');
    mark = h.fake.calls.length;
    presence(h, target, 'online', 'autre chose');
    assert.ok(await h.waitFor(() => !hasRole(h, target), { timeout: 2_000 }), 'rôle non retiré (en ligne sans le texte)');
    assert.equal(roleCalls(h, mark, 'DELETE').length, 1);

    // /compteurs : « En ligne » toujours absent (le compteur lirait des présences vides → 0).
    const dash = await h.slash('compteurs');
    const pick = h.findComponent(h.messagesOf(dash)[0], 'cmd:compteurs:pick');
    assert.ok(pick && !pick.options.some((o) => o.value === 'online'), '« En ligne » proposé avec un cache des présences vide');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('statut sans l\'intent : vue « indisponible », activation refusée, aucune requête sur PRESENCE_UPDATE', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const { msg } = await setup(h, { source: 'statut', text: 'gadget', enable: false });
    assert.match(msg.embeds[0].description, /Indisponible : intent non activé/);
    const refused = await h.click(msg, 'cmd:automatisations:sutoggle:on');
    assert.ok(h.isError(refused));
    assert.match(h.replyText(refused), /intent non activé/);
    h.resetProblems();
    // Réglage hérité (intent retiré depuis) : service inerte.
    h.configure({ support: { enabled: true } });
    const mark = h.fake.calls.length;
    presence(h, IDS.users.target, 'online', 'Fan de Gadget');
    presence(h, IDS.users.member, 'online', 'rien à voir');
    await sleep(120);
    await h.settle();
    assert.equal(h.fake.calls.length - mark, 0, 'aucune requête sans l\'intent');
    const view = await supportView(h);
    assert.match(view.embeds[0].description, /Indisponible : intent non activé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
