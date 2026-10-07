'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, MessageFlagsBitField } = require('discord.js');
const { memoryDb } = require('./db.helper');
const { SanctionRepository, sanctionState } = require('../src/database/repositories/SanctionRepository');
const { ModNoteRepository } = require('../src/database/repositories/ModNoteRepository');
const { ModerationService, historyButton } = require('../src/services/ModerationService');
const sanctions = require('../src/commands/moderation/sanctions');
const userinfo = require('../src/commands/information/userinfo');

const GID = '100000000000000001';
const UID = '200000000000000002';
const MOD = '300000000000000003';
const OTHER = '400000000000000004';
const BOT = '999999999999999999';
const HOUR = 3_600_000;

const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);

/** Monde de test : base en mémoire, ModerationService réel, faux serveur Discord. */
function world({ botPerms = PermissionsBitField.All } = {}) {
  const { db } = memoryDb();
  const repo = new SanctionRepository(db);
  const notes = new ModNoteRepository(db);
  const logs = [];
  const logChannel = { id: '500000000000000005', sent: [], messages: new Map() };
  logChannel.send = async (payload) => {
    const msg = {
      id: String(600000000000000000n + BigInt(logChannel.sent.length)),
      channelId: logChannel.id,
      author: { id: BOT },
      embeds: payload.embeds.map(json),
      edits: [],
      edit: async (p) => {
        msg.edits.push(p);
        msg.embeds = p.embeds;
      },
    };
    logChannel.sent.push(msg);
    logChannel.messages.set(msg.id, msg);
    return msg;
  };
  logChannel.messages.fetch = async (id) => {
    const m = logChannel.messages.get(id);
    if (!m) throw new Error('Unknown Message');
    return m;
  };
  // Journalisation : enregistre et « envoie » réellement (onSent compris).
  const logging = {
    send: async (guildId, category, embed, components, ctx = {}) => {
      logs.push({ category, ctx, embed: json(embed) });
      const m = await logChannel.send({ embeds: [embed] });
      ctx.onSent?.(m);
      return true;
    },
  };
  const config = { get: () => ({ moderation: { dmOnSanction: false, mutedRoleId: 'muted' } }) };
  const moderation = new ModerationService({ sanctions: repo, config, logging });
  const guild = { id: GID, ownerId: 'owner', channels: { cache: new Map([[logChannel.id, logChannel]]) }, roles: { cache: new Map([['muted', { id: 'muted' }]]) } };
  const me = { id: BOT, guild, permissions: new PermissionsBitField(botPerms), roles: { highest: { position: 100 } } };
  const members = new Map();
  const bans = new Map();
  guild.members = {
    me,
    cache: members,
    fetch: async (id) => {
      const m = members.get(id);
      if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      return m;
    },
  };
  guild.bans = {
    fetch: async (id) => bans.get(id) ?? null,
    remove: async (id) => bans.delete(id),
    create: async (id) => bans.set(id, { user: { id, toString: () => `<@${id}>` } }),
  };
  const client = {
    repositories: { sanctions: repo, modNotes: notes },
    services: { moderation, strikes: { getCount: () => 3, reset: () => {} } },
    users: { cache: new Map(), fetch: async () => null },
  };
  const moderator = { id: MOD, guild, roles: { highest: { position: 50 } } };
  return { db, repo, notes, logs, logChannel, moderation, guild, members, bans, client, moderator };
}

/** Membre ciblé (rôle inférieur), avec rôle muet / timeout optionnels. */
function addMember(w, id = UID, { muted = false, timedOut = false, position = 1 } = {}) {
  const roles = new Set(muted ? ['muted'] : []);
  const member = {
    id,
    guild: w.guild,
    user: { id, username: 'cible', toString: () => `<@${id}>` },
    roles: { highest: { position }, cache: { has: (r) => roles.has(r) }, remove: async (r) => roles.delete(r?.id ?? r), add: async (r) => roles.add(r?.id ?? r) },
    moderatable: true,
    isCommunicationDisabled: () => timedOut,
    timeout: async (ms) => {
      timedOut = Boolean(ms);
    },
  };
  w.members.set(id, member);
  return member;
}

/** Fausse interaction (bouton, menu, modal ou slash). */
function fake(w, { perms = ['ModerateMembers'], user = MOD, values, fields = {}, options = {} } = {}) {
  const calls = { update: [], reply: [], editReply: [], showModal: [], deferUpdate: 0, deferReply: 0 };
  return {
    calls,
    customId: 'cmd:sanctions:x',
    guildId: GID,
    guild: w.guild,
    user: { id: user, tag: 'modo', username: 'modo' },
    member: user === MOD ? w.moderator : { id: user, guild: w.guild, roles: { highest: { position: 60 } } },
    memberPermissions: new PermissionsBitField(perms),
    message: { components: [], flags: new MessageFlagsBitField(0) },
    values,
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    options: {
      getSubcommand: () => options.sub,
      getInteger: (n) => options[n] ?? null,
      getString: (n) => options[n] ?? null,
      getUser: (n) => options[n] ?? null,
    },
    async update(p) { calls.update.push(p); },
    async reply(p) { calls.reply.push(p); },
    async editReply(p) { calls.editReply.push(p); },
    async showModal(m) { calls.showModal.push(json(m)); },
    async deferUpdate() { calls.deferUpdate += 1; },
    async deferReply() { calls.deferReply += 1; },
  };
}

/** Vérifie les limites Discord et que chaque composant route vers un gestionnaire existant. */
function assertValid(payload, label) {
  const rows = payload.components.map(json);
  assert.ok(rows.length <= 5, `${label} : ${rows.length} rangées`);
  const ids = [];
  for (const r of rows) {
    assert.ok(r.components.length >= 1 && r.components.length <= 5, `${label} : rangée de ${r.components.length}`);
    for (const c of r.components) {
      if (!c.custom_id) continue;
      ids.push(c.custom_id);
      assert.ok(c.custom_id.length <= 100, `${label} : customId trop long`);
      const [prefix, cmd, action] = c.custom_id.split(':');
      assert.equal(prefix, 'cmd');
      if (cmd === '_') continue;
      assert.equal(cmd, 'sanctions', `${label} : ${c.custom_id}`);
      assert.equal(typeof sanctions.buttons[action], 'function', `${label} : action ${action} sans gestionnaire`);
      if (c.options) assert.ok(c.options.length >= 1 && c.options.length <= 25, `${label} : options du menu`);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label} : identifiants en double`);
  for (const e of payload.embeds.map(json)) {
    assert.ok((e.description?.length ?? 0) <= 4096, `${label} : description`);
    assert.ok((e.fields ?? []).length <= 25);
    assert.ok((e.fields ?? []).every((f) => f.value.length <= 1024 && f.name.length <= 256), `${label} : champ trop long`);
  }
}

const customIds = (payload) => payload.components.map(json).flatMap((r) => r.components.map((c) => c.custom_id).filter(Boolean));

// ---------------------------------------------------------------- migration 7

test('migration 7 : colonnes, tables, index et suppressions en cascade', () => {
  const { db, repo, notes } = world();
  const cols = db.prepare('PRAGMA table_info(sanctions)').all().map((c) => c.name);
  for (const c of ['revoked_by', 'revoked_at', 'revoke_reason', 'log_channel_id', 'log_message_id']) assert.ok(cols.includes(c), c);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  assert.ok(tables.includes('sanction_edits') && tables.includes('mod_notes'));
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((i) => i.name);
  for (const i of ['idx_sanction_edits_sanction', 'idx_mod_notes_user', 'idx_mod_notes_sanction', 'idx_sanctions_guild_user_type']) assert.ok(indexes.includes(i), i);
  assert.ok(db.prepare('SELECT 1 FROM _migrations WHERE id = 7').get());

  const id = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn', reason: 'a' });
  repo.editReason(GID, id, MOD, 'b');
  const noteId = notes.create({ guildId: GID, userId: UID, authorId: MOD, content: 'n', sanctionId: id });
  repo.delete(GID, id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sanction_edits').get().n, 0, 'modifications supprimées avec la sanction');
  const note = notes.listByUser(GID, UID)[0];
  assert.equal(note.id, noteId, 'la note est conservée');
  assert.equal(note.sanction_id, null, 'mais détachée de la sanction supprimée');
});

// ---------------------------------------------------------------- dépôt et état

test('sanctionState : en vigueur, levée, expirée, ponctuelle', () => {
  const now = Date.now();
  assert.equal(sanctionState({ active: 1, type: 'tempban', expires_at: now + HOUR }, now), 'active');
  assert.equal(sanctionState({ active: 1, type: 'ban', expires_at: null }, now), 'active');
  assert.equal(sanctionState({ active: 1, type: 'mute', expires_at: null }, now), 'active');
  assert.equal(sanctionState({ active: 1, type: 'timeout', expires_at: now - 1 }, now), 'expired');
  assert.equal(sanctionState({ active: 0, type: 'tempban', expires_at: now - 1 }, now), 'expired');
  assert.equal(sanctionState({ active: 0, type: 'mute', revoked_by: MOD, revoked_at: now, expires_at: now + HOUR }, now), 'revoked');
  assert.equal(sanctionState({ active: 0, type: 'tempban', revoke_reason: 'Débanni hors du bot', revoked_at: now }, now), 'revoked');
  assert.equal(sanctionState({ active: 0, type: 'mute', expires_at: null }, now), 'revoked', 'ancienne levée sans trace');
  assert.equal(sanctionState({ active: 1, type: 'warn', expires_at: null }, now), 'done');
  assert.equal(sanctionState({ active: 1, type: 'kick', expires_at: null }, now), 'done');
});

test('dépôt : raison modifiée avec historique, filtres, pages et comptage par type', () => {
  const { repo } = world();
  const id = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn', reason: 'spam' });
  for (let i = 0; i < 7; i++) repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: i % 2 ? 'mute' : 'warn' });
  repo.create({ guildId: 'autre', userId: UID, moderatorId: MOD, type: 'ban' });
  const res = repo.editReason(GID, id, OTHER, 'spam répété');
  assert.equal(res.oldReason, 'spam');
  assert.equal(repo.get(GID, id).reason, 'spam répété');
  repo.editReason(GID, id, MOD, 'flood');
  const edits = repo.listEdits(GID, id);
  assert.deepEqual(edits.map((e) => [e.old_reason, e.new_reason]), [['spam répété', 'flood'], ['spam', 'spam répété']]);
  assert.equal(repo.countEdits(GID, id), 2);
  assert.equal(repo.editReason('autre', id, MOD, 'x'), null, 'isolation par serveur');

  assert.deepEqual(repo.countByType(GID, UID), { warn: 5, mute: 3 });
  assert.equal(repo.countFiltered(GID, UID), 8);
  assert.equal(repo.countFiltered(GID, UID, 'mute'), 3);
  assert.equal(repo.listPage(GID, UID, { limit: 5 }).length, 5);
  assert.equal(repo.listPage(GID, UID, { limit: 5, offset: 5 }).length, 3);
  assert.ok(repo.listPage(GID, UID, { type: 'mute', limit: 10 }).every((s) => s.type === 'mute'));
});

// ---------------------------------------------------------------- ModerationService

test('levées : auteur, date et motif enregistrés (unban, unmute, untimeout, remplacement)', async () => {
  const w = world();
  const { repo, moderation, guild, bans, moderator } = w;
  const tb = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'tempban', expiresAt: Date.now() + HOUR });
  const perm = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'ban' });
  bans.set(UID, { user: { id: UID, toString: () => `<@${UID}>` } });
  await moderation.unban(guild, UID, moderator, 'erreur');
  for (const id of [tb, perm]) {
    const s = repo.get(GID, id);
    assert.equal(s.active, 0);
    assert.equal(s.revoked_by, MOD);
    assert.equal(s.revoke_reason, 'erreur');
    assert.ok(s.revoked_at);
    assert.equal(sanctionState(s), 'revoked');
  }
  // L'événement guildBanRemove qui suit le débannissement du bot n'écrase pas l'auteur.
  moderation.clearTempbans(GID, UID);
  assert.equal(repo.get(GID, tb).revoked_by, MOD);

  // Débannissement hors du bot : levée automatique.
  const other = repo.create({ guildId: GID, userId: OTHER, moderatorId: MOD, type: 'ban' });
  moderation.clearTempbans(GID, OTHER);
  assert.equal(repo.get(GID, other).revoke_reason, 'Débanni hors du bot');
  assert.equal(repo.get(GID, other).revoked_by, null);

  const target = addMember(w, UID, { muted: true });
  const mute = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'mute' });
  await moderation.unmute(guild, target, moderator, 'calmé');
  assert.equal(repo.get(GID, mute).revoked_by, MOD);
});

test('record() mémorise le message de log ; editReason() le met à jour et journalise', async () => {
  const w = world();
  const { repo, moderation, guild, moderator, logChannel, logs } = w;
  const { id } = await moderation.record(guild, { id: UID, toString: () => `<@${UID}>` }, moderator, { type: 'warn', reason: 'spam' });
  const s = repo.get(GID, id);
  assert.equal(s.log_channel_id, logChannel.id);
  assert.ok(s.log_message_id);

  const res = await moderation.editReason(guild, id, { id: MOD }, '  insultes   répétées ');
  assert.equal(res.oldReason, 'spam');
  assert.equal(res.logUpdated, true);
  assert.equal(repo.get(GID, id).reason, 'insultes répétées');
  const edited = logChannel.messages.get(s.log_message_id);
  const reasonField = edited.embeds[0].fields.find((f) => f.name.includes('Raison') && !f.name.includes('modifiée'));
  assert.equal(reasonField.value, 'insultes répétées');
  assert.ok(edited.embeds[0].fields.some((f) => f.name === '✏️ Raison modifiée'));
  const last = logs.at(-1);
  assert.equal(last.ctx.event, 'sanction');
  assert.match(last.embed.title, /Raison modifiée/);
  assert.ok(last.embed.fields.some((f) => f.value.includes('spam')), 'ancienne raison dans le log');

  // Deuxième modification : un seul champ « Raison modifiée ».
  await moderation.editReason(guild, id, { id: MOD }, 'autre');
  assert.equal(logChannel.messages.get(s.log_message_id).embeds[0].fields.filter((f) => f.name === '✏️ Raison modifiée').length, 1);

  // Log introuvable : la modification passe quand même.
  repo.setLogMessage(GID, id, logChannel.id, '123');
  assert.equal((await moderation.editReason(guild, id, { id: MOD }, 'encore')).logUpdated, false);

  for (const bad of ['', '   ', 'x'.repeat(513), 'encore']) {
    await assert.rejects(moderation.editReason(guild, id, { id: MOD }, bad), { name: 'UserError' }, bad);
  }
  await assert.rejects(moderation.editReason(guild, 9999, { id: MOD }, 'x'), /Aucune sanction/);
});

test('lift() passe par l\'action dédiée et ses garde-fous', async () => {
  const w = world();
  const { repo, moderation, guild, bans, moderator } = w;
  // Ban temporaire → unban
  bans.set(UID, { user: { id: UID } });
  const tb = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'tempban', expiresAt: Date.now() + HOUR });
  assert.equal((await moderation.lift(guild, repo.get(GID, tb), moderator, 'r')).type, 'unban');
  assert.equal(bans.has(UID), false);
  await assert.rejects(moderation.lift(guild, repo.get(GID, tb), moderator, 'r'), /plus en vigueur/);

  // Timeout : hiérarchie vérifiée (cible au-dessus du modérateur → refus).
  addMember(w, OTHER, { timedOut: true, position: 80 });
  const to = repo.create({ guildId: GID, userId: OTHER, moderatorId: MOD, type: 'timeout', expiresAt: Date.now() + HOUR });
  await assert.rejects(moderation.lift(guild, repo.get(GID, to), moderator, 'r'), /supérieur ou égal/);
  assert.equal(repo.get(GID, to).active, 1);

  // Mute d'un membre parti : levé en base (il ne sera pas réappliqué à son retour).
  const mute = repo.create({ guildId: GID, userId: '500000000000000099', moderatorId: MOD, type: 'mute' });
  assert.equal((await moderation.lift(guild, repo.get(GID, mute), moderator, 'r')).type, 'unmute');
  assert.equal(sanctionState(repo.get(GID, mute)), 'revoked');

  // Avertissement : rien à lever.
  const warn = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn' });
  await assert.rejects(moderation.lift(guild, repo.get(GID, warn), moderator, 'r'), { name: 'UserError' });

  // Bot sans « Bannir » : refus explicite.
  const w2 = world({ botPerms: 0n });
  const b = w2.repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'ban' });
  await assert.rejects(w2.moderation.lift(w2.guild, w2.repo.get(GID, b), w2.moderator, 'r'), /Bannir des membres/);
});

// ---------------------------------------------------------------- vues

function seed(w) {
  const { repo, notes } = w;
  const ids = {};
  ids.warn = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn', reason: 'x'.repeat(600) });
  ids.tempban = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'tempban', durationMs: HOUR, expiresAt: Date.now() + HOUR, reason: 'raid' });
  ids.ban = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'ban' });
  ids.mute = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'mute' });
  ids.timeout = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'timeout', durationMs: HOUR, expiresAt: Date.now() - 1 });
  ids.kick = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'kick' });
  ids.revoked = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'mute' });
  repo.deactivateActive(GID, UID, 'mute', { by: OTHER, reason: 'r'.repeat(900) });
  ids.mute2 = repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'mute' });
  for (let i = 0; i < 30; i++) repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn', reason: `motif ${i}` });
  for (let i = 0; i < 8; i++) repo.editReason(GID, ids.warn, MOD, `${'y'.repeat(500)}${i}`);
  for (let i = 0; i < 12; i++) notes.create({ guildId: GID, userId: UID, authorId: MOD, content: 'n'.repeat(1000), sanctionId: i % 2 ? ids.warn : null });
  return ids;
}

test('chaque vue respecte les limites Discord et route vers un gestionnaire existant', () => {
  const w = world();
  const ids = seed(w);
  const views = [
    ...Object.values(ids).map((id) => `case:${id}`),
    `hist:${UID}:0:all`, `hist:${UID}:3:all`, `hist:${UID}:99:all`, `hist:${UID}:0:warn`, `hist:${UID}:0:ban`, `hist:${UID}:0:tempban`,
    `hist:${OTHER}:0:all`, `hist:${OTHER}:0:kick`, `hist.${UID}.1.mute`,
    `notes:${UID}:0`, `notes:${UID}:2`, `notes:${OTHER}:0`,
  ];
  for (const v of views) assertValid(sanctions.render(w.client, w.guild, v, '✅ Notification de test'), v);
  assert.throws(() => sanctions.render(w.client, w.guild, `hist:${UID}:0:inconnu`), { name: 'UserError' });
  assert.throws(() => sanctions.render(w.client, w.guild, 'hist:123:0:all'), { name: 'UserError' });
  assert.throws(() => sanctions.render(w.client, w.guild, 'case:99999'), /Aucune sanction/);
});

test('fiche d\'une sanction : boutons selon l\'état, notes et modifications affichées', () => {
  const w = world();
  const ids = seed(w);
  const lift = (id) => customIds(sanctions.render(w.client, w.guild, `case:${id}`)).includes(`cmd:sanctions:lift:${id}`);
  assert.equal(lift(ids.tempban), true);
  assert.equal(lift(ids.ban), true);
  assert.equal(lift(ids.mute2), true);
  assert.equal(lift(ids.warn), false);
  assert.equal(lift(ids.timeout), false, 'timeout expiré');
  assert.equal(lift(ids.revoked), false, 'déjà levée');
  const warn = sanctions.render(w.client, w.guild, `case:${ids.warn}`);
  const ids1 = customIds(warn);
  for (const a of [`editreason:${ids.warn}`, `notecase:${ids.warn}`, `hist:${UID}:0:all`]) assert.ok(ids1.includes(`cmd:sanctions:${a}`), a);
  const e = json(warn.embeds[0]);
  assert.match(e.title, new RegExp(`#${ids.warn}`));
  assert.ok(e.fields.some((f) => f.name.includes('Modifications de la raison (8)')));
  assert.ok(e.fields.some((f) => f.name.includes('Notes (6)')));
  const revoked = json(sanctions.render(w.client, w.guild, `case:${ids.revoked}`).embeds[0]);
  assert.match(revoked.description, /Levée/);
  assert.ok(revoked.fields.some((f) => f.name.includes('Levée') && f.value.includes(`<@${OTHER}>`)));
  assert.match(json(sanctions.render(w.client, w.guild, `case:${ids.timeout}`).embeds[0]).description, /Expirée/);
});

test('fiche historique : résumé, filtre, pagination ◀ ▶ et menu d\'ouverture', () => {
  const w = world();
  const ids = seed(w);
  const p0 = sanctions.render(w.client, w.guild, `hist:${UID}:0:all`);
  const e = json(p0.embeds[0]);
  const names = e.fields.map((f) => f.name).join('|');
  for (const n of ['Sanctions', 'Strikes actuels', 'Par type', 'Dernière sanction', 'En vigueur']) assert.ok(names.includes(n), n);
  assert.ok(e.fields.find((f) => f.name.includes('Strikes')).value.includes('3'));
  const active = e.fields.find((f) => f.name.includes('En vigueur')).value;
  assert.ok(active.includes(`#${ids.tempban}`) && active.includes(`#${ids.ban}`) && active.includes(`#${ids.mute2}`));
  assert.ok(!active.includes(`#${ids.revoked}\``));
  const c = customIds(p0);
  assert.ok(c.includes(`cmd:sanctions:filter:${UID}`));
  assert.ok(c.includes(`cmd:sanctions:open:${UID}`));
  assert.ok(c.includes(`cmd:sanctions:hist:${UID}:1:all`), 'bouton ▶');
  const filtered = sanctions.render(w.client, w.guild, `hist:${UID}:0:ban`);
  assert.ok(!customIds(filtered).some((id) => id.startsWith('cmd:sanctions:hist:')), 'une seule page : pas de ◀ ▶');
  const empty = sanctions.render(w.client, w.guild, `hist:${OTHER}:0:all`);
  assert.match(json(empty.embeds[0]).description, /aucune sanction/);
});

// ---------------------------------------------------------------- gestionnaires

test('tous les gestionnaires refusent sans « Exclure temporairement des membres »', async () => {
  const w = world();
  const id = w.repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn' });
  for (const [name, handler] of Object.entries(sanctions.buttons)) {
    const i = fake(w, { perms: [], values: [String(id)], fields: { reason: 'x', note: 'x' } });
    await assert.rejects(handler(i, w.client, [String(id), '0', 'all']), { name: 'UserError' }, name);
    await assert.rejects(handler(i, w.client, [UID, '0', 'all']), { name: 'UserError' }, name);
  }
  for (const sub of ['voir', 'historique', 'raison', 'note', 'notes', 'remove', 'clear']) {
    await assert.rejects(sanctions.execute(fake(w, { perms: [], options: { sub, id, membre: { id: UID } } }), w.client), { name: 'UserError' }, sub);
  }
});

test('bouton historyButton (logs, AutoMod, cartes) : ouvre la nouvelle fiche historique', async () => {
  const w = world();
  seed(w);
  const btn = json(historyButton(UID));
  assert.equal(btn.custom_id, `cmd:sanctions:history:${UID}`);
  const i = fake(w);
  await sanctions.buttons.history(i, w.client, [UID]);
  assert.equal(i.calls.reply.length, 1);
  assert.equal(i.calls.reply[0].ephemeral, true);
  assert.match(json(i.calls.reply[0].embeds[0]).title, /Historique de modération/);
  assertValid(i.calls.reply[0], 'history');
  // Ancien bouton de /user : même fiche.
  const j = fake(w);
  await userinfo.buttons.sanctions(j, w.client, [UID]);
  assert.match(json(j.calls.reply[0].embeds[0]).title, /Historique de modération/);
});

test('navigation : page, filtre et ouverture d\'une fiche depuis l\'historique', async () => {
  const w = world();
  const ids = seed(w);
  const i = fake(w);
  await sanctions.buttons.hist(i, w.client, [UID, '2', 'warn']);
  assert.match(json(i.calls.update[0].embeds[0]).footer.text, /Avertissement · Page 3/);
  const f = fake(w, { values: ['mute'] });
  await sanctions.buttons.filter(f, w.client, [UID]);
  assert.match(json(f.calls.update[0].embeds[0]).footer.text, /Mute/);
  await assert.rejects(sanctions.buttons.filter(fake(w, { values: ['../x'] }), w.client, [UID]), /Filtre inconnu/);
  const o = fake(w, { values: [String(ids.ban)] });
  await sanctions.buttons.open(o, w.client, [UID]);
  assert.match(json(o.calls.update[0].embeds[0]).title, new RegExp(`Sanction #${ids.ban}`));
  await assert.rejects(sanctions.buttons.open(fake(w, { values: [String(ids.ban)] }), w.client, [OTHER]), /ne concerne pas/);
  await assert.rejects(sanctions.buttons.hist(fake(w), w.client, ['123', '0', 'all']), /Bouton invalide/);
});

test('modifier la raison : auteur ou « Gérer le serveur », modal ≤ 45 car., trace conservée', async () => {
  const w = world();
  const id = w.repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn', reason: 'spam' });
  // Un autre modérateur sans « Gérer le serveur » : refus (bouton, formulaire et slash).
  await assert.rejects(sanctions.buttons.editreason(fake(w, { user: OTHER }), w.client, [String(id)]), /auteur de la sanction/);
  await assert.rejects(sanctions.buttons.editreasonsubmit(fake(w, { user: OTHER, fields: { reason: 'x' } }), w.client, [String(id)]), /auteur de la sanction/);
  await assert.rejects(sanctions.execute(fake(w, { user: OTHER, options: { sub: 'raison', id, raison: 'x' } }), w.client), /auteur de la sanction/);
  // L'auteur : formulaire prérempli.
  const a = fake(w);
  await sanctions.buttons.editreason(a, w.client, [String(id)]);
  const modal = a.calls.showModal[0];
  assert.equal(modal.custom_id, `cmd:sanctions:editreasonsubmit:${id}`);
  assert.ok(modal.title.length <= 45);
  const input = modal.components[0].components[0];
  assert.ok(input.label.length <= 45);
  assert.equal(input.value, 'spam');
  // Envoi : deferUpdate puis fiche mise à jour.
  const s = fake(w, { fields: { reason: 'flood' } });
  await sanctions.buttons.editreasonsubmit(s, w.client, [String(id)]);
  assert.equal(s.calls.deferUpdate, 1);
  assert.match(json(s.calls.editReply[0].embeds[0]).description, /Raison modifiée/);
  assert.equal(w.repo.get(GID, id).reason, 'flood');
  // « Gérer le serveur » : autorisé via la commande slash.
  const g = fake(w, { user: OTHER, perms: ['ModerateMembers', 'ManageGuild'], options: { sub: 'raison', id, raison: 'menaces' } });
  await sanctions.execute(g, w.client);
  assert.equal(g.calls.deferReply, 1);
  assert.equal(w.repo.get(GID, id).reason, 'menaces');
  assert.deepEqual(w.repo.listEdits(GID, id).map((e) => [e.editor_id, e.old_reason]), [[OTHER, 'flood'], [MOD, 'spam']]);
  // Raison identique ou vide : refus avant tout appel lent.
  const same = fake(w, { fields: { reason: 'menaces' } });
  await assert.rejects(sanctions.buttons.editreasonsubmit(same, w.client, [String(id)]), /identique/);
  assert.equal(same.calls.deferUpdate, 0);
});

test('notes : sur une sanction ou un membre, listées sans effet sur le membre', async () => {
  const w = world();
  const id = w.repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'warn' });
  const m = fake(w);
  await sanctions.buttons.notecase(m, w.client, [String(id)]);
  assert.equal(m.calls.showModal[0].custom_id, `cmd:sanctions:notecasesubmit:${id}`);
  assert.ok(m.calls.showModal[0].components[0].components[0].label.length <= 45);
  const s = fake(w, { fields: { note: 'A promis de se calmer.' } });
  await sanctions.buttons.notecasesubmit(s, w.client, [String(id)]);
  assert.ok(json(s.calls.update[0].embeds[0]).fields.some((f) => f.name.includes('Notes (1)')));

  const u = fake(w);
  await sanctions.buttons.noteuser(u, w.client, [UID]);
  assert.equal(u.calls.showModal[0].custom_id, `cmd:sanctions:noteusersubmit:${UID}`);
  const us = fake(w, { fields: { note: 'Surveillé suite au raid.' } });
  await sanctions.buttons.noteusersubmit(us, w.client, [UID]);
  assert.match(json(us.calls.update[0].embeds[0]).description, /Surveillé suite au raid/);

  const slash = fake(w, { options: { sub: 'note', membre: { id: UID }, texte: 'Troisième note' } });
  await sanctions.execute(slash, w.client);
  assert.equal(slash.calls.reply[0].ephemeral, true);
  assert.equal(w.notes.count(GID, UID), 3);
  await assert.rejects(sanctions.execute(fake(w, { options: { sub: 'note', membre: { id: UID }, texte: '   ' } }), w.client), /vide/);
  await assert.rejects(sanctions.buttons.noteusersubmit(fake(w, { fields: { note: 'x'.repeat(1001) } }), w.client, [UID]), /trop longue/);
  const list = fake(w, { options: { sub: 'notes', membre: { id: UID } } });
  await sanctions.execute(list, w.client);
  assert.match(json(list.calls.reply[0].embeds[0]).fields[0].value, /3/);
  assert.equal(w.repo.count(GID, UID), 1, 'aucune sanction créée');
});

test('🔓 Lever : permission propre à l\'action, puis fiche mise à jour', async () => {
  const w = world();
  w.bans.set(UID, { user: { id: UID } });
  const id = w.repo.create({ guildId: GID, userId: UID, moderatorId: MOD, type: 'tempban', expiresAt: Date.now() + HOUR });
  // Débannir exige « Bannir des membres ».
  const refused = fake(w, { perms: ['ModerateMembers'] });
  await assert.rejects(sanctions.buttons.lift(refused, w.client, [String(id)]), /Bannir des membres/);
  assert.equal(refused.calls.deferUpdate, 0);
  const ok = fake(w, { perms: ['ModerateMembers', 'BanMembers'] });
  await sanctions.buttons.lift(ok, w.client, [String(id)]);
  assert.equal(ok.calls.deferUpdate, 1);
  const e = json(ok.calls.editReply[0].embeds[0]);
  assert.match(e.description, /Sanction levée/);
  assert.ok(!customIds(ok.calls.editReply[0]).includes(`cmd:sanctions:lift:${id}`), 'plus de bouton Lever');
  assert.equal(w.repo.get(GID, id).revoked_by, MOD);
  // Déjà levée : refus.
  await assert.rejects(sanctions.buttons.lift(fake(w, { perms: ['ModerateMembers', 'BanMembers'] }), w.client, [String(id)]), /plus en vigueur/);
  // Timeout : passe par removeTimeout (hiérarchie existante).
  addMember(w, OTHER, { timedOut: true });
  const to = w.repo.create({ guildId: GID, userId: OTHER, moderatorId: MOD, type: 'timeout', expiresAt: Date.now() + HOUR });
  await sanctions.buttons.lift(fake(w), w.client, [String(to)]);
  assert.equal(w.repo.get(GID, to).active, 0);
});

test('commandes slash : voir, historique filtré ; remove/clear gardent le refus des sanctions en vigueur', async () => {
  const w = world();
  const ids = seed(w);
  const v = fake(w, { options: { sub: 'voir', id: ids.tempban } });
  await sanctions.execute(v, w.client);
  assert.equal(v.calls.reply[0].ephemeral, true);
  assertValid(v.calls.reply[0], 'voir');
  await assert.rejects(sanctions.execute(fake(w, { options: { sub: 'voir', id: 99999 } }), w.client), /Aucune sanction/);
  const h = fake(w, { options: { sub: 'historique', membre: { id: UID }, type: 'tempban' } });
  await sanctions.execute(h, w.client);
  assert.match(json(h.calls.reply[0].embeds[0]).footer.text, /Bannissement temporaire/);
  await assert.rejects(sanctions.execute(fake(w, { options: { sub: 'remove', id: ids.tempban } }), w.client), /encore en vigueur/);
  await assert.rejects(sanctions.execute(fake(w, { options: { sub: 'clear', membre: { id: UID, toString: () => `<@${UID}>` } } }), w.client), /encore en vigueur/);
});

test('/user : bouton « Historique de modération » réservé aux modérateurs', async () => {
  const run = async (perms) => {
    const user = { id: UID, username: 'bob', displayName: 'Bob', createdTimestamp: Date.now(), bot: false, toString: () => `<@${UID}>`, displayAvatarURL: () => 'https://cdn.example/a.png', bannerURL: () => null };
    user.fetch = async () => user;
    let payload;
    const i = {
      user,
      options: { getUser: () => user },
      guild: { id: GID, ownerId: 'owner', members: { fetch: async () => { throw new Error('absent'); } } },
      memberPermissions: new PermissionsBitField(perms),
      reply: async (p) => { payload = p; },
    };
    await userinfo.execute(i);
    return customIds(payload);
  };
  assert.ok((await run(['ModerateMembers'])).includes(`cmd:sanctions:history:${UID}`));
  assert.deepEqual((await run([])).filter((id) => id.includes('sanctions')), []);
});

test('/sanctions : sous-commandes conformes', () => {
  const subs = sanctions.data.toJSON().options.map((o) => o.name);
  assert.deepEqual(subs, ['voir', 'historique', 'raison', 'note', 'notes', 'remove', 'clear']);
});
