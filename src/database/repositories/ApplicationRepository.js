'use strict';

/** Formulaires de candidature au plus par serveur. */
const MAX_FORMS = 5;

const parseJson = (raw, fallback) => {
  try {
    const value = JSON.parse(raw ?? '');
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
};

/** Ligne `application_forms` → formulaire (JSON décodé, booléens). Pur. */
function hydrateForm(row) {
  if (!row) return null;
  return {
    ...row,
    open: Boolean(row.open),
    questions: parseJson(row.questions, []).filter((q) => q && typeof q.label === 'string').map((q) => ({ label: q.label, long: Boolean(q.long) })),
    role_ids: parseJson(row.role_ids, []).filter((id) => typeof id === 'string'),
  };
}

/** Ligne `applications` → candidature (réponses décodées). Pur. */
function hydrateApplication(row) {
  if (!row) return null;
  return { ...row, answers: parseJson(row.answers, []).filter((a) => a && typeof a.q === 'string').map((a) => ({ q: a.q, a: String(a.a ?? '') })) };
}

/**
 * Candidatures (migration 23) : formulaires et candidatures envoyées.
 * Gardes atomiques : 5 formulaires par serveur (transaction), une candidature en attente
 * par membre et par formulaire (index unique partiel), une seule décision par candidature
 * (`UPDATE … WHERE status = 'pending'`).
 */
class ApplicationRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    // ---------------------------------------------------------------- formulaires
    this.insertFormStmt = db.prepare(
      `INSERT INTO application_forms (guild_id, name, description, questions, role_ids, review_channel_id, ping_role_id, open, cooldown_ms, created_at, updated_at)
       VALUES (@guildId, @name, @description, @questions, @roleIds, @reviewChannelId, @pingRoleId, @open, @cooldownMs, @now, @now)`,
    );
    this.updateFormStmt = db.prepare(
      `UPDATE application_forms SET name = @name, description = @description, questions = @questions, role_ids = @roleIds,
         review_channel_id = @reviewChannelId, ping_role_id = @pingRoleId, open = @open, cooldown_ms = @cooldownMs,
         panel_channel_id = @panelChannelId, panel_message_id = @panelMessageId, updated_at = @now
       WHERE id = @id AND guild_id = @guildId`,
    );
    this.formStmt = db.prepare('SELECT * FROM application_forms WHERE id = ? AND guild_id = ?');
    this.formsStmt = db.prepare('SELECT * FROM application_forms WHERE guild_id = ? ORDER BY id ASC');
    this.countFormsStmt = db.prepare('SELECT COUNT(*) AS n FROM application_forms WHERE guild_id = ?');
    this.deleteFormStmt = db.prepare('DELETE FROM application_forms WHERE id = ? AND guild_id = ?');
    this.createFormTx = db.transaction((data) => {
      if (this.countFormsStmt.get(data.guildId).n >= MAX_FORMS) return null;
      return Number(this.insertFormStmt.run(data).lastInsertRowid);
    });

    // ---------------------------------------------------------------- candidatures
    this.insertAppStmt = db.prepare(
      `INSERT INTO applications (guild_id, form_id, form_name, user_id, answers, status, created_at)
       VALUES (@guildId, @formId, @formName, @userId, @answers, 'pending', @now)`,
    );
    this.appStmt = db.prepare('SELECT * FROM applications WHERE id = ? AND guild_id = ?');
    this.lastByMemberStmt = db.prepare('SELECT * FROM applications WHERE form_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    this.pendingByMemberStmt = db.prepare("SELECT * FROM applications WHERE form_id = ? AND user_id = ? AND status = 'pending'");
    this.byMemberStmt = db.prepare('SELECT * FROM applications WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?');
    this.pendingOfMemberStmt = db.prepare("SELECT * FROM applications WHERE guild_id = ? AND user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT ?");
    this.pendingStmt = db.prepare("SELECT * FROM applications WHERE guild_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?");
    this.countsStmt = db.prepare('SELECT status, COUNT(*) AS n FROM applications WHERE guild_id = ? GROUP BY status');
    this.pendingPerFormStmt = db.prepare("SELECT form_id, COUNT(*) AS n FROM applications WHERE guild_id = ? AND status = 'pending' GROUP BY form_id");
    this.decideStmt = db.prepare(
      "UPDATE applications SET status = @status, reviewer_id = @reviewerId, reason = @reason, decided_at = @now WHERE id = @id AND guild_id = @guildId AND status = 'pending'",
    );
    this.withdrawStmt = db.prepare(
      "UPDATE applications SET status = 'withdrawn', decided_at = ? WHERE id = ? AND guild_id = ? AND user_id = ? AND status = 'pending'",
    );
    this.setCardStmt = db.prepare('UPDATE applications SET card_channel_id = ?, card_message_id = ? WHERE id = ? AND guild_id = ?');
    this.setNoteStmt = db.prepare('UPDATE applications SET note = ? WHERE id = ? AND guild_id = ?');
    this.setInterviewStmt = db.prepare('UPDATE applications SET interview_channel_id = ? WHERE id = ? AND guild_id = ?');
    this.deleteAppStmt = db.prepare('DELETE FROM applications WHERE id = ? AND guild_id = ?');
  }

  // ------------------------------------------------------------ formulaires

  /**
   * Crée un formulaire (fermé par défaut).
   * @returns {number|null} identifiant, ou null si le serveur a déjà 5 formulaires
   */
  createForm({ guildId, name, description = null, questions = [], roleIds = [], reviewChannelId = null, pingRoleId = null, open = false, cooldownMs = 0 }) {
    return this.createFormTx({
      guildId,
      name,
      description,
      questions: JSON.stringify(questions),
      roleIds: JSON.stringify(roleIds),
      reviewChannelId,
      pingRoleId,
      open: open ? 1 : 0,
      cooldownMs: Math.max(0, Math.floor(Number(cooldownMs) || 0)),
      now: Date.now(),
    });
  }

  getForm(guildId, id) {
    return hydrateForm(this.formStmt.get(id, guildId));
  }

  listForms(guildId) {
    return this.formsStmt.all(guildId).map(hydrateForm);
  }

  countForms(guildId) {
    return this.countFormsStmt.get(guildId).n;
  }

  /**
   * Modifie un formulaire (champs fournis seulement, clés en camelCase).
   * @returns {object|null} formulaire à jour, ou null s'il n'existe plus
   */
  updateForm(guildId, id, patch) {
    const current = this.getForm(guildId, id);
    if (!current) return null;
    const next = {
      name: patch.name ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
      questions: JSON.stringify(patch.questions ?? current.questions),
      roleIds: JSON.stringify(patch.roleIds ?? current.role_ids),
      reviewChannelId: patch.reviewChannelId !== undefined ? patch.reviewChannelId : current.review_channel_id,
      pingRoleId: patch.pingRoleId !== undefined ? patch.pingRoleId : current.ping_role_id,
      open: (patch.open !== undefined ? patch.open : current.open) ? 1 : 0,
      cooldownMs: Math.max(0, Math.floor(Number(patch.cooldownMs !== undefined ? patch.cooldownMs : current.cooldown_ms) || 0)),
      panelChannelId: patch.panelChannelId !== undefined ? patch.panelChannelId : current.panel_channel_id,
      panelMessageId: patch.panelMessageId !== undefined ? patch.panelMessageId : current.panel_message_id,
    };
    this.updateFormStmt.run({ ...next, id, guildId, now: Date.now() });
    return this.getForm(guildId, id);
  }

  /** @returns {boolean} */
  deleteForm(guildId, id) {
    return this.deleteFormStmt.run(id, guildId).changes > 0;
  }

  // ------------------------------------------------------------ candidatures

  /**
   * Enregistre une candidature en attente.
   * @returns {number|null} identifiant, ou null si le membre en a déjà une en attente pour ce formulaire
   */
  createApplication({ guildId, formId, formName, userId, answers, now = Date.now() }) {
    try {
      return Number(this.insertAppStmt.run({ guildId, formId, formName, userId, answers: JSON.stringify(answers), now }).lastInsertRowid);
    } catch (err) {
      if (String(err?.code ?? '').startsWith('SQLITE_CONSTRAINT')) return null;
      throw err;
    }
  }

  getApplication(guildId, id) {
    return hydrateApplication(this.appStmt.get(id, guildId));
  }

  /** Dernière candidature d'un membre à un formulaire (tous statuts), ou null. */
  lastByMember(formId, userId) {
    return hydrateApplication(this.lastByMemberStmt.get(formId, userId));
  }

  /** Candidature en attente d'un membre pour un formulaire, ou null. */
  pendingByMember(formId, userId) {
    return hydrateApplication(this.pendingByMemberStmt.get(formId, userId));
  }

  /** Candidatures d'un membre sur un serveur, des plus récentes aux plus anciennes. */
  listByMember(guildId, userId, limit = 10) {
    return this.byMemberStmt.all(guildId, userId, limit).map(hydrateApplication);
  }

  /** Candidatures en attente d'un membre. */
  listPendingOfMember(guildId, userId, limit = 25) {
    return this.pendingOfMemberStmt.all(guildId, userId, limit).map(hydrateApplication);
  }

  /** Candidatures en attente du serveur, des plus anciennes aux plus récentes. */
  listPending(guildId, limit = 25) {
    return this.pendingStmt.all(guildId, limit).map(hydrateApplication);
  }

  /** @returns {{ pending: number, accepted: number, rejected: number, withdrawn: number }} */
  counts(guildId) {
    const out = { pending: 0, accepted: 0, rejected: 0, withdrawn: 0 };
    for (const r of this.countsStmt.all(guildId)) out[r.status] = r.n;
    return out;
  }

  /** Candidatures en attente par formulaire : Map(formId → nombre). */
  pendingPerForm(guildId) {
    return new Map(this.pendingPerFormStmt.all(guildId).map((r) => [r.form_id, r.n]));
  }

  /**
   * Décision atomique : seul le premier appel sur une candidature en attente aboutit.
   * @param {'accepted'|'rejected'} status
   * @returns {boolean}
   */
  decide(guildId, id, { status, reviewerId, reason = null, now = Date.now() }) {
    return this.decideStmt.run({ guildId, id, status, reviewerId, reason, now }).changes > 0;
  }

  /** Retrait par son auteur d'une candidature encore en attente. @returns {boolean} */
  withdraw(guildId, id, userId, now = Date.now()) {
    return this.withdrawStmt.run(now, id, guildId, userId).changes > 0;
  }

  setCard(guildId, id, channelId, messageId) {
    this.setCardStmt.run(channelId, messageId, id, guildId);
  }

  setNote(guildId, id, note) {
    this.setNoteStmt.run(note, id, guildId);
  }

  setInterview(guildId, id, channelId) {
    this.setInterviewStmt.run(channelId, id, guildId);
  }

  /** Supprime une candidature (carte jamais publiée). */
  deleteApplication(guildId, id) {
    return this.deleteAppStmt.run(id, guildId).changes > 0;
  }
}

module.exports = { ApplicationRepository, MAX_FORMS, hydrateForm, hydrateApplication };
