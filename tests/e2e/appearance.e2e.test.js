'use strict';

/**
 * Apparence du bot par serveur, bout en bout : /settings theme (thème par MARQUAGE : réponses,
 * logs, message épinglé ; couleurs choisies et tons de sens intacts) et /settings profil
 * (editMe avec une image data:, refus d'usurpation, image trop lourde, 10 min entre deux avatars).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { leavesOf, runLeaf, explore } = require('./lib/explore');
const { OVERRIDES } = require('./lib/overrides');
const { nextId } = require('./lib/ids');
const { TONES } = require('../../src/utils/ui');
const cdn = require('../../src/utils/discordCdn');

const RED = 0xff0000;
const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
/** Couleur de la première carte de la réponse d'une interaction. */
const colorOf = (h, rec) => h.messagesOf(rec)[0]?.embeds?.[0]?.color;
/** Dernier message du bot dans un salon depuis `mark`. */
const lastBotMessage = (h, channelId, mark = 0) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.channel_id === channelId && m.author.id === h.client.user.id).at(-1);

test('/settings theme #FF0000 : réponses et logs thémés, /couleur et erreurs intacts, message épinglé thémé, « défaut » restaure', async () => {
  const h = await createHarness();
  h.configureAll();
  try {
    const before = await h.slash('serverinfo');
    assert.equal(colorOf(h, before), TONES.brand);

    let mark = h.fake.messageLog.length;
    const set = await h.slash('settings', sub('theme', [opt('couleur', 3, '#FF0000')]));
    assert.equal(colorOf(h, set), RED, 'aperçu dans la couleur choisie');
    assert.match(h.replyText(set), /#FF0000/);
    assert.equal(h.client.services.config.get(h.guild.id).appearance.color, RED);
    // Log server.botProfile (carte d'information) : thémé.
    const log = lastBotMessage(h, IDS.channels.logs, mark);
    assert.match(log.embeds[0].title, /Thème du bot modifié/);
    assert.equal(log.embeds[0].color, RED);

    assert.equal(colorOf(h, await h.slash('serverinfo')), RED, '/serverinfo prend le thème');
    assert.equal(colorOf(h, await h.slash('couleur', [opt('hex', 3, '#5865F2')])), 0x5865f2, 'couleur choisie : jamais thémée');
    const refused = await h.slash('ban', [opt('membre', 6, IDS.users.target)], { as: 'member' });
    assert.ok(h.isError(refused));
    assert.equal(colorOf(h, refused), TONES.danger, 'une erreur reste rouge « danger »');
    const warn = await h.slash('settings', sub('moderation'));
    assert.equal(colorOf(h, warn), TONES.warning, 'avertissement intact');

    // Message épinglé automatiquement (envoi direct via fitEmbeds) : thémé.
    mark = h.fake.messageLog.length;
    const open = await h.slash('sticky', sub('definir'));
    await h.submitModal(open, { content: 'Merci de rester courtois.' });
    await h.waitFor(() => Boolean(lastBotMessage(h, IDS.channels.general, mark)?.embeds?.[0]?.footer?.text?.includes('épinglé')), { timeout: 3_000 });
    const sticky = lastBotMessage(h, IDS.channels.general, mark);
    assert.equal(sticky.embeds[0].color, RED);

    // Autre serveur, MP : jamais le thème de ce serveur.
    const dm = await h.slash('help', [], { channel: 'dm' });
    assert.equal(colorOf(h, dm), TONES.brand);

    const reset = await h.slash('settings', sub('theme', [opt('couleur', 3, 'défaut')]));
    assert.equal(colorOf(h, reset), TONES.brand);
    assert.equal(h.client.services.config.get(h.guild.id).appearance.color, null);
    assert.equal(colorOf(h, await h.slash('serverinfo')), TONES.brand, '« défaut » restaure');
    const bad = await h.slash('settings', sub('theme', [opt('couleur', 3, 'arc-en-ciel')]));
    assert.ok(h.isError(bad));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/settings profil : editMe avec image data:, usurpation refusée, 9 Mo refusé, 10 min entre deux avatars, log après la réponse', async () => {
  const h = await createHarness();
  h.configureAll();
  const saved = { http: cdn.transport.http, net: h.client.config.cdnNetwork };
  let next = { body: PNG, type: 'image/png' };
  const fetched = [];
  cdn.transport.http = async (url, opts) => {
    fetched.push({ url, opts });
    return { status: 200, ok: true, url, headers: new Headers({ 'content-type': next.type, 'content-length': String(next.body.length) }), body: next.body };
  };
  try {
    // Téléchargements coupés (CDN_NETWORK=off) : refus clair, aucun appel.
    const off = await h.slash('settings', sub('profil', [opt('avatar', 11, nextId())]));
    assert.match(h.replyText(off), /téléchargement d'images désactivé sur cette instance/);
    assert.equal(fetched.length, 0);
    h.client.config.cdnNetwork = true;

    // Pseudo + avatar : PATCH members/@me (image en data:, jamais une URL), réponse puis log.
    const mark = h.fake.calls.length;
    const rec = await h.slash('settings', sub('profil', [opt('pseudo', 3, 'Gadget du serveur'), opt('avatar', 11, nextId()), opt('bio', 3, 'Je réponds à vos questions.')]));
    assert.match(h.replyText(rec), /Profil du bot mis à jour/);
    const calls = h.fake.calls.slice(mark);
    const patchAt = calls.findIndex((c) => c.method === 'PATCH' && /^\/guilds\/\d+\/members\/(@|%40)me$/.test(c.route));
    assert.ok(patchAt >= 0, 'PATCH members/@me');
    const body = calls[patchAt].body;
    assert.equal(body.nick, 'Gadget du serveur');
    assert.equal(body.bio, 'Je réponds à vos questions.');
    assert.match(body.avatar, /^data:image\/[a-z]+;base64,/);
    assert.equal(Buffer.from(body.avatar.split(',')[1], 'base64').compare(PNG), 0);
    assert.ok(!('banner' in body), 'bannière non touchée');
    assert.match(calls[patchAt].reason, /\/settings profil/);
    assert.ok(!calls.some((c) => c.method === 'PATCH' && /^\/users\/(@|%40)me$/.test(c.route)), 'profil GLOBAL jamais modifié');
    assert.match(fetched[0].url, /^https:\/\/cdn\.discordapp\.com\//);
    const replyAt = calls.findIndex((c) => c.method === 'PATCH' && /\/messages\/(@|%40)original$/.test(c.route));
    const logAt = calls.findIndex((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.logs}/messages` && /Profil du bot modifié/.test(c.body?.embeds?.[0]?.title ?? ''));
    assert.ok(patchAt < replyAt && replyAt < logAt, `ordre editMe → réponse → log (${patchAt}, ${replyAt}, ${logAt})`);
    assert.equal(h.guild.members.me.nickname, 'Gadget du serveur');

    // Second avatar dans les 10 minutes : refusé AVANT tout téléchargement.
    const n = fetched.length;
    // (keepCooldowns : le harnais efface sinon les délais avant chaque commande ; seul le délai
    // de 2 s du routeur est levé.)
    h.client.cooldowns.release(`settings:${IDS.users.admin}`);
    const again = await h.slash('settings', sub('profil', [opt('avatar', 11, nextId())]), { keepCooldowns: true });
    assert.ok(h.isError(again));
    assert.match(h.replyText(again), /toutes les 10 minutes/);
    assert.equal(fetched.length, n);

    // Usurpation (« Discord Staff ») et mot interdit : refusés sans appel à Discord.
    const before = h.fake.calls.length;
    const staff = await h.slash('settings', sub('profil', [opt('pseudo', 3, 'Discord Staff')]));
    assert.match(h.replyText(staff), /usurpation/i);
    const word = await h.slash('settings', sub('profil', [opt('bio', 3, 'un texte interdit')]));
    assert.match(h.replyText(word), /mot interdit/);
    assert.ok(!h.fake.calls.slice(before).some((c) => /\/members\/(@|%40)me$/.test(c.route)));

    // Bannière de 9 Mo (taille annoncée par le CDN) : refusée, aucun editMe.
    next = { body: Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]), type: 'image/png' };
    const heavy = await h.slash('settings', sub('profil', [opt('banniere', 11, nextId())]));
    assert.match(h.replyText(heavy), /trop volumineux/);
    // Fichier qui n'est pas une image (signature) : refusé.
    next = { body: Buffer.from('<html>pas une image</html>'), type: 'image/png' };
    const notImage = await h.slash('settings', sub('profil', [opt('banniere', 11, nextId())]));
    assert.match(h.replyText(notImage), /pas une image/);
    assert.ok(!h.fake.calls.slice(before).some((c) => /\/members\/(@|%40)me$/.test(c.route)));

    // Réinitialisation (pseudo, bio) : valeurs null envoyées ; conflit fourni + réinitialisé refusé.
    const conflict = await h.slash('settings', sub('profil', [opt('pseudo', 3, 'X'), opt('reinitialiser', 3, 'pseudo')]));
    assert.match(h.replyText(conflict), /à la fois fourni et réinitialisé/);
    const m2 = h.fake.calls.length;
    await h.slash('settings', sub('profil', [opt('reinitialiser', 3, 'pseudo')]));
    const resetCall = h.fake.calls.slice(m2).find((c) => /^\/guilds\/\d+\/members\/(@|%40)me$/.test(c.route));
    assert.deepEqual(resetCall.body, { nick: null });
    // Sans option : état actuel du profil.
    const view = await h.slash('settings', sub('profil'));
    assert.match(h.replyText(view), /Profil du bot sur ce serveur/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    cdn.transport.http = saved.http;
    h.client.config.cdnNetwork = saved.net;
    await h.close();
  }
});

test('/settings theme et profil : explorés en administrateur, refusés à un membre ; bot sans « Changer de pseudo »', async () => {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  try {
    const leaves = leavesOf(h.client.commands.get('settings').data.toJSON()).filter((l) => ['theme', 'profil'].includes(l.path[0]));
    assert.equal(leaves.length, 2);
    for (const leaf of leaves) {
      const key = ['settings', ...leaf.path].join(' ');
      const rec = await runLeaf(h, 'settings', leaf, { overrides: OVERRIDES[key] ?? {} });
      assert.ok(!h.isError(rec), `${key} : ${h.replyText(rec)}`);
      await explore(h, rec, { budget: 15 });
      const member = await runLeaf(h, 'settings', leaf, { overrides: OVERRIDES[key] ?? {}, as: 'member' });
      assert.ok(h.isError(member));
    }
    // Bot sans « Changer de pseudo » (ni par son rôle, ni par @everyone) : refus clair, aucun PATCH.
    for (const id of [IDS.roles.bot, IDS.roles.everyone]) {
      const role = { ...h.fake.roles.get(id) };
      role.permissions = (BigInt(role.permissions) & ~P.ChangeNickname).toString();
      h.fake.roles.set(role.id, role);
      h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: h.guild.id, role }, 'préparation : bot sans Changer de pseudo');
    }
    await h.settle();
    const mark = h.fake.calls.length;
    const rec = await h.slash('settings', sub('profil', [opt('pseudo', 3, 'Autre pseudo')]));
    assert.match(h.replyText(rec), /Changer de pseudo/);
    assert.ok(!h.fake.calls.slice(mark).some((c) => /\/members\/(@|%40)me$/.test(c.route)));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
