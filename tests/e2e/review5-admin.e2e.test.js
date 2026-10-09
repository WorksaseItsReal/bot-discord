'use strict';

/**
 * Revue n° 5, bout en bout (vrai discord.js, faux Discord) : softban pendant la confirmation,
 * levées programmées (lockdown AntiRaid, /lock permanent, course avec /lock), AntiRaid et
 * suppressions faites par le bot, /channel cloner, sujet différé, confidentialité et coût de
 * /statistiques, expulsion de /activite (liste affichée, historique, AntiRaid), candidatures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const { createHarness, IDS } = require('./harness');
const { throwawayChannel } = require('./lib/overrides');
const { rawMember } = require('./lib/fixtures');
const { DAY } = require('./lib/ids');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const buttonsOf = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const destructiveAlerts = (h, mark) => botMessages(h, mark, (m) => /destructrice/i.test(m.embeds?.[0]?.title ?? ''));
const SEND = P.SendMessages;
const everyoneDeniesSend = (h, channelId) => {
  const ow = h.fake.channels.get(channelId).permission_overwrites.find((o) => o.id === IDS.roles.everyone);
  return Boolean(ow && (BigInt(ow.deny) & SEND) === SEND);
};
const expireTimers = (h) => h.client.database.db.prepare('UPDATE timed_channel_actions SET expires_at = ? WHERE active = 1').run(Date.now() - 1000);

async function setup() {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { enabled: false } });
  return h;
}

/** Membre ajouté sans événement d'arrivée, arrivé il y a `joinedDaysAgo` jours. */
function addSleeper(h, name, { joinedDaysAgo = 100, roles = [] } = {}) {
  const user = h.addUser(name, { ageDays: 500 });
  const raw = rawMember(user, roles, joinedDaysAgo);
  h.fake.members.set(user.id, raw);
  h.guild.members._add(JSON.parse(JSON.stringify(raw)));
  return user.id;
}

test('softban pendant la confirmation : un ban posé entre-temps n\'est jamais levé', async () => {
  const h = await setup();
  try {
    const soft = await h.slash('softban', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'spam')], { as: 'admin' });
    assert.match(h.replyText(soft), /Confirmation/);
    const ban = await h.slash('ban', [opt('membre', 6, IDS.users.target), opt('raison', 3, 'raid')], { as: 'admin', label: 'ban d\'un autre modérateur' });
    if (/Confirmation/.test(h.replyText(ban))) await h.confirm(ban);
    assert.ok(h.fake.bans.has(IDS.users.target));
    const unbansBefore = h.fake.calls.filter((c) => c.method === 'DELETE' && c.route.includes('/bans/')).length;
    await h.confirm(soft);
    await h.settle();
    assert.ok(h.fake.bans.has(IDS.users.target), 'le softban a levé le ban posé pendant la confirmation');
    assert.equal(h.fake.calls.filter((c) => c.method === 'DELETE' && c.route.includes('/bans/')).length, unbansBefore, 'débannissement envoyé');
    assert.match(h.replyText(soft), /déjà banni/);
    const types = h.client.database.db.prepare('SELECT type FROM sanctions WHERE user_id = ?').all(IDS.users.target).map((r) => r.type);
    assert.deepEqual(types, ['ban'], 'softban enregistré malgré le refus');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('levées programmées : refusées sur un lockdown ou un /lock sans échéance ; une durée sur un salon déjà temporaire la remplace', async () => {
  const h = await setup();
  const lockdown = h.client.services.lockdown;
  const timed = h.client.services.timedLocks;
  try {
    // Lockdown de l'AntiRaid (sans échéance) : /lockdown enable duree refusé, rien ne change.
    await lockdown.enable(h.guild, h.guild.members.me, 'AntiRaid automatique', { log: false, wait: true });
    const locked = lockdown.status(h.guild);
    assert.ok(locked > 0);
    const refused = await h.slash('lockdown', sub('enable', [opt('duree', 3, '30m')]), { as: 'admin' });
    assert.ok(h.isError(refused), h.replyText(refused));
    assert.match(h.replyText(refused), /sans échéance/);
    assert.equal(timed.activeFor(h.guild.id, 'lockdown', h.guild.id), null, 'levée programmée sur le lockdown de l\'AntiRaid');
    // Sans durée : toujours possible (permanent).
    const ok = await h.slash('lockdown', sub('enable'), { as: 'admin' });
    await h.confirm(ok);
    assert.equal(lockdown.status(h.guild), locked);
    await lockdown.disable(h.guild, h.guild.members.me);

    // /lock permanent puis /lock duree : refusé, le salon reste verrouillé sans échéance.
    const id = await throwawayChannel(h, 'verrou-permanent');
    await h.slash('lock', [opt('salon', 7, id)], { as: 'admin' });
    assert.ok(everyoneDeniesSend(h, id));
    const timedLock = await h.slash('lock', [opt('salon', 7, id), opt('duree', 3, '10m')], { as: 'admin' });
    assert.ok(h.isError(timedLock), h.replyText(timedLock));
    assert.match(h.replyText(timedLock), /sans échéance/);
    assert.equal(timed.activeFor(h.guild.id, 'lock', id), null);
    // Salon verrouillé AVEC échéance : une nouvelle durée la remplace.
    const other = await throwawayChannel(h, 'verrou-temporaire');
    assert.ok(!h.isError(await h.slash('lock', [opt('salon', 7, other), opt('duree', 3, '10m')], { as: 'admin' })));
    const first = timed.activeFor(h.guild.id, 'lock', other);
    assert.ok(first);
    assert.ok(!h.isError(await h.slash('lock', [opt('salon', 7, other), opt('duree', 3, '1h')], { as: 'admin' })));
    assert.ok(timed.activeFor(h.guild.id, 'lock', other).expires_at > first.expires_at);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('levée programmée et /lock simultanés : jamais d\'état sauvegardé effacé sur un salon re-verrouillé', async () => {
  const h = await setup();
  const lockdown = h.client.services.lockdown;
  const timed = h.client.services.timedLocks;
  try {
    const id = await throwawayChannel(h, 'course');
    await h.slash('lock', [opt('salon', 7, id), opt('duree', 3, '10m')], { as: 'admin' });
    expireTimers(h);
    h.fake.latency = 25; // les deux opérations se chevauchent vraiment
    const lift = timed.processDue();
    await new Promise((r) => setTimeout(r, 5));
    await h.slash('lock', [opt('salon', 7, id)], { as: 'admin', label: '/lock permanent pendant la levée' });
    await lift;
    await h.settle();
    h.fake.latency = 0;
    const locked = everyoneDeniesSend(h, id);
    const saved = lockdown.locks.get(h.guild.id, id);
    // Les deux ordres sont acceptables, mais l'état doit rester cohérent.
    assert.equal(Boolean(saved), locked, `salon ${locked ? 'verrouillé' : 'ouvert'} mais état sauvegardé ${saved ? 'présent' : 'absent'}`);
    assert.ok(locked, 'le /lock permanent posé pendant la levée a été levé');
    assert.equal(timed.activeFor(h.guild.id, 'lock', id), null);
    // /unlock restaure tout (fils compris), preuve que l'état d'origine est bien conservé.
    await h.slash('unlock', [opt('salon', 7, id)], { as: 'admin' });
    assert.ok(!everyoneDeniesSend(h, id));
    const ow = h.fake.channels.get(id).permission_overwrites.find((o) => o.id === IDS.roles.everyone);
    assert.ok(!ow || (BigInt(ow.deny) & P.SendMessagesInThreads) === 0n, 'refus d\'écrire dans les fils resté en place');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('AntiRaid : /channel supprimer et /role delete comptent au nom du modérateur', async () => {
  const h = await setup();
  h.configure({ antiraid: { enabled: true, joinThreshold: 1000, channelDeleteThreshold: 3, roleDeleteThreshold: 3, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
  try {
    let mark = h.fake.messageLog.length;
    for (let i = 0; i < 3; i += 1) {
      const id = await throwawayChannel(h, `nuke-${i}`);
      await h.confirm(await h.slash('channel', sub('supprimer', [opt('salon', 7, id)]), { as: 'admin' }));
      assert.ok(!h.fake.channels.has(id));
    }
    assert.equal(destructiveAlerts(h, mark).length, 1, 'suppressions de salons via le bot invisibles pour l\'AntiRaid');
    assert.deepEqual(h.fake.members.get(IDS.users.admin).roles, [], 'rôles de l\'auteur non retirés');

    // Rôles : rétablit l'administrateur puis supprime trois rôles via /role delete.
    h.fake.members.get(IDS.users.admin).roles = [IDS.roles.admin];
    h.fake.dispatchNow('GUILD_MEMBER_UPDATE', { ...h.fake.members.get(IDS.users.admin), guild_id: h.guild.id });
    await h.settle();
    const roles = [];
    for (let i = 0; i < 3; i += 1) {
      await h.slash('role', sub('create', [opt('nom', 3, `jetable-${i}`)]), { as: 'owner' });
      roles.push([...h.fake.roles.values()].find((r) => r.name === `jetable-${i}`).id);
    }
    mark = h.fake.messageLog.length;
    for (const roleId of roles) {
      const rec = await h.slash('role', sub('delete', [opt('role', 8, roleId)]), { as: 'admin' });
      if (/Confirmation/.test(h.replyText(rec))) await h.confirm(rec);
      assert.ok(!h.fake.roles.has(roleId));
    }
    assert.equal(destructiveAlerts(h, mark).length, 1, 'suppressions de rôles via le bot invisibles pour l\'AntiRaid');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/channel cloner : même contrôle que /channel creer ; /channel sujet acquitté même si Discord fait attendre', async () => {
  const h = await setup();
  try {
    const id = await throwawayChannel(h, 'salon-du-membre');
    const raw = h.fake.channels.get(id);
    raw.permission_overwrites.push({ id: IDS.users.member, type: 1, allow: String(P.ManageChannels | P.ViewChannel | P.SendMessages), deny: '0' });
    h.fake.dispatchNow('CHANNEL_UPDATE', raw);
    await h.settle();
    const before = h.fake.channels.size;
    const clone = await h.slash('channel', sub('cloner', [opt('nom', 3, 'copie')]), { as: 'member', channel: id });
    assert.ok(h.isError(clone), 'copie créée sans « Gérer les salons » sur la catégorie');
    assert.equal(h.fake.channels.size, before);
    const adminClone = await h.slash('channel', sub('cloner', [opt('salon', 7, id), opt('nom', 3, 'copie-admin')]), { as: 'admin' });
    assert.ok(!h.isError(adminClone), h.replyText(adminClone));
    assert.equal(h.fake.channels.size, before + 1);

    // Limite des sujets (2 / 10 min) : la requête attend 3,5 s, la commande est déjà acquittée.
    for (const [name, options] of [['sujet', [opt('texte', 3, 'Nouveau sujet'), opt('salon', 7, id)]], ['nsfw', [opt('actif', 5, true), opt('salon', 7, id)]]]) {
      h.fake.inject({ method: 'PATCH', route: `/channels/${id}` }, { status: 429, retryAfter: 3500 });
      const rec = await h.slash('channel', sub(name, options), { as: 'admin' });
      await h.waitFor(() => false, { timeout: 3800 });
      assert.equal(rec.ackType, 5, `/channel ${name} non différé`);
      assert.ok(!h.isError(rec), h.replyText(rec));
    }
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/statistiques publiques : salons privés absents pour un membre, présents pour la gestion ; délai entre deux clics', async () => {
  const h = await setup();
  h.configure({ automod: { enabled: false } });
  try {
    for (let i = 0; i < 5; i += 1) await h.userMessage({ as: 'mod', channel: 'staff', content: `réunion ${i}` });
    await h.userMessage({ as: 'member', channel: 'general', content: 'bonjour' });
    h.configure({ stats: { public: true } });
    const staff = IDS.channels.staff;
    const fieldsOf = (rec) => (h.messagesOf(rec)[0]?.embeds?.[0]?.fields ?? []).map((f) => `${f.name} ${f.value}`).join('\n');
    const textOf = (rec) => { const e = h.messagesOf(rec)[0]?.embeds?.[0]; return `${e?.description ?? ''}\n${fieldsOf(rec)}`; };

    const salons = await h.slash('statistiques', sub('serveur', [opt('vue', 3, 'salons')]), { as: 'member' });
    assert.equal(salons.ackType, 5, 'calcul non différé');
    assert.ok(!fieldsOf(salons).includes(staff), 'salon privé affiché à un membre');
    assert.match(fieldsOf(salons), new RegExp(IDS.channels.general));
    const server = await h.slash('statistiques', sub('serveur'), { as: 'member' });
    assert.match(textOf(server), /\*\*1\*\* message\(s\)/, 'messages du salon privé comptés pour un membre');
    const card = await h.slash('statistiques', sub('membre', [opt('membre', 6, IDS.users.mod)]), { as: 'member' });
    assert.ok(!fieldsOf(card).includes(staff), 'salon privé dans les « Salons favoris » d\'un autre membre');

    const managerView = await h.slash('statistiques', sub('serveur', [opt('vue', 3, 'salons')]), { as: 'admin' });
    assert.match(fieldsOf(managerView), new RegExp(staff), 'la gestion voit tous les salons');

    // Navigation : 5 s entre deux clics pour un membre (pas pour la gestion).
    const first = await h.click(h.messagesOf(server)[0], 'cmd:statistiques:nav', { values: ['heures'], as: 'member' });
    assert.ok(!h.isError(first));
    const second = await h.click(h.messagesOf(first)[0], 'cmd:statistiques:nav', { values: ['membres'], as: 'member' });
    assert.ok(h.isError(second));
    assert.match(h.replyText(second), /Patientez/);
    const m1 = await h.click(h.messagesOf(managerView)[0], 'cmd:statistiques:nav', { values: ['heures'] });
    const m2 = await h.click(h.messagesOf(m1)[0], 'cmd:statistiques:nav', { values: ['membres'] });
    assert.ok(!h.isError(m1) && !h.isError(m2));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/activite : expulse exactement la liste affichée (relue), historique des sanctions, arrêt si l\'AntiRaid retire les droits', async () => {
  const h = await setup();
  const G = h.guild.id;
  try {
    h.client.repositories.activity.setSince(G, Date.now() - 60 * DAY);
    // Membres du décor actifs aujourd'hui : seuls les dormeurs ajoutés sont inactifs.
    const day = new Date().toISOString().slice(0, 10);
    h.client.repositories.activity.applyBatch({ messages: [...h.fake.members.keys()].map((userId) => ({ guildId: G, day, channelId: IDS.channels.general, userId, count: 1 })) });
    const shown = [addSleeper(h, 'Dormeur0'), addSleeper(h, 'Dormeur1'), addSleeper(h, 'Dormeur2')];
    const list = await h.slash('activite', [], { as: 'admin' });
    const ask = await h.click(h.messagesOf(list)[0], 'cmd:activite:act:30:kick', { as: 'admin' });
    const kickformId = buttonsOf(h.messagesOf(ask)[0]).map((c) => c.custom_id).find((cid) => cid?.startsWith('cmd:activite:kickform:30:'));
    assert.ok(kickformId);
    // Entre la confirmation et l'envoi : Dormeur1 redevient actif, un nouvel inactif apparaît.
    await h.userMessage({ as: shown[1], channel: 'general', content: 'je suis là !' });
    const late = addSleeper(h, 'Retardataire');
    const form = await h.click(h.messagesOf(ask)[0], kickformId, { as: 'admin' });
    const done = await h.submitModal(form, { confirmation: 'EXPULSER', raison: '' }, { as: 'admin' });
    assert.match(h.replyText(done), /\*\*2\*\* membre\(s\) traité\(s\)/, h.replyText(done));
    assert.ok(!h.fake.members.has(shown[0]) && !h.fake.members.has(shown[2]));
    assert.ok(h.fake.members.has(shown[1]), 'membre redevenu actif expulsé');
    assert.ok(h.fake.members.has(late), 'membre absent de la liste affichée expulsé');
    const rows = h.client.database.db.prepare("SELECT user_id, type, reason, moderator_id FROM sanctions WHERE type = 'kick' ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [shown[0], shown[2]].sort());
    assert.ok(rows.every((r) => r.reason === 'Inactivité (30 jours)' && r.moderator_id === IDS.users.admin), JSON.stringify(rows));
    // Jeton consommé : un second envoi du même formulaire n'expulse personne.
    const again = await h.submitModal(form, { confirmation: 'EXPULSER', raison: '' }, { as: 'admin' });
    assert.ok(h.isError(again));
    assert.ok(h.fake.members.has(late));

    // AntiRaid (expulsions en masse, seuil 2) : l'auteur perd ses rôles, l'action s'arrête.
    h.configure({ antiraid: { enabled: true, joinThreshold: 1000, kickThreshold: 2, destructiveWindowSeconds: 60, punishExecutor: 'strip' } });
    const more = [addSleeper(h, 'Dormeur3'), addSleeper(h, 'Dormeur4'), addSleeper(h, 'Dormeur5')];
    const list2 = await h.slash('activite', [], { as: 'admin' });
    const ask2 = await h.click(h.messagesOf(list2)[0], 'cmd:activite:act:30:kick', { as: 'admin' });
    const id2 = buttonsOf(h.messagesOf(ask2)[0]).map((c) => c.custom_id).find((cid) => cid?.startsWith('cmd:activite:kickform:30:'));
    const mark = h.fake.messageLog.length;
    await h.submitModal(await h.click(h.messagesOf(ask2)[0], id2, { as: 'admin' }), { confirmation: 'EXPULSER', raison: '' }, { as: 'admin' });
    assert.equal(destructiveAlerts(h, mark).length, 1, 'expulsions groupées invisibles pour l\'AntiRaid');
    assert.deepEqual(h.fake.members.get(IDS.users.admin).roles, []);
    const kickedAfter = [late, ...more].filter((id) => !h.fake.members.has(id)).length;
    assert.equal(kickedAfter, 2, 'expulsions poursuivies après le retrait des droits de l\'auteur');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('candidatures : un seul ping par formulaire en 10 minutes, propre candidature non décidable', async () => {
  const h = await setup();
  try {
    const home = await h.slash('candidatures');
    const add = await h.click(h.messagesOf(home)[0], 'cmd:candidatures:create');
    const created = await h.submitModal(add, { name: 'Recrutement', description: 'x', questions: 'Pourquoi ?', cooldown: '0' });
    const form = h.client.services.applications.forms(h.guild.id)[0];
    let rec = await h.click(h.messagesOf(created)[0], `cmd:candidatures:review:${form.id}`, { values: [IDS.channels.staff] });
    rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:ping:${form.id}`, { values: [IDS.roles.mod] });
    rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:panelch:${form.id}`, { values: [IDS.channels.general] });
    rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:toggle:${form.id}:on`);
    const markPanel = h.fake.messageLog.length;
    rec = await h.click(h.messagesOf(rec)[0], `cmd:candidatures:publish:${form.id}`);
    const panel = botMessages(h, markPanel, (m) => m.channel_id === IDS.channels.general)[0];
    const mark = h.fake.messageLog.length;
    for (const as of ['member', 'admin']) {
      const open = await h.click(panel, `cmd:candidature:apply:${form.id}`, { as });
      assert.ok(!h.isError(await h.submitModal(open, { q0: `réponse de ${as}` }, { as })));
    }
    const cards = botMessages(h, mark, (m) => m.channel_id === IDS.channels.staff);
    assert.equal(cards.length, 2);
    assert.equal(cards.filter((m) => m.content?.includes(`<@&${IDS.roles.mod}>`)).length, 1, 'rôle pingué à chaque candidature');
    // L'administrateur ne peut pas accepter sa propre candidature.
    const own = cards[1];
    const accept = await h.click(own, buttonsOf(own).find((c) => c.custom_id.startsWith('cmd:candidatures:accept:')).custom_id, { as: 'admin' });
    assert.ok(h.isError(accept));
    assert.match(h.replyText(accept), /propre candidature/);
    const app = h.client.repositories.applications.listPending(h.guild.id, 5).find((a) => a.user_id === IDS.users.admin);
    assert.equal(app.status, 'pending');
    // Salon de réception public : signalé.
    const view = await h.click(h.messagesOf(await h.slash('candidatures'))[0], 'cmd:candidatures:pick', { values: [String(form.id)] });
    const pub = await h.click(h.messagesOf(view)[0], `cmd:candidatures:review:${form.id}`, { values: [IDS.channels.general] });
    assert.match(h.replyText(pub), /visible par @everyone/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
