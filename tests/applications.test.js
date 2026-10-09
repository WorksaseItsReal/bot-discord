'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, ChannelType, Collection } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { migrations } = require('../src/database/schema');
const { ApplicationRepository, MAX_FORMS } = require('../src/database/repositories/ApplicationRepository');
const { GuildConfigRepository } = require('../src/database/repositories/GuildConfigRepository');
const { ConfigService } = require('../src/services/ConfigService');
const A = require('../src/services/ApplicationService');
const { EVENT_CATEGORY } = require('../src/utils/logCatalog');
const { CATEGORIES } = require('../src/utils/categories');
const candidatures = require('../src/commands/configuration/candidatures');
const candidature = require('../src/commands/utility/candidature');

const { ApplicationService } = A;
const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

const GUILD = '100000000000000001';
const OWNER = '200000000000000001';
const ADMIN = '200000000000000002';
const MEMBER = '200000000000000003';
const BOT = '999999999999999999';
const REVIEW = '400000000000000001';
const PANEL = '400000000000000002';
const R_LOW = '300000000000000001';
const R_MOD = '300000000000000002';
const R_HIGH = '300000000000000003';
const R_MANAGED = '300000000000000004';
const R_PING = '300000000000000005';

// ---------------------------------------------------------------- briques pures

test('migration 23 : tables des candidatures, garde unique « en attente », colonnes ajoutées', () => {
  const m = migrations.find((x) => x.id === 23);
  assert.ok(m && /CREATE TABLE IF NOT EXISTS application_forms/.test(m.up) && /CREATE TABLE IF NOT EXISTS applications/.test(m.up));
  const { db } = memoryDb();
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['guild_id', 'name', 'questions', 'role_ids', 'review_channel_id', 'ping_role_id', 'open', 'cooldown_ms', 'panel_channel_id', 'panel_message_id']) assert.ok(cols('application_forms').includes(c), c);
  for (const c of ['form_id', 'user_id', 'answers', 'status', 'reviewer_id', 'reason', 'note', 'card_message_id', 'interview_channel_id', 'decided_at']) assert.ok(cols('applications').includes(c), c);
  assert.ok(cols('tickets').includes('claimed_at'));
  assert.ok(cols('ticket_ratings').includes('rating'));
  for (const c of ['min_level', 'min_invites', 'min_days']) assert.ok(cols('giveaways').includes(c), c);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'uq_applications_pending'").get());
});

test('parseQuestions / questionsToText : une par ligne, « + » = réponse longue, 45 caractères et 5 questions max', () => {
  const qs = A.parseQuestions('  Quel âge avez-vous ?  \n\n+ Pourquoi vous ?\n+Votre expérience ?');
  assert.deepEqual(qs, [{ label: 'Quel âge avez-vous ?', long: false }, { label: 'Pourquoi vous ?', long: true }, { label: 'Votre expérience ?', long: true }]);
  assert.deepEqual(A.parseQuestions(A.questionsToText(qs)), qs, 'aller-retour');
  assert.throws(() => A.parseQuestions(''), /au moins une question/);
  assert.throws(() => A.parseQuestions('+'), /au moins une question/);
  assert.throws(() => A.parseQuestions('x'.repeat(46)), /45 caractères/);
  assert.doesNotThrow(() => A.parseQuestions(`+ ${'x'.repeat(45)}`), 'le « + » ne compte pas');
  assert.throws(() => A.parseQuestions('a\nb\nc\nd\ne\nf'), /5 questions/);
  assert.throws(() => A.parseQuestions('Âge ?\nâge ?'), /en double/);
});

test('parseCooldown / cooldownToInput / formatCooldown', () => {
  assert.equal(A.parseCooldown(''), 0);
  assert.equal(A.parseCooldown('0'), 0);
  assert.equal(A.parseCooldown('aucun'), 0);
  assert.equal(A.parseCooldown('7d'), 7 * 86_400_000);
  assert.equal(A.parseCooldown('12h'), 12 * 3_600_000);
  for (const bad of ['abc', '-1', '2y', '400d']) assert.throws(() => A.parseCooldown(bad), /Délai invalide/, bad);
  for (const ms of [0, 3_600_000, 7 * 86_400_000, 86_400_000 + 12 * 3_600_000]) assert.equal(A.parseCooldown(A.cooldownToInput(ms)), ms);
  assert.equal(A.formatCooldown(0), 'Aucun');
});

test('parseName / parseDescription : bornes et caractères de contrôle', () => {
  assert.equal(A.parseName('  Recrutement   staff '), 'Recrutement staff');
  assert.throws(() => A.parseName(''), /obligatoire/);
  assert.throws(() => A.parseName('x'.repeat(46)), /45/);
  assert.equal(A.parseDescription(''), null);
  assert.equal(A.parseDescription('Ligne 1\nLigne 2\u0007'), 'Ligne 1\nLigne 2');
  assert.throws(() => A.parseDescription('x'.repeat(1001)), /1000/);
});

/** Rôle factice : position et permissions. */
const role = (id, position, perms = [], extra = {}) => ({ id, name: `rôle-${id.slice(-1)}`, position, managed: false, permissions: new PermissionsBitField(perms), ...extra });

function fakeGuild({ send, dmFails = false, memberLeft = false } = {}) {
  const roles = new Collection([
    [GUILD, role(GUILD, 0)],
    [R_LOW, role(R_LOW, 2)],
    [R_PING, role(R_PING, 3)],
    [R_MOD, role(R_MOD, 4, [PermissionFlagsBits.KickMembers])],
    [R_HIGH, role(R_HIGH, 9)],
    [R_MANAGED, role(R_MANAGED, 1, [], { managed: true })],
  ]);
  const sent = [];
  const edits = [];
  let seq = 900000000000000000n;
  const review = {
    id: REVIEW,
    type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    send: send ?? (async (payload) => {
      const msg = { id: String(seq++), channelId: REVIEW, payload };
      sent.push(msg);
      return msg;
    }),
    messages: { edit: async (id, payload) => edits.push({ id, payload }) },
  };
  const dms = [];
  const roleCalls = [];
  const memberUser = { id: MEMBER, username: 'membre', send: async (p) => (dmFails ? Promise.reject(Object.assign(new Error('Cannot send'), { code: 50007 })) : dms.push(p)) };
  const member = {
    id: MEMBER,
    user: memberUser,
    roles: {
      add: async (id) => {
        if (id === R_HIGH) throw new Error('Missing Permissions');
        roleCalls.push(id);
      },
      remove: async () => {},
    },
  };
  const guild = {
    id: GUILD,
    name: 'Gadget',
    ownerId: OWNER,
    roles: { cache: roles },
    channels: { cache: new Collection([[REVIEW, review], [PANEL, { id: PANEL, type: ChannelType.GuildText }]]) },
    members: {
      me: { id: BOT, roles: { highest: { position: 8 } } },
      cache: new Collection(memberLeft ? [] : [[MEMBER, member]]),
      fetch: async (id) => (memberLeft || id !== MEMBER ? Promise.reject(new Error('Unknown Member')) : member),
    },
  };
  return { guild, review, sent, edits, dms, roleCalls, memberUser };
}

test('roleProblem / canReview : rôles attribuables automatiquement, hiérarchie bot ET relecteur', () => {
  const { guild } = fakeGuild();
  const actor = { id: ADMIN, roles: { highest: { position: 5 } } };
  const get = (id) => guild.roles.cache.get(id);
  assert.equal(A.roleProblem(guild, get(R_LOW), actor), null);
  assert.match(A.roleProblem(guild, get(GUILD), actor), /everyone/);
  assert.match(A.roleProblem(guild, get(R_MANAGED), actor), /intégration/);
  assert.match(A.roleProblem(guild, get(R_MOD), actor), /modération/);
  assert.match(A.roleProblem(guild, get(R_HIGH), actor), /mon rôle/);
  assert.match(A.roleProblem(guild, role('300000000000000099', 6), actor), /votre rôle/);
  assert.equal(A.roleProblem(guild, role('300000000000000099', 6), { id: OWNER, roles: { highest: { position: 0 } } }), null, 'propriétaire exempté');
  assert.match(A.roleProblem(guild, undefined, actor), /n'existe plus/);
  assert.ok(A.canReview(new PermissionsBitField([PermissionFlagsBits.ManageRoles])));
  assert.ok(A.canReview(new PermissionsBitField([PermissionFlagsBits.ManageGuild])));
  assert.ok(!A.canReview(new PermissionsBitField([PermissionFlagsBits.KickMembers])));
  assert.ok(!A.canReview(null));
});

// ---------------------------------------------------------------- dépôt

test('ApplicationRepository : 5 formulaires max, une candidature en attente, décision et retrait atomiques', () => {
  const { db } = memoryDb();
  const repo = new ApplicationRepository(db);
  const ids = [];
  for (let i = 0; i < MAX_FORMS; i += 1) ids.push(repo.createForm({ guildId: GUILD, name: `F${i}`, questions: [{ label: 'Q ?', long: false }] }));
  assert.equal(repo.createForm({ guildId: GUILD, name: 'F6', questions: [] }), null, '6e formulaire refusé');
  assert.ok(repo.createForm({ guildId: '100000000000000002', name: 'Autre serveur', questions: [] }), 'limite par serveur');
  const f = repo.updateForm(GUILD, ids[0], { open: true, roleIds: [R_LOW], cooldownMs: 1000, reviewChannelId: REVIEW });
  assert.equal(f.open, true);
  assert.deepEqual(f.role_ids, [R_LOW]);
  assert.equal(f.cooldown_ms, 1000);
  assert.equal(f.name, 'F0', 'champs non fournis conservés');
  assert.equal(repo.updateForm('100000000000000002', ids[0], { open: false }), null, 'formulaire d\'un autre serveur');

  const a1 = repo.createApplication({ guildId: GUILD, formId: ids[0], formName: 'F0', userId: MEMBER, answers: [{ q: 'Q ?', a: 'R' }] });
  assert.ok(a1);
  assert.equal(repo.createApplication({ guildId: GUILD, formId: ids[0], formName: 'F0', userId: MEMBER, answers: [] }), null, 'deuxième en attente refusée');
  const other = repo.createApplication({ guildId: GUILD, formId: ids[1], formName: 'F1', userId: MEMBER, answers: [] });
  assert.ok(other, 'autre formulaire autorisé');
  assert.deepEqual(repo.getApplication(GUILD, a1).answers, [{ q: 'Q ?', a: 'R' }]);
  assert.equal(repo.pendingPerForm(GUILD).get(ids[0]), 1);

  assert.equal(repo.decide(GUILD, a1, { status: 'accepted', reviewerId: ADMIN }), true);
  assert.equal(repo.decide(GUILD, a1, { status: 'rejected', reviewerId: OWNER }), false, 'une seule décision');
  assert.equal(repo.getApplication(GUILD, a1).reviewer_id, ADMIN);
  const a2 = repo.createApplication({ guildId: GUILD, formId: ids[0], formName: 'F0', userId: MEMBER, answers: [] });
  assert.ok(a2, 'nouvelle candidature possible après décision');
  assert.equal(repo.lastByMember(ids[0], MEMBER).id, a2);
  assert.equal(repo.withdraw(GUILD, a2, ADMIN), false, 'retrait par un autre membre');
  assert.equal(repo.withdraw(GUILD, a2, MEMBER), true);
  assert.equal(repo.withdraw(GUILD, a2, MEMBER), false);
  assert.deepEqual(repo.counts(GUILD), { pending: 1, accepted: 1, rejected: 0, withdrawn: 1 });
  assert.deepEqual(repo.listByMember(GUILD, MEMBER).map((a) => a.id), [a2, other, a1], 'plus récentes d\'abord');
  assert.deepEqual(repo.listPendingOfMember(GUILD, MEMBER).map((a) => a.id), [other]);
  assert.equal(repo.getApplication('100000000000000002', a1), null, 'cloisonnement par serveur');
  assert.equal(repo.deleteForm(GUILD, ids[4]), true);
  assert.equal(repo.countForms(GUILD), 4);
});

// ---------------------------------------------------------------- service

function world(opts = {}) {
  const { db } = memoryDb();
  const config = new ConfigService(new GuildConfigRepository(db));
  const repo = new ApplicationRepository(db);
  const logs = [];
  const logging = { send: async (...args) => logs.push(args) };
  const fake = fakeGuild(opts);
  const client = { users: { fetch: async (id) => (id === MEMBER ? fake.memberUser : Promise.reject(new Error('Unknown User'))) } };
  const service = new ApplicationService({ client, applications: repo, config, logging });
  const form = service.createForm(GUILD, { name: 'Recrutement', description: null, questions: [{ label: 'Âge ?', long: false }, { label: 'Pourquoi ?', long: true }] });
  service.updateForm(GUILD, form.id, { reviewChannelId: REVIEW, pingRoleId: R_PING, roleIds: [R_LOW], open: true, panelChannelId: PANEL });
  return { ...fake, db, repo, service, logs, form: repo.getForm(GUILD, form.id) };
}

test('assertCanApply : fermé, salon de réception absent, déjà en attente, délai entre deux candidatures', () => {
  const { service, guild, repo, form } = world();
  assert.doesNotThrow(() => service.assertCanApply(guild, MEMBER, form));
  assert.throws(() => service.assertCanApply(guild, MEMBER, { ...form, open: false }), /fermées/);
  assert.throws(() => service.assertCanApply(guild, MEMBER, { ...form, review_channel_id: null }), /pas prêt/);
  assert.throws(() => service.assertCanApply(guild, MEMBER, { ...form, review_channel_id: '400000000000000099' }), /pas prêt/);
  const id = repo.createApplication({ guildId: GUILD, formId: form.id, formName: form.name, userId: MEMBER, answers: [] });
  assert.throws(() => service.assertCanApply(guild, MEMBER, form), /déjà une candidature/);
  repo.decide(GUILD, id, { status: 'rejected', reviewerId: ADMIN });
  const withCooldown = { ...form, cooldown_ms: 3_600_000 };
  assert.throws(() => service.assertCanApply(guild, MEMBER, withCooldown), /postulé récemment.*<t:\d+:R>/);
  assert.doesNotThrow(() => service.assertCanApply(guild, MEMBER, withCooldown, Date.now() + 3_600_001));
});

test('answers et applyModal : réponses obligatoires et bornées ; libellés ≤ 45, ≤ 5 rangées', () => {
  const { service, form } = world();
  assert.deepEqual(ApplicationService.answers(form, [' 25 ', 'Ligne 1\nLigne 2']), [{ q: 'Âge ?', a: '25' }, { q: 'Pourquoi ?', a: 'Ligne 1\nLigne 2' }]);
  assert.throws(() => ApplicationService.answers(form, ['', 'x']), /Répondez/);
  assert.throws(() => ApplicationService.answers(form, ['x'.repeat(301), 'x']), /trop longue/);
  assert.equal(ApplicationService.answers(form, ['a b', 'x'])[0].a, 'a b');
  const big = { ...form, name: 'N'.repeat(45), questions: Array.from({ length: 5 }, (_, i) => ({ label: `${'Q'.repeat(44)}${i}`, long: i % 2 === 0 })) };
  const modal = json(service.applyModal(big));
  assert.equal(modal.custom_id, `cmd:candidature:submit:${form.id}`);
  assert.ok(modal.title.length <= 45);
  assert.equal(modal.components.length, 5);
  for (const [i, row] of modal.components.entries()) {
    const input = row.components[0];
    assert.equal(input.custom_id, `q${i}`);
    assert.ok(input.label.length <= 45);
    assert.equal(input.style, i % 2 === 0 ? 2 : 1);
    assert.equal(input.max_length, i % 2 === 0 ? A.LONG_ANSWER_MAX : A.SHORT_ANSWER_MAX);
  }
});

test('submit : carte dans le salon de réception, rôle pingué explicitement, réponses en embed ; échec → candidature supprimée', async () => {
  const w = world();
  const app = await w.service.submit(w.guild, { id: MEMBER }, w.form, ['25', 'Motivé @everyone']);
  assert.equal(w.sent.length, 1);
  const payload = w.sent[0].payload;
  assert.equal(payload.content, `<@&${R_PING}>`);
  assert.deepEqual(payload.allowedMentions, { parse: [], roles: [R_PING] });
  const embed = payload.embeds[0];
  assert.ok(embed.fields.some((f) => f.value.includes('Motivé @everyone')), 'réponses absentes de l\'embed');
  assert.ok(!payload.content.includes('Motivé'));
  assert.equal(app.card_message_id, w.sent[0].id);
  assert.equal(app.card_channel_id, REVIEW);
  const ids = payload.components.flatMap((r) => json(r).components.map((c) => c.custom_id));
  assert.deepEqual(ids.slice(0, 3), [`cmd:candidatures:accept:${app.id}`, `cmd:candidatures:reject:${app.id}`, `cmd:candidatures:interview:${app.id}`]);
  await assert.rejects(w.service.submit(w.guild, { id: MEMBER }, w.form, ['25', 'x']), /déjà une candidature/);

  // Salon inaccessible : la candidature n'est pas conservée.
  const failing = world({ send: async () => { throw new Error('Missing Access'); } });
  await assert.rejects(failing.service.submit(failing.guild, { id: MEMBER }, failing.form, ['25', 'x']), /pas pu transmettre/);
  assert.equal(failing.repo.counts(GUILD).pending, 0);
  // Pas de rôle de ping : aucune mention autorisée.
  const quiet = world();
  quiet.service.updateForm(GUILD, quiet.form.id, { pingRoleId: null });
  await quiet.service.submit(quiet.guild, { id: MEMBER }, quiet.repo.getForm(GUILD, quiet.form.id), ['25', 'x']);
  assert.deepEqual(quiet.sent[0].payload.allowedMentions, { parse: [] });
  assert.equal(quiet.sent[0].payload.content, undefined);
});

test('cardPayload : limites Discord avec 5 réponses longues ; actions retirées après décision', () => {
  const { service, guild } = world();
  const app = {
    id: 12, guild_id: GUILD, form_id: 1, form_name: 'F'.repeat(45), user_id: MEMBER, status: 'pending', created_at: Date.now(),
    answers: Array.from({ length: 5 }, (_, i) => ({ q: `${'Q'.repeat(44)}${i}`, a: 'x'.repeat(1000) })), reason: null, note: 'Remarque', interview_channel_id: null,
  };
  const { embeds, components } = service.cardPayload(guild, app, { fit: true });
  const e = embeds[0];
  const total = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0) + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `embed de ${total} caractères`);
  for (const r of components) for (const c of json(r).components) assert.ok(!c.custom_id || c.custom_id.length <= 100);
  const decided = service.cardPayload(guild, { ...app, status: 'rejected', reviewer_id: ADMIN, decided_at: Date.now(), reason: 'Non', interview_channel_id: '400000000000000003' });
  const ids = decided.components.flatMap((r) => json(r).components.map((c) => c.custom_id ?? c.url));
  assert.ok(!ids.some((x) => /accept|reject|interview:/.test(x ?? '')), 'actions encore proposées');
  assert.ok(ids.some((x) => /400000000000000003/.test(x ?? '')), 'lien vers l\'entretien absent');
  const text = JSON.stringify(json(decided.embeds[0]));
  assert.match(text, /Refusée/);
  assert.match(text, /Motif du refus/);
  assert.ok(!json(decided.embeds[0]).description.startsWith('❌'), 'une carte refusée ne doit pas ressembler à une erreur');
});

test('decide + complete : une seule décision, rôles donnés un par un, MP, remarques (MP fermés, membre parti)', async () => {
  const w = world();
  const app = await w.service.submit(w.guild, { id: MEMBER }, w.form, ['25', 'x']);
  const admin = { id: ADMIN, user: { tag: 'admin' }, roles: { highest: { position: 5 } } };
  const roles = w.service.rolesToGrant(w.guild, app, admin);
  assert.deepEqual(roles, [R_LOW]);
  const decided = w.service.decide(w.guild, app, { status: 'accepted', reviewer: admin });
  assert.throws(() => w.service.decide(w.guild, app, { status: 'rejected', reviewer: admin }), /déjà été traitée/);
  const result = await w.service.complete(w.guild, decided, admin, roles);
  assert.deepEqual(w.roleCalls, [R_LOW]);
  assert.equal(result.dm, true);
  assert.equal(w.dms.length, 1);
  const dm = json(w.dms[0].embeds[0]);
  assert.match(dm.title, /acceptée/);
  assert.match(dm.description, /\*\*rôle-1\*\*/, 'nom du rôle (pas une mention) dans le MP');
  assert.equal(result.app.note, null);

  // Rôle refusé par Discord + MP fermés : remarques sur la carte.
  const w2 = world({ dmFails: true });
  const app2 = await w2.service.submit(w2.guild, { id: MEMBER }, w2.form, ['25', 'x']);
  const d2 = w2.service.decide(w2.guild, app2, { status: 'accepted', reviewer: { id: OWNER } });
  const r2 = await w2.service.complete(w2.guild, d2, { id: OWNER, user: { tag: 'owner' } }, [R_LOW, R_HIGH]);
  assert.deepEqual(r2.failed, [R_HIGH]);
  assert.match(r2.app.note, /Rôle\(s\) non donné\(s\)/);
  assert.match(r2.app.note, /MP impossible/);

  // Membre parti : aucun rôle, remarque.
  const w3 = world({ memberLeft: true });
  const app3 = await w3.service.submit(w3.guild, { id: MEMBER }, w3.form, ['25', 'x']);
  const d3 = w3.service.decide(w3.guild, app3, { status: 'accepted', reviewer: admin });
  const r3 = await w3.service.complete(w3.guild, d3, admin, [R_LOW]);
  assert.equal(r3.left, true);
  assert.match(r3.app.note, /quitté le serveur/);

  // Refus : motif dans le MP.
  const w4 = world();
  const app4 = await w4.service.submit(w4.guild, { id: MEMBER }, w4.form, ['25', 'x']);
  const d4 = w4.service.decide(w4.guild, app4, { status: 'rejected', reviewer: admin, reason: 'Trop jeune' });
  await w4.service.complete(w4.guild, d4, admin);
  assert.equal(w4.roleCalls.length, 0);
  assert.match(JSON.stringify(json(w4.dms[0].embeds[0])), /Trop jeune/);
});

test('rôles à donner : interdits, au-dessus du bot ou du relecteur refusés avant toute décision', async () => {
  const w = world();
  const low = { id: ADMIN, roles: { highest: { position: 3 } } };
  assert.throws(() => w.service.assertGrantableRoles(w.guild, [R_MOD], low), /modération/);
  assert.throws(() => w.service.assertGrantableRoles(w.guild, [R_HIGH], { id: OWNER }), /mon rôle/);
  assert.throws(() => w.service.assertGrantableRoles(w.guild, [R_PING], low), /votre rôle/);
  assert.throws(() => w.service.assertGrantableRoles(w.guild, [R_LOW, R_PING, '1', '2', '3', '4'], low), /5 rôles/);
  const app = await w.service.submit(w.guild, { id: MEMBER }, w.form, ['25', 'x']);
  w.service.updateForm(GUILD, w.form.id, { roleIds: [R_PING] });
  assert.throws(() => w.service.rolesToGrant(w.guild, app, low), /votre rôle/);
  assert.equal(w.repo.getApplication(GUILD, app.id).status, 'pending', 'aucune décision réservée');
});

test('withdraw : auteur seulement, une fois ; suppression de formulaire refusée avec des candidatures en attente', async () => {
  const w = world();
  const app = await w.service.submit(w.guild, { id: MEMBER }, w.form, ['25', 'x']);
  assert.throws(() => w.service.withdraw(w.guild, ADMIN, app.id), /vos propres candidatures/);
  assert.throws(() => w.service.assertDeletable(GUILD, w.form.id), /en attente/);
  const done = w.service.withdraw(w.guild, MEMBER, app.id);
  assert.equal(done.status, 'withdrawn');
  assert.throws(() => w.service.withdraw(w.guild, MEMBER, app.id), /déjà été traitée/);
  assert.throws(() => w.service.withdraw(w.guild, MEMBER, 999), /introuvable/);
  await w.service.deleteForm(w.guild, w.form.id);
  assert.throws(() => w.service.form(GUILD, w.form.id), /n'existe plus/);
  assert.deepEqual(ApplicationService.memberLines([done]).length, 1);
});

test('panelPayload : bouton « Postuler » persistant, désactivé quand le formulaire est fermé', () => {
  const { service, guild, form } = world();
  const open = service.panelPayload(guild, form);
  const button = json(open.components[0]).components[0];
  assert.equal(button.custom_id, `cmd:candidature:apply:${form.id}`);
  assert.ok(!button.disabled);
  const closed = json(service.panelPayload(guild, { ...form, open: false }).components[0]).components[0];
  assert.equal(closed.disabled, true);
});

test('commandes : catégories valides, permissions, routes et journal', () => {
  assert.ok(CATEGORIES[candidatures.category] && CATEGORIES[candidature.category]);
  const dash = candidatures.data.toJSON();
  assert.equal(dash.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(candidature.data.toJSON().default_member_permissions ?? null, null, '/candidature ouverte aux membres');
  for (const action of ['nav', 'go', 'pick', 'create', 'edit', 'formsubmit', 'review', 'roles', 'ping', 'panelch', 'toggle', 'publish', 'delete', 'accept', 'reject', 'rejectsubmit', 'interview']) assert.equal(typeof candidatures.buttons[action], 'function', action);
  for (const action of ['apply', 'submit', 'withdraw']) assert.equal(typeof candidature.buttons[action], 'function', action);
  assert.equal(EVENT_CATEGORY.application, 'moderation');
  assert.equal(EVENT_CATEGORY.ticketRating, 'moderation');
});
