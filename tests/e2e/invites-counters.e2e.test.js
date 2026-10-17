'use strict';

/**
 * Bout en bout : suivi des invitations (cache, arrivées réelles par GUILD_MEMBER_ADD,
 * log d'arrivée, /invitations) et compteurs de statistiques (/compteurs, création,
 * modal, renommage après une arrivée, salon supprimé à la main, permissions manquantes).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS, sleep } = require('./harness');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const DAY = 86_400_000;

/** Invitations simulées renvoyées par GET /guilds/:id/invites. */
function installInvites(h) {
  const invites = [];
  h.fake.routes.unshift({ method: 'GET', re: /^\/guilds\/(\d+)\/invites$/, keys: ['guild'], handler: () => JSON.parse(JSON.stringify(invites)) });
  const make = (code, inviterKey, extra = {}) => {
    const inv = {
      type: 0,
      code,
      guild: { id: IDS.guild, name: 'Serveur de test' },
      channel: { id: IDS.channels.general, name: 'général', type: 0 },
      inviter: h.fake.users.get(IDS.users[inviterKey] ?? inviterKey),
      uses: 0,
      max_uses: 0,
      max_age: 0,
      temporary: false,
      created_at: new Date(Date.now() - DAY).toISOString(),
      ...extra,
    };
    invites.push(inv);
    return inv;
  };
  return { invites, make };
}

/** Dernière carte d'arrivée publiée dans #logs. */
function lastJoinCard(h) {
  const msgs = h.fake.messageLog.map((id) => h.message(id)).filter((m) => m && m.channel_id === IDS.channels.logs && m.author.id === h.client.user.id);
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const e = msgs[i].embeds?.find((x) => /Nouveau membre|Bot ajouté/.test(x.title ?? ''));
    if (e) return e;
  }
  return null;
}
const inviteField = (embed) => embed?.fields?.find((f) => f.name.includes('Invitation'))?.value ?? '';
const joinCardCount = (h) => h.fake.messageLog.map((id) => h.message(id)).filter((m) => m?.channel_id === IDS.channels.logs && m.embeds?.some((e) => /Nouveau membre|Bot ajouté/.test(e.title ?? ''))).length;

test('suivi des invitations : arrivées réelles, cas limites, log d\'arrivée et /invitations', async () => {
  const h = await createHarness({ ready: false });
  const { invites, make } = installInvites(h);
  const alpha = make('alpha', 'admin');
  const beta = make('beta', 'mod', { uses: 2 });
  const gamma = make('gamma', 'member', { max_uses: 1 });
  h.configureAll();
  h.configure({ antiraid: { enabled: false }, welcome: { join: { enabled: false }, leave: { enabled: false } } });
  try {
    await h.emitReady();
    const svc = h.client.services.invites;
    assert.equal(svc.state(h.guild), 'ok');
    assert.ok(svc.hasSnapshot(h.guild.id), 'cache des invitations non construit au démarrage');

    // 1. Arrivée via « alpha » : attribuée à l'admin, une seule carte d'arrivée.
    const cardsBefore = joinCardCount(h);
    alpha.uses += 1;
    const a = h.addUser('Alice', { ageDays: 400 });
    await h.memberJoin(a);
    assert.equal(joinCardCount(h), cardsBefore + 1, 'la carte d\'arrivée doit être unique');
    assert.match(inviteField(lastJoinCard(h)), new RegExp(`Invité par <@${IDS.users.admin}> via \`alpha\` \\(\\*\\*1 invitation\\*\\*\\)`));

    // 2. Compte récent via « alpha » : fausse invitation.
    alpha.uses += 1;
    const young = h.addUser('Jeune', { ageDays: 1 });
    await h.memberJoin(young);
    assert.match(inviteField(lastJoinCard(h)), /fausse/);
    assert.deepEqual(h.client.repositories.inviteJoins.stats(h.guild.id, IDS.users.admin), { regular: 1, left: 0, fake: 1, net: 1 });

    // 3. Deux invitations utilisées en même temps : inconnue.
    alpha.uses += 1;
    beta.uses += 1;
    await h.memberJoin(h.addUser('Ambigu', { ageDays: 400 }));
    assert.match(inviteField(lastJoinCard(h)), /plusieurs invitations possibles/);

    // 4. Aucune invitation n'a bougé : inconnue.
    await h.memberJoin(h.addUser('Mystere', { ageDays: 400 }));
    assert.match(inviteField(lastJoinCard(h)), /^Invitation inconnue$/);

    // 5. Invitation à usage unique supprimée par Discord à l'arrivée (INVITE_DELETE avant l'arrivée).
    invites.splice(invites.indexOf(gamma), 1);
    h.fake.dispatchNow('INVITE_DELETE', { code: 'gamma', guild_id: IDS.guild, channel_id: IDS.channels.general });
    await h.memberJoin(h.addUser('Unique', { ageDays: 400 }));
    assert.match(inviteField(lastJoinCard(h)), new RegExp(`<@${IDS.users.member}> via \`gamma\``));

    // 6. Invitation créée pendant que le bot tourne (INVITE_CREATE), puis utilisée.
    const delta = make('delta', 'target');
    h.fake.dispatchNow('INVITE_CREATE', { code: 'delta', guild_id: IDS.guild, channel_id: IDS.channels.general, inviter: delta.inviter, uses: 0, max_uses: 0, max_age: 0, temporary: false, created_at: delta.created_at });
    delta.uses = 1;
    await h.memberJoin(h.addUser('Delta', { ageDays: 400 }));
    assert.match(inviteField(lastJoinCard(h)), new RegExp(`<@${IDS.users.target}> via \`delta\``));

    // 7. Bot ajouté par OAuth2.
    await h.memberJoin(h.addUser('RobotX', { ageDays: 400, bot: true }));
    assert.match(inviteField(lastJoinCard(h)), /OAuth2/);

    // 8. Départ d'Alice : compté pour l'admin.
    await h.memberLeave(a.id);
    assert.deepEqual(h.client.repositories.inviteJoins.stats(h.guild.id, IDS.users.admin), { regular: 1, left: 1, fake: 1, net: 0 });

    // /invitations voir (membre et soi-même), classement et ses boutons.
    const voir = await h.slash('invitations', sub('voir', [opt('membre', 6, IDS.users.admin)]), { as: 'member' });
    assert.match(h.replyText(voir), /Invitations · admin/);
    const card = h.messagesOf(voir)[0];
    assert.ok(card.embeds[0].fields.some((f) => f.name.includes('Fausses') && f.value.includes('1')));
    const mine = await h.slash('invitations', sub('voir'), { as: 'target' });
    assert.match(h.messagesOf(mine)[0].embeds[0].fields.find((f) => f.name.includes('Invitations actives')).value, /delta/);
    const board = await h.click(card, `cmd:invitations:page:0:${IDS.users.member}`, { as: 'member' });
    assert.match(h.replyText(board), /Classement des invitations/);
    const boardMsg = h.message(board.messages[0]) ?? h.messagesOf(board)[0];
    assert.match(boardMsg.embeds[0].description, new RegExp(`<@${IDS.users.member}>`));
    await h.click(boardMsg, `cmd:invitations:member:${IDS.users.member}`, { as: 'target' });
    const classement = await h.slash('invitations', sub('classement', [opt('page', 4, 3)]));
    assert.match(h.replyText(classement), /Classement des invitations/);

    // Réglages et réinitialisation : refusés sans « Gérer le serveur ».
    const refusedSettings = await h.slash('invitations', sub('reglages', [opt('jours', 4, 3)]), { as: 'member' });
    assert.ok(h.isError(refusedSettings));
    const refusedReset = await h.slash('invitations', sub('reinitialiser'), { as: 'member' });
    assert.ok(h.isError(refusedReset));
    await h.slash('invitations', sub('reglages', [opt('jours', 4, 3)]));
    assert.equal(h.client.services.config.get(h.guild.id).invites.fakeAccountDays, 3);

    // Annulation puis confirmation.
    const cancelled = await h.slash('invitations', sub('reinitialiser', [opt('membre', 6, IDS.users.admin)]));
    await h.confirm(cancelled, { cancel: true });
    assert.equal(h.client.repositories.inviteJoins.stats(h.guild.id, IDS.users.admin).regular, 1);
    const reset = await h.slash('invitations', sub('reinitialiser', [opt('membre', 6, IDS.users.admin)]));
    await h.confirm(reset);
    assert.equal(h.client.repositories.inviteJoins.stats(h.guild.id, IDS.users.admin).regular, 0);
    assert.ok(h.client.repositories.inviteJoins.stats(h.guild.id, IDS.users.member).regular >= 1, 'les autres inviteurs ne doivent pas être touchés');
    const all = await h.slash('invitations', sub('reinitialiser'));
    await h.confirm(all);
    assert.equal(h.client.repositories.inviteJoins.inviterCount(h.guild.id), 0);

    // Permission « Gérer le serveur » retirée : dégradation propre.
    const role = h.fake.roles.get(IDS.roles.bot);
    role.permissions = (P.ViewChannel | P.SendMessages | P.EmbedLinks | P.ReadMessageHistory | P.AttachFiles | P.ManageRoles).toString();
    h.fake.dispatchNow('GUILD_ROLE_UPDATE', { guild_id: IDS.guild, role });
    // Sans « Administrateur », le bot doit être autorisé explicitement dans #logs (salon du staff).
    const logs = h.fake.channels.get(IDS.channels.logs);
    logs.permission_overwrites.push({ id: IDS.roles.bot, type: 0, allow: P.ViewChannel.toString(), deny: '0' });
    h.fake.dispatchNow('CHANNEL_UPDATE', logs);
    await h.settle();
    assert.equal(svc.state(h.guild), 'noperm');
    const callsBefore = h.fake.calls.filter((c) => /\/invites$/.test(c.route)).length;
    await h.memberJoin(h.addUser('SansPerm', { ageDays: 400 }));
    assert.match(inviteField(lastJoinCard(h)), /Gérer le serveur/);
    assert.equal(h.fake.calls.filter((c) => /\/invites$/.test(c.route)).length, callsBefore, 'aucune lecture des invitations sans la permission');
    const degraded = await h.slash('invitations', sub('voir'));
    assert.match(h.messagesOf(degraded)[0].embeds[0].description, /Gérer le serveur/);

    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('compteurs de statistiques : tableau de bord, création, modal, mises à jour, nettoyage, permissions', async () => {
  const h = await createHarness({ botAdministrator: false });
  h.configureAll();
  h.configure({ antiraid: { enabled: false } });
  const svc = h.client.services.counters;
  svc.debounceMs = 10;
  const cfg = () => h.client.services.config.get(h.guild.id).statsCounters;
  const channelOf = (type) => h.fake.channels.get(cfg().counters[type].channelId);
  try {
    // Refus sans permission.
    const refused = await h.slash('compteurs', [], { as: 'member' });
    assert.ok(h.isError(refused));

    const dash = await h.slash('compteurs');
    const home = h.messagesOf(dash)[0];
    assert.match(home.embeds[0].title, /Compteurs/);
    const pick = h.findComponent(home, 'cmd:compteurs:pick');
    assert.ok(!pick.options.some((o) => o.value === 'online'), '« En ligne » ne doit pas être proposé sans l\'intent GuildPresences');
    assert.match(home.embeds[0].description, /GuildPresences/);

    // Un membre ne peut pas cliquer le tableau de bord.
    const denied = await h.click(home, 'cmd:compteurs:create', { as: 'member' });
    assert.ok(h.isError(denied));
    assert.equal(cfg().categoryId, null);

    // Création en un clic.
    const created = await h.click(home, 'cmd:compteurs:create');
    assert.match(h.replyText(created), /Compteurs prêts/);
    const category = h.fake.channels.get(cfg().categoryId);
    assert.equal(category?.type, 4);
    assert.equal(category.name, '📊 Statistiques');
    for (const type of ['members', 'humans', 'bots', 'boosts', 'channels', 'roles']) {
      const ch = channelOf(type);
      assert.ok(ch, `salon ${type} non créé`);
      assert.equal(ch.type, 2);
      assert.equal(ch.parent_id, category.id);
      const everyone = ch.permission_overwrites.find((o) => o.id === IDS.guild);
      assert.ok(BigInt(everyone.deny) & P.Connect, `${type} : Connect non refusé à @everyone`);
    }
    assert.equal(cfg().counters.online.channelId, null);
    assert.equal(channelOf('members').name, '👥 Membres : 7');
    assert.equal(channelOf('bots').name, '🤖 Bots : 2');

    // Vue d'un compteur, modal du modèle (renommage immédiat : jamais renommé).
    const view = await h.click(h.message(created.messages[0]) ?? home, 'cmd:compteurs:pick', { values: ['members'] });
    const viewMsg = h.messagesOf(view)[0];
    assert.match(viewMsg.embeds[0].title, /Membres/);
    const edit = await h.click(viewMsg, 'cmd:compteurs:edit:members');
    assert.equal(edit.modals.length, 1);
    const bad = await h.submitModal(edit, { modele: 'Sans variable' });
    assert.ok(h.isError(bad), 'un modèle sans {n} doit être refusé');
    const ok = await h.submitModal(edit, { modele: '👥 Total : {n}' });
    assert.match(h.replyText(ok), /Modèle enregistré/);
    assert.equal(channelOf('members').name, '👥 Total : 7');
    assert.ok(cfg().counters.members.renamedAt > 0);

    // Arrivée : mise à jour groupée (anti-rebond) ; « Membres » vient d'être renommé → attente.
    await h.memberJoin(h.addUser('Compte', { ageDays: 400 }));
    assert.ok(await h.waitFor(() => channelOf('humans').name === '🧑 Humains : 6'), `humains non mis à jour : ${channelOf('humans').name}`);
    assert.equal(channelOf('members').name, '👥 Total : 7', 'renommé deux fois en moins de 10 minutes');
    const renames = h.fake.calls.filter((c) => c.method === 'PATCH' && c.route === `/channels/${cfg().counters.humans.channelId}`).length;
    const summary = await svc.update(h.guild);
    assert.ok(summary.waiting.includes('members'));
    assert.ok(!summary.renamed.length);
    assert.equal(h.fake.calls.filter((c) => c.method === 'PATCH' && c.route === `/channels/${cfg().counters.humans.channelId}`).length, renames, 'renommé sans changement de valeur');

    // Désactiver puis réactiver un compteur.
    const botsView = await h.click(viewMsg, 'cmd:compteurs:pick', { values: ['bots'] });
    const botsId = cfg().counters.bots.channelId;
    const off = await h.click(h.messagesOf(botsView)[0], 'cmd:compteurs:toggle:bots:off');
    assert.ok(!h.fake.channels.has(botsId), 'salon non supprimé');
    assert.equal(cfg().counters.bots.channelId, null);
    await h.click(h.messagesOf(off)[0], 'cmd:compteurs:toggle:bots:on');
    assert.ok(channelOf('bots'), 'salon non recréé');

    // Salon supprimé à la main : retiré de la configuration.
    const roles = channelOf('roles');
    h.fake.channels.delete(roles.id);
    h.fake.dispatchNow('CHANNEL_DELETE', roles);
    await h.settle();
    assert.equal(cfg().counters.roles.channelId, null);
    assert.equal(cfg().counters.roles.enabled, false);

    // Permissions retirées sur un salon : signalées dans le tableau de bord.
    const boosts = channelOf('boosts');
    boosts.permission_overwrites = boosts.permission_overwrites.filter((o) => o.id !== IDS.users.bot);
    boosts.permission_overwrites.push({ id: IDS.users.bot, type: 1, allow: (P.ViewChannel | P.Connect).toString(), deny: P.ManageChannels.toString() });
    h.fake.dispatchNow('CHANNEL_UPDATE', boosts);
    await h.settle();
    const refreshed = await h.click(h.messagesOf(off)[0], 'cmd:compteurs:go:home');
    assert.match(h.messagesOf(refreshed)[0].embeds[0].description, /Je ne peux pas renommer \*\*1\*\* salon/);
    h.client.services.config.update(h.guild.id, { statsCounters: { counters: { boosts: { template: '💎 {n} boosts' } } } });
    const noperm = await svc.update(h.guild);
    assert.ok(noperm.noperm.includes('boosts'));

    // Bouton « Mettre à jour » et suppression complète (confirmation).
    const upd = await h.click(h.messagesOf(refreshed)[0], 'cmd:compteurs:refresh');
    assert.match(h.replyText(upd), /en attente|déjà à jour|sans permission/);
    let confirmView = await h.click(h.messagesOf(upd)[0], 'cmd:compteurs:go:confirmRemove');
    const partial = await h.click(h.messagesOf(confirmView)[0], 'cmd:compteurs:remove');
    assert.match(h.replyText(partial), /Impossible de supprimer : \*\*Boosts\*\*/);
    assert.ok(h.fake.channels.has(boosts.id), 'salon sans permission : conservé');
    assert.equal(cfg().counters.boosts.channelId, boosts.id, 'salon non supprimé : toujours configuré');
    // Permission rendue : suppression complète.
    boosts.permission_overwrites = boosts.permission_overwrites.filter((o) => o.id !== IDS.users.bot);
    h.fake.dispatchNow('CHANNEL_UPDATE', boosts);
    await h.settle();
    confirmView = await h.click(h.messagesOf(partial)[0], 'cmd:compteurs:go:confirmRemove');
    await h.click(h.messagesOf(confirmView)[0], 'cmd:compteurs:remove');
    assert.ok(![...h.fake.channels.values()].some((c) => c.parent_id === category.id), 'des salons compteurs subsistent');
    assert.ok(!h.fake.channels.has(category.id), 'catégorie non supprimée');
    assert.equal(cfg().categoryId, null);
    assert.equal(cfg().counters.members.template, null);

    await sleep(20);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
