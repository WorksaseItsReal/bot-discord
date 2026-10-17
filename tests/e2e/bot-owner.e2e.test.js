'use strict';

/**
 * Console /bot des propriétaires, bout en bout : nom et avatar globaux (PATCH /users/@me),
 * activité persistée puis réappliquée au démarrage, statut, rotation, liste des serveurs,
 * départ d'un serveur après confirmation par son nom ; refus en embed pour un administrateur,
 * bouton forgé refusé, provenance OWNER_GUILD_ID, autocomplétion revérifiée, /help sans /bot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityType } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { rawMember } = require('./lib/fixtures');
const { explore } = require('./lib/explore');
const { nextId } = require('./lib/ids');
const cdn = require('../../src/utils/discordCdn');
const ready = require('../../src/events/ready');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
const OWNER = { as: 'botOwner' };
const userMe = (c) => c.method === 'PATCH' && /^\/users\/(@|%40)me$/.test(c.route);

/** Le propriétaire du bot (OWNER_IDS) devient membre administrateur du serveur de test. */
async function addBotOwner(h) {
  const raw = rawMember(h.fake.users.get(IDS.users.botOwner), [IDS.roles.admin], 100);
  h.fake.members.set(IDS.users.botOwner, raw);
  h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...raw, guild_id: h.guild.id }, 'préparation : propriétaire du bot');
  await h.settle();
}

/** Second serveur (en cache) que le bot pourra quitter. */
function addSecondGuild(h, name = 'Serveur client') {
  const id = nextId();
  h.client.guilds._add({
    id, name, icon: null, owner_id: IDS.users.owner, roles: [], channels: [], threads: [], members: [], emojis: [], stickers: [],
    features: [], member_count: 42, presences: [], voice_states: [], stage_instances: [], guild_scheduled_events: [], unavailable: false,
    preferred_locale: 'fr', premium_tier: 0, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0, mfa_level: 0, nsfw_level: 0,
  });
  return id;
}

test('/bot en propriétaire : nom, avatar, activité persistée et réappliquée au démarrage, statut, rotation, serveurs, quitter', async () => {
  const h = await createHarness();
  h.configureAll();
  await addBotOwner(h);
  const saved = { http: cdn.transport.http, net: h.client.config.cdnNetwork };
  cdn.transport.http = async (url) => ({ status: 200, ok: true, url, headers: new Headers({ 'content-type': 'image/png' }), body: PNG });
  h.client.config.cdnNetwork = true;
  try {
    const logMark = h.fake.messageLog.length;
    // Infos + exploration de la console (actualiser, serveurs, pages).
    const info = await h.slash('bot', sub('infos'), OWNER);
    assert.match(h.replyText(info), /Réglages de l'instance/);
    await explore(h, info, { as: 'botOwner', budget: 20 });

    // Nom global.
    let mark = h.fake.calls.length;
    const name = await h.slash('bot', sub('nom', [opt('nom', 3, 'Gadget Deux')]), OWNER);
    assert.match(h.replyText(name), /Nom changé/);
    assert.equal(h.fake.calls.slice(mark).find(userMe).body.username, 'Gadget Deux');
    // Avatar global : image du CDN, envoyée en data: (jamais une URL ni un chemin).
    mark = h.fake.calls.length;
    await h.slash('bot', sub('avatar', [opt('image', 11, nextId())]), OWNER);
    assert.match(h.fake.calls.slice(mark).find(userMe).body.avatar, /^data:image\/[a-z]+;base64,/);

    // Activité : stream sans URL autorisée refusé ; « Regarde » appliquée, persistée en base.
    const badStream = await h.slash('bot', sub('activite', [opt('type', 3, 'stream'), opt('texte', 3, 'En direct'), opt('url', 3, 'https://evil.example/live')]), OWNER);
    assert.ok(h.isError(badStream));
    await h.slash('bot', sub('activite', [opt('type', 3, 'regarde'), opt('texte', 3, 'les tests passer')]), OWNER);
    assert.equal(h.client.presence.activities[0]?.name, 'les tests passer');
    assert.equal(h.client.presence.activities[0]?.type, ActivityType.Watching);
    assert.deepEqual(h.client.repositories.botSettings.get('presence').activity, { type: ActivityType.Watching, text: 'les tests passer' });
    assert.equal(h.client.services.botProfile.presenceSource(), 'bot');
    // « Redémarrage » : présence effacée, minuteur arrêté, puis événement ready → réappliquée.
    clearInterval(h.client.presenceTimer);
    h.client.presenceTimer = null;
    h.client.user.setPresence({ activities: [], status: 'online' });
    assert.equal(h.client.presence.activities.length, 0);
    ready.execute(h.client);
    assert.equal(h.client.presence.activities[0]?.name, 'les tests passer', 'activité imposée prioritaire au démarrage');
    // Statut, puis rotation : l'activité imposée est retirée.
    await h.slash('bot', sub('statut', [opt('statut', 3, 'ne_pas_deranger')]), OWNER);
    assert.equal(h.client.presence.status, 'dnd');
    const rot = await h.slash('bot', sub('rotation'), OWNER);
    assert.match(h.replyText(rot), /rotation des statuts reprend/);
    assert.equal(h.client.services.botProfile.presenceSource(), 'defaut');
    assert.notEqual(h.client.presence.activities[0]?.name, 'les tests passer');
    assert.equal(h.client.presence.status, 'dnd', 'statut imposé conservé');

    // Quitter un serveur : confirmation par le nom exact.
    const other = addSecondGuild(h, 'Serveur client');
    const ask = await h.slash('bot', sub('quitter', [opt('serveur', 3, other)]), OWNER);
    assert.equal(ask.modals.length, 1);
    mark = h.fake.calls.length;
    const wrong = await h.submitModal(ask, { nom: 'Serveur clien' });
    assert.ok(h.isError(wrong));
    assert.ok(!h.fake.calls.slice(mark).some((c) => c.method === 'DELETE'), 'nom erroné : je reste');
    const right = await h.submitModal(ask, { nom: 'Serveur client' });
    assert.match(h.replyText(right), /J'ai quitté/);
    assert.ok(h.fake.calls.slice(mark).some((c) => c.method === 'DELETE' && new RegExp(`^/users/(@|%40)me/guilds/${other}$`).test(c.route)), 'DELETE /users/@me/guilds/:id');
    // Le serveur des propriétaires ne se quitte jamais.
    h.client.config.ownerGuildId = h.guild.id;
    const self = await h.slash('bot', sub('quitter', [opt('serveur', 3, h.guild.id)]), OWNER);
    assert.match(h.replyText(self), /serveur des propriétaires/);
    assert.equal(self.modals?.length ?? 0, 0);

    // Réglage d'instance : aucun log de serveur.
    const logs = h.fake.messageLog.slice(logMark).map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs);
    assert.deepEqual(logs.map((m) => m.embeds?.[0]?.title), []);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    cdn.transport.http = saved.http;
    h.client.config.cdnNetwork = saved.net;
    h.client.config.ownerGuildId = '';
    await h.close();
  }
});

test('/bot : refus en embed pour un administrateur, bouton forgé refusé, provenance OWNER_GUILD_ID, autocomplétion et /help', async () => {
  const h = await createHarness();
  h.configureAll();
  await addBotOwner(h);
  const other = addSecondGuild(h, 'Serveur client');
  try {
    // Administrateur du serveur (pas propriétaire du bot) : refus en embed, pour chaque sous-commande.
    for (const leaf of ['infos', 'serveurs', 'rotation']) {
      const rec = await h.slash('bot', sub(leaf), { as: 'admin' });
      assert.ok(h.isError(rec), leaf);
      assert.match(h.replyText(rec), /propriétaires du bot/);
    }
    // Bouton du propriétaire cliqué par l'administrateur : refusé, rien ne change.
    const info = await h.slash('bot', sub('infos'), OWNER);
    const message = h.messagesOf(info)[0];
    const forged = await h.click(message, 'cmd:bot:servers:1', { as: 'admin' });
    assert.ok(h.isError(forged));
    const before = h.client.repositories.botSettings.get('presence');
    h.client.services.botProfile.setActivity({ type: ActivityType.Playing, text: 'imposée' }, IDS.users.botOwner);
    const msg2 = h.messagesOf(await h.slash('bot', sub('infos'), OWNER))[0];
    const forgedRotation = await h.click(msg2, 'cmd:bot:rotation', { as: 'admin' });
    assert.ok(h.isError(forgedRotation));
    assert.equal(h.client.services.botProfile.presenceSource(), 'bot', 'activité imposée intacte');
    assert.notDeepEqual(before, h.client.repositories.botSettings.get('presence'));

    // Provenance : OWNER_GUILD_ID réglé sur un AUTRE serveur → même le propriétaire est refusé ici.
    h.client.config.ownerGuildId = other;
    const elsewhere = await h.slash('bot', sub('infos'), OWNER);
    assert.match(h.replyText(elsewhere), /serveur des propriétaires/);
    const elsewhereClick = await h.click(msg2, 'cmd:bot:info', OWNER);
    assert.ok(h.isError(elsewhereClick));
    h.client.config.ownerGuildId = '';

    // Autocomplétion de /bot quitter : revérifiée elle-même.
    const focused = [{ name: 'quitter', type: 1, options: [{ name: 'serveur', type: 3, value: '', focused: true }] }];
    const adminAc = await h.autocomplete('bot', focused, { as: 'admin' });
    assert.deepEqual(adminAc.autocomplete, [], 'administrateur : aucune liste de serveurs');
    const ownerAc = await h.autocomplete('bot', focused, OWNER);
    assert.ok(ownerAc.autocomplete.some((c) => c.value === other));

    // /help : /bot invisible pour l'administrateur, visible pour le propriétaire.
    const helpAc = await h.autocomplete('help', [{ name: 'commande', type: 3, value: 'bot', focused: true }], { as: 'admin' });
    assert.ok(!helpAc.autocomplete.some((c) => c.value === 'bot'));
    const detail = await h.slash('help', [opt('commande', 3, 'bot')], { as: 'admin' });
    assert.ok(h.isError(detail), '/help commande:bot → inconnue pour un non-propriétaire');
    const home = await h.slash('help', [], { as: 'admin' });
    const total = h.client.commands.size;
    assert.match(h.replyText(home), new RegExp(`\\*\\*${total - 1}\\*\\* commandes`));
    const ownerDetail = await h.slash('help', [opt('commande', 3, 'bot')], OWNER);
    assert.match(h.replyText(ownerDetail), /\/bot/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    h.client.config.ownerGuildId = '';
    await h.close();
  }
});
