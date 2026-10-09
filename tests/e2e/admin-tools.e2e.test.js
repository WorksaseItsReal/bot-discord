'use strict';

/**
 * Bout en bout : outils de modération et d'administration sur le vrai discord.js —
 * AutoMod des pseudos (tableau de bord + arrivées / changements de nom réels), /softban,
 * /modstats, levées automatiques (/lock duree, /slowmode pendant, /lockdown enable duree)
 * traitées par le vrai SchedulerService, /role modifier, gestion des salons (/channel)
 * et des emojis (/emoji, téléchargement simulé : le réseau est coupé dans les tests).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { explore } = require('./lib/explore');
const { throwawayChannel } = require('./lib/overrides');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const logTitles = (h, mark) => botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs).map((m) => m.embeds?.[0]?.title ?? '');
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const SEND = PermissionFlagsBits.SendMessages;
const everyoneDeniesSend = (h, channelId) => {
  const ow = h.fake.channels.get(channelId).permission_overwrites.find((o) => o.id === IDS.roles.everyone);
  return Boolean(ow && (BigInt(ow.deny) & SEND) === SEND);
};
const expireTimers = (h) => h.client.database.db.prepare('UPDATE timed_channel_actions SET expires_at = ? WHERE active = 1').run(Date.now() - 1000);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

async function setup() {
  const h = await createHarness();
  h.configureAll();
  // Plusieurs arrivées rapprochées : l'AntiRaid les expulserait.
  h.configure({ antiraid: { enabled: false } });
  return h;
}

/** Le membre change lui-même de pseudo (événement de passerelle réel). */
async function selfNick(h, userId, nick) {
  const m = h.fake.members.get(userId);
  m.nick = nick;
  h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...m, guild_id: h.guild.id }, `pseudo ${nick}`);
  await h.settle();
}

test('AutoMod des pseudos : tableau de bord (vue, vérifications, modèle), refus sans permission', async () => {
  const h = await setup();
  try {
    const rec = await h.slash('automod');
    const grp = await h.click(h.messagesOf(rec)[0], 'cmd:automod:nav', { values: ['grp:security'] });
    assert.match(h.replyText(grp), /Pseudos/);
    const view = await h.click(h.messagesOf(grp)[0], 'cmd:automod:fpick:security', { values: ['badNames'] });
    assert.match(h.replyText(view), /Pseudos/);
    const stats = await explore(h, view, { budget: 60, skip: (a) => a.customId.startsWith('cmd:automod:go') || a.customId === 'cmd:automod:nav' });
    for (const key of ['cmd:automod:pcheck', 'cmd:automod:fexrole', 'cmd:automod:ftoggle', 'cmd:automod:fset']) assert.ok(stats.keys.has(key), `${key} jamais utilisé`);

    // Modèle : valide enregistré, modèle qui serait lui-même filtré refusé (tableau de bord rouvert).
    const again = await h.slash('automod');
    const grp2 = await h.click(h.messagesOf(again)[0], 'cmd:automod:nav', { values: ['grp:security'] });
    const fresh = await h.click(h.messagesOf(grp2)[0], 'cmd:automod:fpick:security', { values: ['badNames'] });
    const open = await h.click(h.messagesOf(fresh)[0], 'cmd:automod:fset:badNames');
    assert.equal(open.modals.length, 1);
    const saved = await h.submitModal(open, { template: 'Visiteur {id}' });
    assert.ok(!h.isError(saved), h.replyText(saved));
    assert.equal(h.client.services.config.get(h.guild.id).automod.filters.badNames.template, 'Visiteur {id}');
    const open2 = await h.click(h.messagesOf(saved)[0], 'cmd:automod:fset:badNames');
    const bad = await h.submitModal(open2, { template: '!Admin {id}' });
    assert.ok(h.isError(bad), 'modèle filtré accepté');
    assert.equal(h.client.services.config.get(h.guild.id).automod.filters.badNames.template, 'Visiteur {id}');

    // Membre sans « Gérer le serveur » : refusé, rien ne change.
    const denied = await h.slash('automod', [], { as: 'member' });
    assert.ok(h.isError(denied));
    const before = JSON.stringify(h.client.services.config.get(h.guild.id).automod.filters.badNames);
    await explore(h, fresh, { as: 'member', budget: 15 });
    assert.equal(JSON.stringify(h.client.services.config.get(h.guild.id).automod.filters.badNames), before, 'un membre a modifié le filtre');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('AutoMod des pseudos : arrivées et changements de nom réels, sans boucle ni écraser le staff', async () => {
  const h = await setup();
  h.configure({ automod: { enabled: true, filters: { badNames: { enabled: true, template: 'Membre {id}', dehoist: true, words: true, impersonation: true, unreadable: true }, badWords: { enabled: true, words: ['interdit'] } } } });
  const nickPatches = (userId, mark) => h.fake.calls.slice(mark).filter((c) => c.method === 'PATCH' && c.route.endsWith(`/members/${userId}`) && 'nick' in (c.body ?? {}));
  try {
    // Arrivée avec un pseudo « remonté » : renommé une seule fois, journalisé.
    let mark = h.fake.messageLog.length;
    let calls = h.fake.calls.length;
    const hoister = h.addUser('!!!Hoister', { ageDays: 300 });
    await h.memberJoin(hoister);
    const expected = `Membre ${hoister.id.slice(-4)}`;
    assert.equal(h.fake.members.get(hoister.id).nick, expected);
    assert.equal(nickPatches(hoister.id, calls).length, 1, 'renommage en boucle');
    assert.ok(logTitles(h, mark).some((t) => /Pseudo renommé/.test(t)), 'renommage non journalisé');

    // Le membre change de pseudo : usurpation (homoglyphes), mot interdit, zalgo.
    for (const nick of ['Аdmin', 'S.t.a.f.f', 'roi interdit', 'Z̷̢̛a̴l̵g̶o̷̊̋']) {
      calls = h.fake.calls.length;
      await selfNick(h, IDS.users.target, nick);
      assert.equal(h.fake.members.get(IDS.users.target).nick, `Membre ${IDS.users.target.slice(-4)}`, `« ${nick} » non renommé`);
      assert.equal(nickPatches(IDS.users.target, calls).length, 1, `« ${nick} » : renommage en boucle`);
    }
    // Imitation d'un modérateur (« Modo ») à un homoglyphe près.
    await selfNick(h, IDS.users.target, 'Мodo');
    assert.equal(h.fake.members.get(IDS.users.target).nick, `Membre ${IDS.users.target.slice(-4)}`);
    // Pseudo correct : intact.
    await selfNick(h, IDS.users.target, 'Gentil membre');
    assert.equal(h.fake.members.get(IDS.users.target).nick, 'Gentil membre');

    // Nom global modifié (membre sans pseudo de serveur) : vérifié aussi.
    const member = h.fake.members.get(IDS.users.member);
    const u = h.fake.users.get(IDS.users.member);
    u.global_name = 'Discord Support';
    member.user = { ...member.user, global_name: 'Discord Support' };
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...member, guild_id: h.guild.id }, 'nom global');
    await h.settle();
    assert.equal(h.fake.members.get(IDS.users.member).nick, `Membre ${IDS.users.member.slice(-4)}`, 'nom global non vérifié');

    // Staff exempté ; pseudo posé par un modérateur via /pseudo respecté.
    await selfNick(h, IDS.users.mod, '!Modo');
    assert.equal(h.fake.members.get(IDS.users.mod).nick, '!Modo');
    const pseudo = await h.slash('pseudo', [opt('membre', 6, IDS.users.target), opt('pseudo', 3, '!Événement')], { as: 'admin' });
    assert.ok(!h.isError(pseudo), h.replyText(pseudo));
    assert.equal(h.fake.members.get(IDS.users.target).nick, '!Événement', 'choix du modérateur écrasé');

    // Filtre désactivé : plus rien.
    h.configure({ automod: { filters: { badNames: { enabled: false } } } });
    await selfNick(h, IDS.users.target, '!Libre');
    assert.equal(h.fake.members.get(IDS.users.target).nick, '!Libre');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/softban : confirmation, ban puis débannissement, sanction « Softban » ; refus', async () => {
  const h = await setup();
  try {
    const victim = h.addUser('Spammeur', { ageDays: 300 });
    await h.memberJoin(victim);
    const mark = h.fake.messageLog.length;
    const rec = await h.slash('softban', [opt('membre', 6, victim.id), opt('raison', 3, 'Spam de liens'), opt('jours_messages', 4, 2)], { as: 'admin' });
    const click = await h.confirm(rec);
    assert.ok(click, 'confirmation attendue');
    await h.settle();
    const ban = h.fake.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/bans/${victim.id}`));
    assert.equal(ban?.body?.delete_message_seconds, 2 * 86_400);
    assert.ok(h.fake.calls.some((c) => c.method === 'DELETE' && c.route.endsWith(`/bans/${victim.id}`)), 'débannissement manquant');
    assert.equal(h.fake.bans.has(victim.id), false, 'toujours banni');
    assert.equal(h.fake.members.has(victim.id), false, 'toujours membre');
    const [row] = h.client.repositories.sanctions.listByUser(h.guild.id, victim.id);
    assert.equal(row.type, 'softban');
    assert.match(h.replyText(click), /softbanni/i);
    assert.ok(logTitles(h, mark).some((t) => /softbanni/i.test(t)), 'sanction non journalisée');
    assert.ok(!logTitles(h, mark).some((t) => /^.*Membre (banni|débanni)$/.test(t)), 'ban/débannissement journalisés en double');
    // Historique : type affiché, filtre disponible.
    const hist = await h.slash('sanctions', sub('historique', [opt('membre', 6, victim.id)]), { as: 'admin' });
    assert.match(h.replyText(hist) + JSON.stringify(h.messagesOf(hist)[0]?.embeds ?? []), /Softban/);
    await explore(h, click, { budget: 10 });

    // Refus : membre sans « Bannir », propriétaire, utilisateur déjà banni (jamais débanni).
    const victim2 = h.addUser('Autre', { ageDays: 300 });
    await h.memberJoin(victim2);
    assert.ok(h.isError(await h.slash('softban', [opt('membre', 6, victim2.id)], { as: 'member' })));
    assert.ok(h.fake.members.has(victim2.id));
    h.configure({ moderation: { confirmDangerous: false } });
    assert.ok(h.isError(await h.slash('softban', [opt('membre', 6, IDS.users.owner)], { as: 'admin' })));
    const banned = h.addUser('DejaBanni', { ageDays: 300 });
    h.fake.bans.set(banned.id, { user: banned, reason: 'test' });
    const refused = await h.slash('softban', [opt('membre', 6, banned.id)], { as: 'admin' });
    assert.ok(h.isError(refused), h.replyText(refused));
    assert.ok(h.fake.bans.has(banned.id), 'un softban a levé un bannissement existant');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/modstats : statistiques réelles, périodes et modérateur, refus sans permission', async () => {
  const h = await setup();
  h.configure({ moderation: { confirmDangerous: false } });
  try {
    await h.slash('warn', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'Insultes')], { as: 'mod' });
    await h.slash('warn', [opt('membre', 6, IDS.users.member), opt('raison', 3, 'insultes')], { as: 'mod' });
    await h.slash('timeout', [opt('membre', 6, IDS.users.member), opt('duree', 3, '10m'), opt('raison', 3, 'Spam')], { as: 'admin' });
    const rec = await h.slash('modstats', [], { as: 'mod' });
    const text = h.replyText(rec);
    assert.match(text, /Statistiques de modération · 30 jours/);
    assert.match(text, /\*\*3\*\* sanction/);
    const embed = h.messagesOf(rec)[0].embeds[0];
    assert.ok(embed.fields.some((f) => /insultes — \*\*2\*\*/.test(f.value)), 'raisons regroupées');
    const stats = await explore(h, rec, { budget: 20, as: 'mod' });
    assert.ok(stats.keys.has('cmd:modstats:view'));
    const one = await h.slash('modstats', [opt('periode', 4, 7), opt('moderateur', 6, IDS.users.mod)], { as: 'admin' });
    assert.match(h.replyText(one), /\*\*2\*\* sanction/);
    await explore(h, one, { budget: 10 });
    assert.ok(h.isError(await h.slash('modstats', [], { as: 'member' })));
    // Bouton d'un modérateur cliqué par un membre : refusé.
    const msg = h.messagesOf(rec)[0];
    const refused = await h.click(msg, buttonsOf(msg).find((b) => b.custom_id?.startsWith('cmd:modstats:view') && !b.disabled).custom_id, { as: 'member' });
    assert.ok(h.isError(refused) || refused.ackType != null);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('levées automatiques : /lock duree, /slowmode pendant, /lockdown enable duree (vrai scheduler)', async () => {
  const h = await setup();
  const repo = h.client.repositories.timedActions;
  const G = IDS.channels.general;
  try {
    // /lock duree puis /unlock : la levée programmée est annulée.
    const lock = await h.slash('lock', [opt('salon', 7, G), opt('duree', 3, '1h')]);
    assert.ok(!h.isError(lock), h.replyText(lock));
    assert.ok(everyoneDeniesSend(h, G));
    assert.match(JSON.stringify(h.messagesOf(lock)[0].embeds[0].fields), /Levée automatique/);
    assert.ok(repo.activeFor(h.guild.id, 'lock', G));
    await h.slash('unlock', [opt('salon', 7, G)]);
    assert.equal(repo.activeFor(h.guild.id, 'lock', G), null, 'levée non annulée par /unlock');

    // /lock duree : levé à l'échéance par le scheduler, journalisé.
    await h.slash('lock', [opt('salon', 7, G), opt('duree', 3, '30m')]);
    let mark = h.fake.messageLog.length;
    expireTimers(h);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.ok(!everyoneDeniesSend(h, G), 'salon toujours verrouillé');
    assert.ok(logTitles(h, mark).some((t) => /Verrouillage levé automatiquement/.test(t)), logTitles(h, mark).join(' | '));
    // Durée invalide ou trop courte : refusée, rien n'est verrouillé.
    assert.ok(h.isError(await h.slash('lock', [opt('salon', 7, G), opt('duree', 3, '20s')])));
    assert.ok(!everyoneDeniesSend(h, G));

    // /slowmode pendant : retour au délai d'avant ; une nouvelle valeur manuelle annule la levée.
    const slow = await h.slash('slowmode', [opt('duree', 3, '10s'), opt('salon', 7, G), opt('pendant', 3, '2h')]);
    assert.ok(!h.isError(slow), h.replyText(slow));
    assert.equal(h.fake.channels.get(G).rate_limit_per_user, 10);
    mark = h.fake.messageLog.length;
    expireTimers(h);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.equal(h.fake.channels.get(G).rate_limit_per_user, 0, 'mode lent non levé');
    assert.ok(logTitles(h, mark).some((t) => /Mode lent levé automatiquement/.test(t)));
    await h.slash('slowmode', [opt('duree', 3, '10s'), opt('salon', 7, G), opt('pendant', 3, '2h')]);
    await h.slash('slowmode', [opt('duree', 3, '30s'), opt('salon', 7, G)]);
    assert.equal(repo.activeFor(h.guild.id, 'slowmode', G), null, 'levée non annulée par un nouveau mode lent');
    expireTimers(h);
    await h.client.services.scheduler.tick();
    assert.equal(h.fake.channels.get(G).rate_limit_per_user, 30, 'valeur manuelle écrasée');

    // /lockdown enable duree : confirmation, état, levée automatique.
    const ld = await h.slash('lockdown', sub('enable', [opt('duree', 3, '1h')]));
    await h.confirm(ld);
    await h.settle();
    assert.ok(h.client.services.lockdown.status(h.guild) > 0);
    assert.ok(repo.activeFor(h.guild.id, 'lockdown', h.guild.id));
    const status = await h.slash('lockdown', sub('status'));
    assert.match(JSON.stringify(h.messagesOf(status)[0].embeds[0].fields), /Levée automatique/);
    mark = h.fake.messageLog.length;
    expireTimers(h);
    await h.client.services.scheduler.tick();
    await h.settle();
    assert.equal(h.client.services.lockdown.status(h.guild), 0, 'lockdown non levé');
    assert.ok(logTitles(h, mark).some((t) => /Lockdown levé/.test(t)));
    assert.ok(h.isError(await h.slash('lockdown', sub('enable', [opt('duree', 3, 'demain')]))));

    // Membre sans permission : refusé.
    assert.ok(h.isError(await h.slash('lock', [opt('salon', 7, G), opt('duree', 3, '1h')], { as: 'member' })));
    assert.ok(!everyoneDeniesSend(h, G));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/role modifier : nom, couleur, affichage, mention ; hiérarchie et permission', async () => {
  const h = await setup();
  try {
    const rec = await h.slash('role', sub('modifier', [opt('role', 8, IDS.roles.notif), opt('nom', 3, 'Annonces'), opt('couleur', 3, '#ff8800'), opt('affiche_separement', 5, true), opt('mentionnable', 5, true)]));
    assert.ok(!h.isError(rec), h.replyText(rec));
    const r = h.fake.roles.get(IDS.roles.notif);
    assert.deepEqual([r.name, r.colors?.primary_color ?? r.color, r.hoist, r.mentionable], ['Annonces', 0xff8800, true, true]);
    assert.match(h.replyText(rec), /Rôle modifié/);
    await explore(h, rec, { budget: 5 });
    assert.ok(h.isError(await h.slash('role', sub('modifier', [opt('role', 8, IDS.roles.notif)]))), 'aucune option');
    assert.ok(h.isError(await h.slash('role', sub('modifier', [opt('role', 8, IDS.roles.notif), opt('couleur', 3, 'rouge')]))));
    assert.ok(h.isError(await h.slash('role', sub('modifier', [opt('role', 8, IDS.roles.admin), opt('nom', 3, 'Pirate')]), { as: 'admin' })), 'rôle au niveau de l\'auteur');
    assert.ok(h.isError(await h.slash('role', sub('modifier', [opt('role', 8, IDS.roles.gamer), opt('nom', 3, 'X')]), { as: 'member' })));
    assert.notEqual(h.fake.roles.get(IDS.roles.gamer).name, 'X');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/channel : info (inchangée en sous-commande), créer, cloner, renommer, sujet, NSFW, supprimer', async () => {
  const h = await setup();
  try {
    const info = await h.slash('channel', sub('info', [opt('salon', 7, IDS.channels.general)]), { as: 'member' });
    assert.ok(!h.isError(info) && h.messagesOf(info)[0].embeds[0].fields.some((f) => /Identifiant/.test(f.name)));

    const created = await h.slash('channel', sub('creer', [opt('nom', 3, 'salon-vocal'), opt('type', 3, 'vocal'), opt('categorie', 7, IDS.channels.catVoice)]));
    assert.ok(!h.isError(created), h.replyText(created));
    const newCh = [...h.fake.channels.values()].find((c) => c.name === 'salon-vocal');
    assert.deepEqual([newCh?.type, newCh?.parent_id], [2, IDS.channels.catVoice]);
    assert.ok(h.isError(await h.slash('channel', sub('creer', [opt('nom', 3, 'x'), opt('type', 3, 'vocal'), opt('sujet', 3, 'Sujet')]))), 'sujet sur un vocal');

    const target = await throwawayChannel(h, 'a-gerer');
    const cloned = await h.slash('channel', sub('cloner', [opt('salon', 7, target), opt('nom', 3, 'copie')]));
    assert.ok(!h.isError(cloned), h.replyText(cloned));
    assert.ok([...h.fake.channels.values()].some((c) => c.name === 'copie'));
    await h.slash('channel', sub('renommer', [opt('nom', 3, 'renomme'), opt('salon', 7, target)]));
    assert.equal(h.fake.channels.get(target).name, 'renomme');
    await h.slash('channel', sub('sujet', [opt('texte', 3, 'Règles du salon'), opt('salon', 7, target)]));
    assert.equal(h.fake.channels.get(target).topic, 'Règles du salon');
    await h.slash('channel', sub('sujet', [opt('salon', 7, target)]));
    assert.equal(h.fake.channels.get(target).topic ?? null, null);
    await h.slash('channel', sub('nsfw', [opt('actif', 5, true), opt('salon', 7, target)]));
    assert.equal(h.fake.channels.get(target).nsfw, true);

    // Supprimer : confirmation ; jamais le salon courant ; membre refusé.
    assert.ok(h.isError(await h.slash('channel', sub('supprimer', [opt('salon', 7, IDS.channels.general)]))), 'salon courant supprimé');
    assert.ok(h.isError(await h.slash('channel', sub('supprimer', [opt('salon', 7, target)]), { as: 'member' })));
    const cancel = await h.slash('channel', sub('supprimer', [opt('salon', 7, target)]));
    await h.confirm(cancel, { cancel: true });
    assert.ok(h.fake.channels.has(target), 'supprimé malgré l\'annulation');
    const del = await h.slash('channel', sub('supprimer', [opt('salon', 7, target)]));
    const done = await h.confirm(del);
    await h.settle();
    assert.equal(h.fake.channels.has(target), false, 'salon non supprimé');
    assert.match(h.replyText(done), /Salon supprimé/);

    // Membre sans « Gérer les salons » : toutes les sous-commandes de gestion refusées.
    const victim = await throwawayChannel(h, 'intouchable');
    for (const [name, options] of [['creer', [opt('nom', 3, 'pirate')]], ['cloner', [opt('salon', 7, victim)]], ['renommer', [opt('nom', 3, 'pirate'), opt('salon', 7, victim)]], ['sujet', [opt('texte', 3, 'pirate'), opt('salon', 7, victim)]], ['nsfw', [opt('actif', 5, true), opt('salon', 7, victim)]]]) {
      assert.ok(h.isError(await h.slash('channel', sub(name, options), { as: 'member' })), name);
    }
    assert.deepEqual([h.fake.channels.get(victim).name, h.fake.channels.get(victim).nsfw], ['intouchable', false]);
    assert.ok(![...h.fake.channels.values()].some((c) => c.name === 'pirate'));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/emoji : affichage conservé, ajout (pièce jointe ou lien Discord, réseau simulé), renommage, suppression', async () => {
  const h = await setup();
  h.fetch = async (url, init) => {
    h.fetches.push({ url: String(url), init });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  try {
    const show = await h.slash('emoji', sub('info', [opt('emoji', 3, `<:gadget:${IDS.emoji}>`)]), { as: 'member' });
    assert.match(h.replyText(show), /:gadget:/);
    const dm = await h.slash('emoji', sub('info', [opt('emoji', 3, '😀')]), { channel: 'dm', as: 'member' });
    assert.ok(!h.isError(dm));
    assert.ok(h.isError(await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'test_dm'), opt('url', 3, 'https://cdn.discordapp.com/emojis/123456789012345678.png')]), { channel: 'dm', as: 'member' })));

    // Lien d'un emoji Discord.
    const byUrl = await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'gadget_ok'), opt('url', 3, 'https://cdn.discordapp.com/emojis/123456789012345678.png?size=64')]));
    assert.ok(!h.isError(byUrl), h.replyText(byUrl));
    assert.ok(h.fake.guild.emojis.some((e) => e.name === 'gadget_ok'));
    assert.match(h.replyText(byUrl), /Emoji ajouté/);
    // Pièce jointe.
    const attachmentId = String(BigInt(IDS.guild) + 4242n);
    const byFile = await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'depuis_image'), opt('image', 11, attachmentId)]));
    assert.ok(!h.isError(byFile), h.replyText(byFile));
    assert.ok(h.fake.guild.emojis.some((e) => e.name === 'depuis_image'));
    assert.ok(h.fetches.every((f) => new URL(f.url).hostname === 'cdn.discordapp.com'), 'téléchargement hors de cdn.discordapp.com');
    assert.ok(h.fetches.every((f) => f.init?.redirect === 'error' && f.init?.signal), 'téléchargement sans délai ni blocage des redirections');

    // Refus : autre hôte (sans téléchargement), nom pris, image trop lourde, membre.
    const fetched = h.fetches.length;
    assert.ok(h.isError(await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'externe'), opt('url', 3, 'https://example.com/emojis/123456789012345678.png')]))));
    assert.ok(h.isError(await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'local'), opt('url', 3, 'https://127.0.0.1/emojis/123456789012345678.png')]))));
    assert.equal(h.fetches.length, fetched, 'téléchargement vers un hôte refusé');
    assert.ok(h.isError(await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'gadget_ok'), opt('url', 3, 'https://cdn.discordapp.com/emojis/123456789012345678.png')]))));
    h.fetch = async () => new Response(Buffer.alloc(300 * 1024, 1), { status: 200 });
    assert.ok(h.isError(await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'trop_lourd'), opt('url', 3, 'https://cdn.discordapp.com/emojis/123456789012345678.png')]))));
    assert.ok(h.isError(await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'membre'), opt('url', 3, 'https://cdn.discordapp.com/emojis/123456789012345678.png')]), { as: 'member' })));
    assert.ok(!h.fake.guild.emojis.some((e) => ['externe', 'local', 'trop_lourd', 'membre'].includes(e.name)));

    // Renommer puis supprimer (confirmation).
    const renamed = await h.slash('emoji', sub('renommer', [opt('emoji', 3, 'gadget_ok'), opt('nom', 3, 'gadget_top')]));
    assert.ok(!h.isError(renamed), h.replyText(renamed));
    assert.ok(h.fake.guild.emojis.some((e) => e.name === 'gadget_top'));
    assert.ok(h.isError(await h.slash('emoji', sub('renommer', [opt('emoji', 3, 'gadget_top'), opt('nom', 3, 'pirate')]), { as: 'member' })));
    const del = await h.slash('emoji', sub('supprimer', [opt('emoji', 3, ':gadget_top:')]));
    const done = await h.confirm(del);
    await h.settle();
    assert.ok(!h.fake.guild.emojis.some((e) => e.name === 'gadget_top'), 'emoji non supprimé');
    assert.match(h.replyText(done), /Emoji supprimé/);

    // Limite du serveur (niveau de boost) : refus clair.
    const many = Array.from({ length: 250 }, (_, i) => ({ id: String(BigInt(IDS.emoji) + BigInt(i + 1)), name: `plein_${i}`, roles: [], require_colons: true, managed: false, animated: false, available: true }));
    h.fake.guild.emojis = [...h.fake.guild.emojis, ...many];
    h.fake.dispatchNow('GUILD_EMOJIS_UPDATE', { guild_id: h.guild.id, emojis: h.fake.guild.emojis }, 'emojis pleins');
    await h.settle();
    h.fetch = async () => new Response(PNG, { status: 200 });
    const full = await h.slash('emoji', sub('ajouter', [opt('nom', 3, 'de_trop'), opt('url', 3, 'https://cdn.discordapp.com/emojis/123456789012345678.png')]));
    assert.ok(h.isError(full) && /Limite/.test(h.replyText(full)), h.replyText(full));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
