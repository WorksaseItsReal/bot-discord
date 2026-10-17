'use strict';

/**
 * Revue n° 6, bout en bout (vrai discord.js, faux Discord) : communauté — starboard sur un
 * serveur à vérification, rappels, annonces, niveaux, giveaways, invitations, projets,
 * alertes de mots-clés, signalements.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { rawMember } = require('./lib/fixtures');
const { nextId } = require('./lib/ids');

const STAR = { id: null, name: '⭐' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const botMessagesIn = (h, channelId, mark = 0) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id);

/** Réactions ⭐ simulées (même mécanisme que tests/e2e/community.e2e.test.js). */
function installReactions(h) {
  const users = new Map();
  h.fake.routes.unshift({
    method: 'GET',
    re: /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/,
    keys: ['channel', 'message', 'emoji'],
    handler: (p) => [...(users.get(p.message) ?? [])].map((id) => h.fake.users.get(id)).filter(Boolean),
  });
  return async (msg, as) => {
    const userId = IDS.users[as] ?? as;
    const set = users.get(msg.id) ?? new Set();
    users.set(msg.id, set);
    set.add(userId);
    const raw = h.fake.messages.get(msg.id);
    raw.reactions = [{ emoji: STAR, count: set.size, count_details: { burst: 0, normal: set.size }, me: false, me_burst: false, burst_colors: [] }];
    const member = h.fake.members.get(userId);
    h.fake.dispatchNow('MESSAGE_REACTION_ADD', { user_id: userId, channel_id: msg.channel_id, message_id: msg.id, guild_id: h.guild.id, emoji: STAR, burst: false, type: 0, ...(member ? { member } : {}) }, `réaction ⭐ ${as}`);
    await h.settle();
  };
}

function updateRole(h, roleId, mutate, label) {
  const role = { ...h.fake.roles.get(roleId) };
  role.permissions = mutate(BigInt(role.permissions)).toString();
  h.fake.roles.set(roleId, role);
  h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role }, label);
}

// ------------------------------------------------------------------ R75 : starboard

test('R75 starboard : serveur à vérification (@everyone ne voit rien) → un message de #staff n\'est jamais reposté pour le rôle Membre', async () => {
  const h = await createHarness();
  const sb = h.client.services.starboard;
  sb.debounceMs = 20;
  sb.minEditIntervalMs = 20;
  const react = installReactions(h);
  try {
    const board = nextId();
    const rawBoard = { id: board, type: 0, guild_id: h.guild.id, name: 'starboard', position: 9, permission_overwrites: [], parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0 };
    h.fake.channels.set(board, rawBoard);
    h.fake.dispatchNow('CHANNEL_CREATE', rawBoard, 'préparation : #starboard');
    const modo2 = h.addUser('Modo2', { ageDays: 800 });
    const m2 = rawMember(modo2, [IDS.roles.mod, IDS.roles.member], 300);
    h.fake.members.set(modo2.id, m2);
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...m2, guild_id: h.guild.id }, 'préparation : Modo2');
    await h.settle();

    const rec = await h.slash('communaute');
    const nav = await h.click(h.messagesOf(rec)[0], 'cmd:communaute:nav', { values: ['starboard'] });
    const setChannel = await h.click(h.messagesOf(nav)[0], 'cmd:communaute:sbchannel', { values: [board] });
    await h.click(h.messagesOf(setChannel)[0], 'cmd:communaute:sbtoggle:on:starboard');
    const reactors = ['mod', 'admin', 'owner'];

    // Témoin public : un message de #général atteint le seuil → carte publiée.
    const pub = await h.userMessage({ as: modo2.id, channel: 'general', content: 'Message public' });
    for (const as of reactors) await react(pub, as);
    await sleep(80);
    await h.settle();
    assert.equal(botMessagesIn(h, board).length, 1, 'message public non reposté');

    // Vérification « ajout » : @everyone perd « Voir les salons », le rôle Membre l'obtient.
    h.configure({ welcome: { verification: { enabled: true, mode: 'add', roleId: IDS.roles.member } } });
    updateRole(h, IDS.roles.everyone, (p) => p & ~P.ViewChannel, 'préparation : @everyone sans Voir les salons');
    updateRole(h, IDS.roles.member, (p) => p | P.ViewChannel, 'préparation : Membre voit les salons');
    await h.settle();
    const sees = (userId, channelId) => h.client.channels.cache.get(channelId).permissionsFor(h.guild.members.cache.get(userId)).has(P.ViewChannel);
    assert.equal(sees(IDS.users.target, IDS.channels.staff), false);
    assert.equal(sees(IDS.users.target, board), true);

    const mark = h.fake.messageLog.length;
    const secret = await h.userMessage({ as: modo2.id, channel: 'staff', content: 'CONFIDENTIEL : on bannit X demain' });
    for (const as of reactors) await react(secret, as);
    await sleep(80);
    await h.settle();
    assert.equal(botMessagesIn(h, board, mark).length, 0, 'message de #staff reposté dans un starboard lu par le rôle Membre');
    assert.equal(h.client.repositories.starboard.get(h.guild.id, secret.id), null);

    // Le message public reste éligible (le rôle Membre voit #général).
    await react(pub, 'target');
    await sleep(80);
    await h.settle();
    assert.ok(h.client.repositories.starboard.get(h.guild.id, pub.id)?.star_message_id, 'message public retiré à tort');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R75 starboard : salon devenu privé après la publication → la carte existante est retirée au recompte suivant', async () => {
  const h = await createHarness();
  const sb = h.client.services.starboard;
  sb.debounceMs = 20;
  sb.minEditIntervalMs = 20;
  const react = installReactions(h);
  try {
    const board = nextId();
    const rawBoard = { id: board, type: 0, guild_id: h.guild.id, name: 'starboard', position: 9, permission_overwrites: [], parent_id: IDS.channels.catGeneral, flags: 0, topic: null, nsfw: false, last_message_id: null, rate_limit_per_user: 0 };
    h.fake.channels.set(board, rawBoard);
    h.fake.dispatchNow('CHANNEL_CREATE', rawBoard, 'préparation : #starboard');
    h.configure({ community: { starboard: { enabled: true, channelId: board, threshold: 2 } } });
    await h.settle();
    const msg = await h.userMessage({ as: 'member', channel: 'general', content: 'Bientôt privé' });
    await react(msg, 'mod');
    await react(msg, 'admin');
    await sleep(80);
    await h.settle();
    const row = h.client.repositories.starboard.get(h.guild.id, msg.id);
    assert.ok(row?.star_message_id, 'carte non publiée');

    // #général devient invisible pour @everyone (le starboard reste public).
    const general = h.fake.channels.get(IDS.channels.general);
    const updated = { ...general, permission_overwrites: [...general.permission_overwrites.filter((o) => o.id !== IDS.roles.everyone), { id: IDS.roles.everyone, type: 0, allow: '0', deny: P.ViewChannel.toString() }] };
    h.fake.channels.set(general.id, updated);
    h.fake.dispatchNow('CHANNEL_UPDATE', updated, 'préparation : #général privé');
    await h.settle();
    await react(msg, 'owner');
    await sleep(80);
    await h.settle();
    assert.equal(h.client.repositories.starboard.get(h.guild.id, msg.id), null, 'ligne conservée');
    assert.ok(h.fake.calls.some((c) => c.method === 'DELETE' && c.route === `/channels/${board}/messages/${row.star_message_id}`), 'carte d\'un salon devenu privé laissée en place');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

