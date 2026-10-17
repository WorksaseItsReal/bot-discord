'use strict';

/**
 * /embed texte (+say), bout en bout (vrai discord.js, faux Discord) : mentions autorisées
 * explicites, @everyone jamais sans la permission native, salon interdit, AutoMod, réponse à un
 * message, fichier relayé depuis le CDN, pré-contrôle de la sécurité, log APRÈS la réponse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { leavesOf, runLeaf, explore } = require('./lib/explore');
const { OVERRIDES, throwawayChannel } = require('./lib/overrides');
const { nextId } = require('./lib/ids');
const { sayWindows } = require('../../src/commands/utility/embed');
const cdn = require('../../src/utils/discordCdn');

const opt = (name, type, value) => ({ name, type, value });
const texte = (options) => [{ name: 'texte', type: 1, options }];
/** Messages publiés par le bot (POST) dans un salon depuis `mark`. */
const postsIn = (h, channelId, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'POST' && c.route === `/channels/${channelId}/messages`);

test('/embed texte : mentions conformes, @everyone sans permission, salon interdit, AutoMod, log après la réponse', async () => {
  const h = await createHarness();
  h.configureAll();
  // Filtre « mentions massives » coupé ici : on vérifie les mentions AUTORISÉES (le filtre est
  // couvert plus bas par l'AutoMod, mot interdit).
  h.configure({ automod: { filters: { antiMassMention: { enabled: false } } } });
  try {
    // 1) Mentions autorisées explicites (modérateur : pas « Mentionner @everyone »).
    sayWindows.clear();
    h.fake.intendedPingLabels.push(/mentions-voulues/);
    let mark = h.fake.calls.length;
    const content = `Salut <@${IDS.users.member}> <@${IDS.users.target}> <@${IDS.users.member}> <@&${IDS.roles.notif}> <@&${IDS.roles.gamer}> @everyone`;
    const rec = await h.slash('embed', texte([opt('message', 3, content), opt('mentionner_roles', 5, true)]), { as: 'mod', label: '/embed texte mentions-voulues' });
    assert.match(h.replyText(rec), /Message envoyé/);
    let [post] = postsIn(h, IDS.channels.general, mark);
    assert.ok(post, 'message publié');
    assert.equal(post.body.content, content);
    assert.deepEqual(post.body.allowed_mentions, { parse: [], users: [IDS.users.member, IDS.users.target], roles: [IDS.roles.notif], replied_user: false });
    assert.ok(h.messagesOf(rec).every((m) => m.flags & 64), 'réponse éphémère');

    // 2) @everyone écrit sans notifier_tous : publié sans aucune mention de masse.
    sayWindows.clear();
    mark = h.fake.calls.length;
    await h.slash('embed', texte([opt('message', 3, '@everyone @here réunion ce soir')]), { as: 'mod' });
    [post] = postsIn(h, IDS.channels.general, mark);
    assert.deepEqual(post.body.allowed_mentions.parse, []);
    assert.equal(h.fake.massMentions.length, 0, 'aucune mention de masse effective');
    // notifier_tous sans la permission native : refus en embed, rien n'est publié.
    sayWindows.clear();
    mark = h.fake.calls.length;
    const denied = await h.slash('embed', texte([opt('message', 3, '@everyone urgent'), opt('notifier_tous', 5, true)]), { as: 'mod' });
    assert.ok(h.isError(denied));
    assert.match(h.replyText(denied), /Mentionner @everyone/);
    assert.equal(postsIn(h, IDS.channels.general, mark).length, 0);

    // 3) Salon où l'auteur ne peut pas écrire : refus en embed.
    sayWindows.clear();
    const closed = await throwawayChannel(h, 'lecture-seule');
    const raw = h.fake.channels.get(closed);
    raw.permission_overwrites = [{ id: IDS.roles.mod, type: 0, allow: '0', deny: String(P.SendMessages) }];
    h.fake.dispatchNow('CHANNEL_UPDATE', raw, 'préparation : #lecture-seule');
    await h.settle();
    mark = h.fake.calls.length;
    const forbidden = await h.slash('embed', texte([opt('message', 3, 'Bonjour'), opt('salon', 7, closed)]), { as: 'mod' });
    assert.ok(h.isError(forbidden));
    assert.match(h.replyText(forbidden), /y écrire/);
    assert.equal(postsIn(h, closed, mark).length, 0);

    // 4) AutoMod : mot interdit refusé, même pour un administrateur (le bot signerait le message).
    sayWindows.clear();
    mark = h.fake.calls.length;
    const bad = await h.slash('embed', texte([opt('message', 3, 'ceci est interdit ici')]));
    assert.ok(h.isError(bad));
    assert.match(h.replyText(bad), /AutoMod/);
    assert.equal(postsIn(h, IDS.channels.general, mark).length, 0);

    // 5) Réponse AVANT le log moderation.say.
    sayWindows.clear();
    mark = h.fake.calls.length;
    const ok = await h.slash('embed', texte([opt('message', 3, 'Annonce : la soirée commence !'), opt('salon', 7, IDS.channels.announcements)]));
    assert.match(h.replyText(ok), /Message envoyé/);
    const calls = h.fake.calls.slice(mark);
    const sendAt = calls.findIndex((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.announcements}/messages`);
    const replyAt = calls.findIndex((c) => c.method === 'PATCH' && /^\/webhooks\/\d+\/[^/]+\/messages\/(@|%40)original$/.test(c.route));
    const logAt = calls.findIndex((c) => c.method === 'POST' && c.route === `/channels/${IDS.channels.logs}/messages` && c.body?.embeds?.[0]?.title?.includes('Message publié au nom du bot'));
    assert.ok(sendAt >= 0 && replyAt > sendAt && logAt > replyAt, `ordre envoi → réponse → log (${sendAt}, ${replyAt}, ${logAt})`);
    const logEmbed = calls[logAt].body.embeds[0];
    assert.ok(logEmbed.fields.some((f) => f.value.includes('la soirée commence')));

    // 6) repondre_a : message de ce serveur (référence posée) ; autre serveur refusé.
    sayWindows.clear();
    const target = await h.userMessage({ as: 'member', content: 'Quelqu\'un ?' });
    mark = h.fake.calls.length;
    await h.slash('embed', texte([opt('message', 3, 'Oui, nous sommes là.'), opt('repondre_a', 3, `https://discord.com/channels/${h.guild.id}/${IDS.channels.general}/${target.id}`)]));
    [post] = postsIn(h, IDS.channels.general, mark);
    assert.equal(post.body.message_reference.message_id, target.id);
    assert.equal(post.body.allowed_mentions.replied_user, false);
    sayWindows.clear();
    const foreign = await h.slash('embed', texte([opt('message', 3, 'x'), opt('repondre_a', 3, `https://discord.com/channels/${nextId()}/${IDS.channels.general}/${target.id}`)]));
    assert.match(h.replyText(foreign), /CE serveur/);

    // 7) Fichier : téléchargé depuis le CDN (transport injecté), puis joint ; coupé → refus clair.
    sayWindows.clear();
    const offRec = await h.slash('embed', texte([opt('message', 3, 'Voici le règlement'), opt('fichier', 11, nextId())]));
    assert.match(h.replyText(offRec), /désactivé sur cette instance/);
    const before = { http: cdn.transport.http, net: h.client.config.cdnNetwork };
    const fetched = [];
    cdn.transport.http = async (url, opts) => {
      fetched.push({ url, opts });
      return { status: 200, ok: true, url, headers: new Headers({ 'content-type': 'image/png' }), body: Buffer.from('contenu du fichier') };
    };
    h.client.config.cdnNetwork = true;
    try {
      sayWindows.clear();
      mark = h.fake.calls.length;
      await h.slash('embed', texte([opt('message', 3, 'Voici le règlement'), opt('fichier', 11, nextId())]));
      [post] = postsIn(h, IDS.channels.general, mark);
      assert.equal(post.files.length, 1);
      assert.equal(post.files[0].name, 'image.png');
      assert.match(fetched[0].url, /^https:\/\/cdn\.discordapp\.com\//);
      assert.deepEqual(fetched[0].opts.allowedHosts, cdn.DISCORD_CDN_HOSTS);
    } finally {
      cdn.transport.http = before.http;
      h.client.config.cdnNetwork = before.net;
    }

    // 8) notifier_tous avec la permission : pré-contrôle de la sécurité AVANT l'envoi, puis rapport.
    sayWindows.clear();
    const seen = [];
    h.client.services.secur = { assertAllowed: async (interaction, type) => seen.push({ type, user: interaction.user.id, callsAt: h.fake.calls.length }) };
    const reported = [];
    const realReport = h.client.services.moderation.reportDestructiveAction;
    h.client.services.moderation.reportDestructiveAction = async (guild, user, type, o) => reported.push({ type, user: user.id, o });
    h.fake.intendedPingLabels.push(/annonce-generale/);
    try {
      mark = h.fake.calls.length;
      await h.slash('embed', texte([opt('message', 3, '@everyone assemblée générale à 21 h'), opt('notifier_tous', 5, true)]), { label: '/embed texte annonce-generale' });
      [post] = postsIn(h, IDS.channels.general, mark);
      assert.deepEqual(post.body.allowed_mentions.parse, ['everyone']);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, 'everyone');
      assert.ok(seen[0].callsAt <= h.fake.calls.indexOf(post), 'assertAllowed appelé avant l\'envoi');
      assert.deepEqual(reported, [{ type: 'everyone', user: IDS.users.admin, o: { count: 1 } }]);
      // Refus de la sécurité : rien n'est publié.
      sayWindows.clear();
      h.client.services.secur = { assertAllowed: async () => { throw Object.assign(new Error('Action bloquée par la sécurité (everyone) : demandez à un owner.'), { isUserError: true }); } };
      mark = h.fake.calls.length;
      const blocked = await h.slash('embed', texte([opt('message', 3, '@everyone encore'), opt('notifier_tous', 5, true)]), { label: '/embed texte annonce-generale bloquée' });
      assert.match(h.replyText(blocked), /bloquée par la sécurité/);
      assert.equal(postsIn(h, IDS.channels.general, mark).length, 0);
    } finally {
      delete h.client.services.secur;
      h.client.services.moderation.reportDestructiveAction = realReport;
    }

    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    sayWindows.clear();
    await h.close();
  }
});

test('/embed texte : exploré en administrateur, refusé à un membre ; fil archivé et bot sans accès refusés', async () => {
  const h = await createHarness({ restrictBot: true, botAdministrator: false });
  h.configureAll();
  try {
    const leaf = leavesOf(h.client.commands.get('embed').data.toJSON()).find((l) => l.path[0] === 'texte');
    sayWindows.clear();
    // Salon où le bot ne peut pas écrire (restrictBot : #général) : refus en embed.
    const noBot = await runLeaf(h, 'embed', leaf, { overrides: OVERRIDES['embed texte'] });
    assert.match(h.replyText(noBot), /Il me manque des permissions/);
    sayWindows.clear();
    const okRec = await runLeaf(h, 'embed', leaf, { overrides: { ...OVERRIDES['embed texte'], salon: IDS.channels.rules } });
    assert.match(h.replyText(okRec), /Message envoyé/);
    await explore(h, okRec, { budget: 10 });
    const member = await runLeaf(h, 'embed', leaf, { overrides: OVERRIDES['embed texte'], as: 'member' });
    assert.ok(h.isError(member));
    assert.match(h.replyText(member), /Gérer les messages/);
    // Fil archivé.
    sayWindows.clear();
    const thread = h.fake.channels.get(IDS.channels.thread);
    thread.thread_metadata = { ...thread.thread_metadata, archived: true };
    h.fake.dispatchNow('THREAD_UPDATE', thread, 'préparation : fil archivé');
    await h.settle();
    const archived = await h.slash('embed', texte([opt('message', 3, 'Bonjour'), opt('salon', 7, IDS.channels.thread)]), { channel: 'rules' });
    assert.match(h.replyText(archived), /archivé ou verrouillé/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    sayWindows.clear();
    await h.close();
  }
});
