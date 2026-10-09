'use strict';

/**
 * Bout en bout : limites connues restées ouvertes après trois revues
 * (niveaux et membres partis, expulsions massives, ordre des rôles et permissions
 * à la restauration, défi anti-robot en lettres, pièces jointes des transcripts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');
const { nextId } = require('./lib/ids');
const { numberToFrench } = require('../../src/services/WelcomeService');
const { levelFromXp } = require('../../src/services/LevelService');

const opt = (name, type, value) => ({ name, type, value });
const sub = (name, options = []) => [{ name, type: 1, options }];
const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author.id === h.client.user.id && pred(m));
const hasButton = (prefix) => (m) => (m.components ?? []).some((r) => r.components.some((c) => c.custom_id?.startsWith(prefix)));
const embedText = (m) => (m?.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])]).filter(Boolean).join('\n');
/** Message (brut) mis à jour par une interaction de composant / formulaire. */
const updated = (h, rec) => h.message(rec.componentMessageId ?? rec.original);

async function setup() {
  const h = await createHarness();
  h.configureAll();
  return h;
}

test('niveaux : un membre parti quitte le classement (XP conservée), revient, purge des départs', async () => {
  const h = await setup();
  try {
    h.configure({ antiraid: { enabled: false } });
    const repo = h.client.repositories.levels;
    const guildId = h.guild.id;
    repo.setXp(guildId, IDS.users.target, 900, levelFromXp);
    repo.setXp(guildId, IDS.users.member, 400, levelFromXp);
    const ancien = h.addUser('Ancien', { ageDays: 400 });
    await h.memberJoin(ancien);
    repo.setXp(guildId, ancien.id, 5000, levelFromXp);
    assert.equal(repo.rank(guildId, ancien.id), 1);

    // Départ réel (GUILD_MEMBER_REMOVE) : hors du classement, XP conservée.
    await h.memberLeave(ancien.id);
    assert.ok(repo.get(guildId, ancien.id).left_at > 0, 'départ non marqué');
    assert.equal(repo.get(guildId, ancien.id).xp, 5000);
    const board = await h.slash('classement', [], { as: 'member' });
    assert.doesNotMatch(h.replyText(board), new RegExp(ancien.id), 'membre parti encore classé');
    assert.match(h.message(board.original).embeds[0].footer.text, /2 membre\(s\) classé\(s\)/);
    const rank = await h.slash('rang', [opt('membre', 6, ancien.id)], { as: 'member' });
    assert.match(h.replyText(rank), /a quitté le serveur \(XP conservée\)/);

    // Retour : il retrouve sa place.
    await h.memberJoin(ancien);
    assert.equal(repo.get(guildId, ancien.id).left_at, null);
    assert.equal(repo.rank(guildId, ancien.id), 1);

    // Nouveau départ, puis purge depuis /niveaux (vue « Gérer l'XP »).
    await h.memberLeave(ancien.id);
    const dash = await h.slash('niveaux');
    const xp = await h.click(h.message(dash.original), 'cmd:niveaux:nav', { values: ['xp'] });
    assert.match(embedText(updated(h, xp)), /Membres partis\n1/);
    const refused = await h.click(updated(h, xp), 'cmd:niveaux:purgeleft', { as: 'member' });
    assert.ok(h.isError(refused), 'purge ouverte sans « Gérer le serveur »');
    const open = await h.click(updated(h, xp), 'cmd:niveaux:purgeleft');
    assert.equal(open.modals.length, 1);
    const tooRecent = await h.submitModal(open, { days: '30' });
    assert.match(embedText(updated(h, tooRecent)), /Aucun membre parti depuis plus de \*\*30\*\* jour/);
    const open2 = await h.click(updated(h, tooRecent), 'cmd:niveaux:go:xp');
    const modal = await h.click(updated(h, open2), 'cmd:niveaux:purgeleft');
    const confirm = await h.submitModal(modal, { days: '0' });
    assert.match(embedText(updated(h, confirm)), /\*\*1\*\* membre\(s\) parti\(s\)/);
    const noPerm = await h.click(updated(h, confirm), 'cmd:niveaux:purge:0', { as: 'member' });
    assert.ok(h.isError(noPerm));
    assert.ok(repo.get(guildId, ancien.id), 'purgé sans permission');
    const done = await h.click(updated(h, confirm), 'cmd:niveaux:purge:0');
    assert.match(embedText(updated(h, done)), /XP de \*\*1\*\* membre\(s\) parti\(s\) supprimée/);
    assert.equal(repo.get(guildId, ancien.id), null);
    assert.ok(repo.get(guildId, IDS.users.target), 'membre présent intact');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('AntiRaid : expulsions massives (via le bot et à la main) → alerte et sanction ; réglage du tableau de bord', async () => {
  const h = await setup();
  try {
    h.configure({ moderation: { confirmDangerous: false }, antiraid: { joinThreshold: 50, minAccountAgeDays: 0 } });
    // Tableau de bord : seuil réglé dans la vue « destruction ».
    const denied = await h.slash('antiraid', [], { as: 'mod' });
    assert.ok(h.isError(denied), '/antiraid ouvert sans Administrateur');
    const dash = await h.slash('antiraid');
    const view = await h.click(h.message(dash.original), 'cmd:antiraid:nav', { values: ['destructive'] });
    assert.match(embedText(updated(h, view)), /Expulsions\nDésactivé/);
    const form = await h.click(updated(h, view), 'cmd:antiraid:set:destructive');
    assert.ok(form.modals[0].components.some((r) => r.components?.[0]?.custom_id === 'kickThreshold'), 'champ « Expulsions » absent du formulaire');
    const saved = await h.submitModal(form, { channelDeleteThreshold: '3', roleDeleteThreshold: '3', banThreshold: '5', kickThreshold: '2', destructiveWindowSeconds: '30' });
    assert.match(embedText(updated(h, saved)), /Expulsions\n\*\*2\*\*/);
    assert.equal(h.client.services.config.get(h.guild.id).antiraid.kickThreshold, 2);

    // Un arrivant récent expulsé n'est pas compté.
    const raider = h.addUser('Raider', { ageDays: 300 });
    await h.memberJoin(raider);
    await h.slash('kick', [opt('membre', 6, raider.id)], { as: 'mod' });
    assert.ok(!h.fake.members.has(raider.id));
    let mark = h.fake.messageLog.length;
    await h.slash('kick', [opt('membre', 6, IDS.users.target)], { as: 'mod' });
    assert.equal(botMessages(h, mark, (m) => /Activité destructrice/.test(embedText(m))).length, 0, 'alerte dès le premier kick d\'un membre ancien');
    // Deuxième membre ancien expulsé par le même modérateur : seuil atteint.
    await h.slash('kick', [opt('membre', 6, IDS.users.member)], { as: 'mod' });
    const alerts = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && /Activité destructrice/.test(embedText(m)));
    assert.equal(alerts.length, 1, 'expulsions massives non détectées');
    assert.match(embedText(alerts[0]), /Expulsions ×\*\*2\*\*/);
    assert.ok(!h.fake.members.get(IDS.users.mod).roles.includes(IDS.roles.mod), 'auteur non sanctionné (rôles)');

    // Expulsions manuelles lues dans le journal d'audit (MemberKick, action 20).
    mark = h.fake.messageLog.length;
    for (const target of [nextId(), nextId()]) {
      await h.auditEntry({ action_type: 20, target_id: target, user_id: IDS.users.admin, reason: 'à la main' });
    }
    const manual = botMessages(h, mark, (m) => m.channel_id === IDS.channels.logs && /Activité destructrice/.test(embedText(m)));
    assert.equal(manual.length, 1, 'expulsions manuelles non détectées');
    assert.match(embedText(manual[0]), new RegExp(IDS.users.admin));
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('/backup restore : rôles recréés replacés dans l\'ordre, permissions des salons existants sur option', async () => {
  const h = await setup();
  try {
    const { id } = h.client.services.backup.create(h.guild, h.client.users.cache.get(IDS.users.admin), 'Avant');
    // Rôle supprimé et permissions d'un salon existant modifiées après la sauvegarde.
    await h.guild.roles.delete(IDS.roles.gamer);
    await h.guild.channels.cache.get(IDS.channels.general).permissionOverwrites.create(IDS.roles.notif, { ViewChannel: false });
    await h.settle();

    const denied = await h.slash('backup', sub('info', [opt('id', 3, id)]), { as: 'mod' });
    assert.ok(h.isError(denied));
    const info = await h.slash('backup', sub('info', [opt('id', 3, id)]));
    const card = h.message(info.original);
    assert.ok(h.findComponent(card, `cmd:backup:restore:${id}:perms`), 'bouton « Restaurer + permissions » absent');
    const noPerm = await h.click(card, `cmd:backup:restore:${id}:perms`, { as: 'mod' });
    assert.ok(h.isError(noPerm));

    // Restauration simple (sans les permissions) : annulée puis confirmée.
    const cancelled = await h.slash('backup', sub('restore', [opt('id', 3, id)]));
    await h.confirm(cancelled, { cancel: true });
    assert.ok(![...h.fake.roles.values()].some((r) => r.name === 'Joueur'), 'restauration malgré l\'annulation');

    const positionsBefore = h.fake.calls.filter((c) => c.method === 'PATCH' && /\/guilds\/\d+\/roles$/.test(c.route)).length;
    const click = await h.click(card, `cmd:backup:restore:${id}:perms`);
    assert.match(h.replyText(click), /avec les permissions des salons existants/);
    const go = await h.confirm(click);
    assert.ok(go, 'confirmation introuvable');
    await h.settle();
    const roleCalls = h.fake.calls.filter((c) => c.method === 'PATCH' && /\/guilds\/\d+\/roles$/.test(c.route)).length - positionsBefore;
    assert.equal(roleCalls, 1, 'un seul appel de repositionnement');
    const roles = [...h.fake.roles.values()];
    const pos = (name) => roles.find((r) => r.name === name)?.position;
    assert.ok(pos('Joueur'), 'rôle non recréé');
    assert.ok(pos('Notifications') < pos('Joueur') && pos('Joueur') < pos('Muet'), `ordre non rétabli (${pos('Notifications')} < ${pos('Joueur')} < ${pos('Muet')})`);
    assert.ok(pos('Inspecteur Gadget') > pos('Admin'), 'un rôle passé au-dessus du bot');
    const general = h.fake.channels.get(IDS.channels.general);
    assert.ok(!general.permission_overwrites.some((o) => o.id === IDS.roles.notif), 'permissions du salon existant non rétablies');
    const result = h.replyText(click);
    assert.match(result, /Restauration terminée/);
    const followUp = h.messagesOf(click).map(embedText).join('\n');
    assert.match(followUp, /Rôles replacés/);
    assert.match(followUp, /Permissions rétablies/);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('vérification : question anti-robot en toutes lettres, réponse en lettres acceptée', async () => {
  const h = await setup();
  try {
    h.configure({ antiraid: { enabled: false }, welcome: { verification: { enabled: true, roleId: IDS.roles.notif, channelId: IDS.channels.rules, captcha: true } } });
    const denied = await h.slash('bienvenue', [], { as: 'member' });
    assert.ok(h.isError(denied), '/bienvenue ouvert sans permission');
    const dash = await h.slash('bienvenue');
    const nav = await h.click(h.message(dash.original), 'cmd:bienvenue:nav', { values: ['verify'] });
    await h.click(updated(h, nav), 'cmd:bienvenue:publish');
    const panel = botMessages(h, 0, hasButton('cmd:bienvenue:verify'))[0];
    const newcomer = h.addUser('Humain', { ageDays: 500 });
    await h.memberJoin(newcomer);

    const first = await h.click(panel, 'cmd:bienvenue:verify', { as: newcomer.id });
    const label = first.modals[0].components[0].components[0].label;
    assert.doesNotMatch(label, /\d/, `réponse lisible dans le libellé : ${label}`);
    assert.ok(label.length <= 45);
    const wrong = await h.submitModal(first, { answer: '999' }, { as: newcomer.id });
    assert.ok(h.isError(wrong));

    const second = await h.click(panel, 'cmd:bienvenue:verify', { as: newcomer.id });
    const { answer } = h.client.services.welcome.challenges.get(`${h.guild.id}:${newcomer.id}`);
    assert.ok(!JSON.stringify(second.modals[0]).includes(`"${answer}"`), 'réponse dans le formulaire');
    await h.submitModal(second, { answer: numberToFrench(Number(answer)).toUpperCase() }, { as: newcomer.id });
    assert.ok(h.fake.members.get(newcomer.id).roles.includes(IDS.roles.notif), 'réponse en lettres refusée');
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

/**
 * Écourte le délai de fermeture des tickets SANS simuler un arrêt du bot (flush() archive
 * alors sans télécharger les pièces jointes), puis attend la fin des fermetures.
 */
async function skipCloseDelay(h) {
  const jobs = [...h.client.services.tickets.closeJobs.values()];
  for (const job of jobs) job.skip?.();
  await Promise.allSettled(jobs.map((j) => j.done));
}

/** Pièce jointe brute (format API) d'un message utilisateur. */
const rawAttachment = (channelId, filename, size) => ({ id: nextId(), filename, size, url: `https://cdn.discordapp.com/attachments/${channelId}/${nextId()}/${filename}`, proxy_url: `https://media.discordapp.net/attachments/${channelId}/1/${filename}`, content_type: 'image/png' });

/** Faux téléchargement : corps de la taille annoncée par le nom (« 404 » : introuvable). */
function stubFetch(h, downloads) {
  const fetchImpl = async (url) => {
    downloads.push(url);
    if (url.includes('perdu')) return { ok: false, status: 404 };
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(2048) };
  };
  h.client.services.tickets.fetch = fetchImpl;
  h.client.services.modmail.fetch = fetchImpl;
}

test('transcripts : pièces jointes archivées sur option (tickets et ModMail), échecs listés', async () => {
  const h = await setup();
  try {
    const downloads = [];
    stubFetch(h, downloads);
    // Option réglée depuis /tickets (bouton on/off), refusée sans permission.
    const dash = await h.slash('tickets');
    const refused = await h.click(h.message(dash.original), 'cmd:tickets:attachments:on', { as: 'member' });
    assert.ok(h.isError(refused));
    const on = await h.click(h.message(dash.original), 'cmd:tickets:attachments:on');
    assert.equal(h.client.services.config.get(h.guild.id).tickets.archiveAttachments, true);
    assert.ok(h.findComponent(updated(h, on), 'cmd:tickets:attachments:off'), 'bouton non basculé');

    // Ticket avec pièces jointes : une petite, une trop lourde, une introuvable.
    const channel = await h.client.services.tickets.create(h.guild, h.client.users.cache.get(IDS.users.member));
    await h.settle();
    await h.userMessage({
      as: 'member',
      channel: channel.id,
      content: 'Voici la capture',
      extra: { attachments: [rawAttachment(channel.id, 'capture.png', 2048), rawAttachment(channel.id, 'video.mp4', 9 * 1024 * 1024), rawAttachment(channel.id, 'perdu.png', 10)] },
    });
    const mark = h.fake.calls.length;
    await h.slash('ticket', sub('close'), { as: 'member', channel: channel.id });
    await skipCloseDelay(h); // délai de fermeture (5 s) écourté, sans arrêt du bot
    await h.settle();
    const archive = h.fake.calls.slice(mark).find((c) => c.route === `/channels/${IDS.channels.logs}/messages` && c.files.length);
    assert.ok(archive, 'archive non publiée');
    assert.match(archive.files[0].name, /^ticket-\d+\.txt$/);
    assert.deepEqual(archive.files.slice(1).map((f) => f.name), ['01-capture.png']);
    assert.equal(archive.files[1].size, 2048, 'fichier re-téléversé');
    assert.ok(archive.files.length <= 10);
    assert.ok(!downloads.some((u) => u.includes('video.mp4')), 'fichier de plus de 8 Mo téléchargé');
    const text = JSON.stringify(archive.body.embeds);
    assert.match(text, /video\.mp4.*plus de 8 Mo/);
    assert.match(text, /perdu\.png.*HTTP 404/);

    // ModMail : liens de pièces jointes des MP relayés, archivés à la fermeture.
    downloads.length = 0;
    await h.userMessage({ as: 'target', channel: 'dm', content: 'Ma preuve', extra: { attachments: [rawAttachment(h.dmChannel('target').id, 'preuve.png', 2048)] } });
    const mm = [...h.fake.channels.values()].find((c) => c.name?.startsWith('modmail-'));
    assert.ok(mm, 'conversation ModMail non ouverte');
    const mark2 = h.fake.calls.length;
    await h.slash('modmail', sub('close'), { as: 'mod', channel: mm.id });
    await h.settle();
    const mmArchive = h.fake.calls.slice(mark2).find((c) => c.route === `/channels/${IDS.channels.logs}/messages` && c.files.length);
    assert.ok(mmArchive, 'archive ModMail non publiée');
    assert.ok(mmArchive.files.some((f) => f.name === '01-preuve.png'), 'pièce jointe ModMail non archivée');

    // Option désactivée : comportement historique (fichier .txt seul, aucun téléchargement).
    const dash2 = await h.slash('tickets');
    await h.click(h.message(dash2.original), 'cmd:tickets:attachments:off');
    downloads.length = 0;
    const channel2 = await h.client.services.tickets.create(h.guild, h.client.users.cache.get(IDS.users.target));
    await h.settle();
    await h.userMessage({ as: 'target', channel: channel2.id, content: 'fichier', extra: { attachments: [rawAttachment(channel2.id, 'capture.png', 2048)] } });
    const mark3 = h.fake.calls.length;
    await h.slash('ticket', sub('close'), { as: 'target', channel: channel2.id });
    await skipCloseDelay(h);
    await h.settle();
    const plain = h.fake.calls.slice(mark3).find((c) => c.route === `/channels/${IDS.channels.logs}/messages` && c.files.length);
    assert.equal(plain.files.length, 1);
    assert.equal(downloads.length, 0);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});
