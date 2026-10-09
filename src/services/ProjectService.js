'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { UserError } = require('../core/errors');
const { createLogger } = require('../core/logger');
const {
  LIMITS,
  STATUSES,
  CLOSED_STATUSES,
  normalizeUrl,
  buildProjectEmbed,
  buildProjectComponents,
} = require('../utils/projectFormat');

const logger = createLogger('projects');

/**
 * Logique métier des projets : création, droits, membres, tâches, liens,
 * publication et mise à jour en direct du message publié.
 */
class ProjectService {
  /**
   * @param {{ client: import('discord.js').Client, projects: import('../database/repositories/ProjectRepository').ProjectRepository, config: import('./ConfigService').ConfigService }} deps
   */
  constructor({ client, projects, config }) {
    this.client = client;
    this.repo = projects;
    this.config = config;
    /** Debounce des rafraîchissements de messages publiés (évite les rate-limits). */
    this.pendingRefresh = new Map();
    /** Projets en cours de publication : un double clic ne crée pas deux messages. */
    this.publishing = new Set();
  }

  // ---------------------------------------------------------------- droits

  settings(guildId) {
    return this.config.get(guildId).projects;
  }

  /** Gestionnaire global : « Gérer le serveur » ou rôle gestionnaire configuré. */
  isManager(member) {
    if (!member) return false;
    if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
    const roleId = this.settings(member.guild.id).managerRoleId;
    return Boolean(roleId && member.roles?.cache?.has(roleId));
  }

  canEdit(project, member) {
    if (!member) return false;
    return project.ownerId === member.id || this.isManager(member) || this.repo.isMember(project.id, member.id);
  }

  canManage(project, member) {
    if (!member) return false;
    return project.ownerId === member.id || this.isManager(member);
  }

  assertCanEdit(project, member) {
    if (!this.canEdit(project, member)) {
      throw new UserError('Seuls le responsable, les membres de l\'équipe et les gestionnaires peuvent modifier ce projet.');
    }
  }

  assertCanManage(project, member) {
    if (!this.canManage(project, member)) {
      throw new UserError('Seuls le responsable du projet et les gestionnaires peuvent faire cela.');
    }
  }

  // ---------------------------------------------------------------- lecture

  /**
   * Retrouve un projet du serveur à partir d'un numéro (« 3 », « #3 ») ou d'un nom.
   * @returns {object} projet (lève une UserError si introuvable)
   */
  resolve(guildId, ref) {
    const str = String(ref ?? '').trim();
    if (!str) throw new UserError('Indiquez un projet.');
    const num = str.match(/^#?(\d{1,6})$/);
    const project = num ? this.repo.getByNumber(guildId, Number(num[1])) : this.repo.getByName(guildId, str);
    if (!project) throw new UserError(`Projet introuvable : **${str.slice(0, 80)}**. Utilisez \`/projet liste\`.`);
    return project;
  }

  details(project) {
    return { tasks: this.repo.tasks(project.id), members: this.repo.members(project.id) };
  }

  list(guildId, { status = null, memberId = null } = {}) {
    let projects = memberId ? this.repo.listForMember(guildId, memberId) : this.repo.list(guildId);
    if (status) projects = projects.filter((p) => p.status === status);
    const counts = this.repo.taskCountsByProject(guildId);
    return projects.map((project) => ({ project, counts: counts.get(project.id) ?? { total: 0, done: 0 } }));
  }

  /** Choix d'autocomplétion pour l'option « projet ». */
  autocomplete(guildId, focused) {
    const q = String(focused || '').toLowerCase().replace(/^#/, '');
    return this.repo
      .list(guildId)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.number).startsWith(q))
      .slice(0, 25)
      .map((p) => ({
        name: `#${p.number} · ${STATUSES[p.status]?.emoji ?? '❔'} ${p.name}`.slice(0, 100),
        value: String(p.number),
      }));
  }

  render(project, guild) {
    const { tasks, members } = this.details(project);
    return {
      embeds: [buildProjectEmbed(project, { tasks, members, guild })],
      components: buildProjectComponents(project, { hasTasks: tasks.length > 0 }),
    };
  }

  // ---------------------------------------------------------------- écriture

  validateName(guildId, name, exceptId = null) {
    const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new UserError('Le nom du projet est obligatoire.');
    if (clean.length > LIMITS.name) throw new UserError(`Nom trop long (${LIMITS.name} caractères maximum).`);
    if (/^#?\d+$/.test(clean)) throw new UserError('Le nom ne peut pas être uniquement un nombre.');
    const existing = this.repo.getByName(guildId, clean);
    if (existing && existing.id !== exceptId) throw new UserError(`Un projet nommé **${clean}** existe déjà (#${existing.number}).`);
    return clean;
  }

  validateUrlField(value, label) {
    if (value == null || value === '') return null;
    const url = normalizeUrl(value);
    if (!url) throw new UserError(`${label} invalide : utilisez une adresse complète commençant par \`https://\`.`);
    return url;
  }

  create(member, data) {
    const guildId = member.guild.id;
    const settings = this.settings(guildId);
    const manager = this.isManager(member);
    if (!settings.openCreation && !manager) {
      throw new UserError('La création de projets est réservée aux gestionnaires sur ce serveur.');
    }
    if (this.repo.count(guildId) >= LIMITS.perGuild) {
      throw new UserError(`Ce serveur a atteint la limite de ${LIMITS.perGuild} projets. Supprimez-en d'anciens.`);
    }
    if (!manager && this.repo.countActiveByOwner(guildId, member.id) >= settings.maxPerUser) {
      throw new UserError(`Vous avez déjà ${settings.maxPerUser} projets actifs. Terminez-en un avant d'en créer un autre.`);
    }
    const description = data.description?.trim() || null;
    if (description && description.length > LIMITS.description) {
      throw new UserError(`Description trop longue (${LIMITS.description} caractères maximum).`);
    }
    if (data.status && !STATUSES[data.status]) throw new UserError('Statut inconnu.');

    const project = this.repo.create({
      guildId,
      ownerId: member.id,
      name: this.validateName(guildId, data.name),
      description,
      status: data.status || 'planifie',
      color: data.color ?? null,
      imageUrl: this.validateUrlField(data.imageUrl, 'Image'),
      deadline: data.deadline ?? null,
      tags: data.tags ?? [],
      links: data.link ? [{ label: 'Site du projet', url: this.validateUrlField(data.link, 'Lien') }] : [],
    });
    logger.info(`Projet #${project.number} « ${project.name} » créé sur ${guildId} par ${member.id}`);
    return project;
  }

  /** Met à jour des champs puis rafraîchit le message publié. */
  update(project, patch) {
    if (patch.name !== undefined) patch.name = this.validateName(project.guildId, patch.name, project.id);
    if (patch.description !== undefined) {
      const d = patch.description?.trim() || null;
      if (d && d.length > LIMITS.description) throw new UserError(`Description trop longue (${LIMITS.description} caractères maximum).`);
      patch.description = d;
    }
    if (patch.imageUrl !== undefined) patch.imageUrl = this.validateUrlField(patch.imageUrl, 'Image');
    if (patch.thumbnailUrl !== undefined) patch.thumbnailUrl = this.validateUrlField(patch.thumbnailUrl, 'Miniature');
    if (patch.status !== undefined && !STATUSES[patch.status]) throw new UserError('Statut inconnu.');
    const updated = this.repo.update(project.id, patch);
    this.scheduleRefresh(updated.id);
    return updated;
  }

  setProgress(project, value) {
    const counts = this.repo.taskCounts(project.id);
    if (counts.total > 0) {
      throw new UserError('Ce projet a des tâches : sa progression est calculée automatiquement. Cochez des tâches avec `/projet tache-cocher`.');
    }
    const v = Math.round(Number(value));
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new UserError('La progression doit être comprise entre 0 et 100.');
    const patch = { progress: v };
    if (v === 100 && !CLOSED_STATUSES.has(project.status)) patch.status = 'termine';
    else if (v > 0 && v < 100 && ['idee', 'planifie'].includes(project.status)) patch.status = 'en_cours';
    return this.update(project, patch);
  }

  addMember(project, userId, role) {
    if (userId === project.ownerId) throw new UserError('Le responsable fait déjà partie du projet.');
    const members = this.repo.members(project.id);
    const already = members.some((m) => m.userId === userId);
    if (!already && members.length >= LIMITS.members) throw new UserError(`Une équipe compte au maximum ${LIMITS.members} membres.`);
    this.repo.addMember(project.id, userId, role?.trim().slice(0, LIMITS.memberRole) || null);
    this.repo.touch(project.id);
    this.scheduleRefresh(project.id);
    return !already;
  }

  removeMember(project, userId) {
    if (!this.repo.removeMember(project.id, userId)) throw new UserError('Ce membre ne fait pas partie de l\'équipe.');
    this.repo.touch(project.id);
    this.scheduleRefresh(project.id);
  }

  transfer(project, newOwnerId) {
    if (newOwnerId === project.ownerId) throw new UserError('Ce membre est déjà responsable du projet.');
    // L'ancien responsable rejoint l'équipe à la place du nouveau : la limite doit rester respectée.
    const members = this.repo.members(project.id);
    const promoted = members.some((m) => m.userId === newOwnerId);
    const alreadyMember = members.some((m) => m.userId === project.ownerId);
    if (!promoted && !alreadyMember && members.length >= LIMITS.members) {
      throw new UserError(`L'équipe est complète (${LIMITS.members} membres) : l'ancien responsable ne pourrait pas la rejoindre. Retirez d'abord un membre.`);
    }
    this.repo.removeMember(project.id, newOwnerId);
    this.repo.addMember(project.id, project.ownerId, 'Ancien responsable');
    return this.update(project, { ownerId: newOwnerId });
  }

  addTask(project, title) {
    const clean = String(title ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new UserError('Le titre de la tâche est vide.');
    if (clean.length > LIMITS.taskTitle) throw new UserError(`Titre trop long (${LIMITS.taskTitle} caractères maximum).`);
    const counts = this.repo.taskCounts(project.id);
    if (counts.total >= LIMITS.tasks) throw new UserError(`Un projet compte au maximum ${LIMITS.tasks} tâches.`);
    this.repo.addTask(project.id, clean);
    // Une tâche ajoutée à un projet « terminé » le rouvre.
    const patch = project.status === 'termine' ? { status: 'en_cours' } : {};
    return this.update(project, patch);
  }

  resolveTask(project, ref) {
    const id = Number(String(ref ?? '').replace(/^#/, ''));
    const task = Number.isInteger(id) ? this.repo.task(project.id, id) : null;
    if (task) return task;
    const byTitle = this.repo.tasks(project.id).find((t) => t.title.toLowerCase() === String(ref ?? '').trim().toLowerCase());
    if (!byTitle) throw new UserError('Tâche introuvable. Utilisez l\'autocomplétion pour la choisir.');
    return byTitle;
  }

  /** Coche/décoche une tâche. Toutes cochées → projet terminé automatiquement. */
  toggleTask(project, taskRef, userId) {
    const task = this.resolveTask(project, taskRef);
    this.repo.setTaskDone(project.id, task.id, !task.done, userId);
    const counts = this.repo.taskCounts(project.id);
    const patch = {};
    if (counts.total > 0 && counts.done === counts.total && !CLOSED_STATUSES.has(project.status)) patch.status = 'termine';
    else if (counts.done < counts.total && project.status === 'termine') patch.status = 'en_cours';
    else if (counts.done > 0 && ['idee', 'planifie'].includes(project.status)) patch.status = 'en_cours';
    return { task: { ...task, done: !task.done }, project: this.update(project, patch), counts };
  }

  removeTask(project, taskRef) {
    const task = this.resolveTask(project, taskRef);
    this.repo.removeTask(project.id, task.id);
    return { task, project: this.update(project, {}) };
  }

  addLink(project, label, url) {
    const cleanLabel = String(label ?? '').trim().slice(0, LIMITS.linkLabel);
    if (!cleanLabel) throw new UserError('Donnez un nom au lien.');
    const cleanUrl = this.validateUrlField(url, 'Lien');
    const links = (project.links || []).filter((l) => l.label.toLowerCase() !== cleanLabel.toLowerCase());
    if (links.length >= LIMITS.links) throw new UserError(`Un projet compte au maximum ${LIMITS.links} liens.`);
    links.push({ label: cleanLabel, url: cleanUrl });
    return this.update(project, { links });
  }

  removeLink(project, label) {
    const links = project.links || [];
    const next = links.filter((l) => l.label.toLowerCase() !== String(label ?? '').trim().toLowerCase());
    if (next.length === links.length) throw new UserError('Aucun lien ne porte ce nom.');
    return this.update(project, { links: next });
  }

  async delete(project) {
    await this.#deletePublished(project);
    this.repo.delete(project.id);
    logger.info(`Projet #${project.number} supprimé sur ${project.guildId}`);
  }

  // ---------------------------------------------------------------- publication

  /**
   * Publie (ou republie) l'embed du projet dans un salon et mémorise le message
   * pour les mises à jour automatiques.
   */
  async publish(project, channel) {
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
      throw new UserError('Choisissez un salon textuel.');
    }
    const me = channel.guild?.members?.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new UserError(`Je ne peux pas publier dans ${channel} : il me faut **Voir le salon**, **Envoyer des messages** et **Intégrer des liens**.`);
    }
    // Verrou par projet, posé de façon synchrone avant toute attente.
    if (this.publishing.has(project.id)) throw new UserError('Ce projet est déjà en cours de publication…');
    this.publishing.add(project.id);
    try {
      // Relecture : l'objet reçu peut être antérieur à une publication qui vient de se terminer.
      const current = this.repo.get?.(project.id) ?? project;
      await this.#deletePublished(current);
      const message = await channel.send(this.render(current, channel.guild));
      return this.repo.update(project.id, { channelId: channel.id, messageId: message.id });
    } finally {
      this.publishing.delete(project.id);
    }
  }

  /** Rafraîchit le message publié dans ~2 s (regroupe les modifications rapprochées). */
  scheduleRefresh(projectId) {
    if (this.pendingRefresh.has(projectId)) return;
    const timer = setTimeout(() => {
      this.pendingRefresh.delete(projectId);
      this.refreshPublished(projectId).catch((err) => logger.warn(`Rafraîchissement du projet ${projectId} :`, err?.message));
    }, 2_000);
    timer.unref?.();
    this.pendingRefresh.set(projectId, timer);
  }

  /**
   * Arrêt du bot : exécute tout de suite les rafraîchissements programmés
   * (sinon la fiche publiée reste périmée) et annule leurs minuteurs.
   */
  async flush() {
    const ids = [...this.pendingRefresh.keys()];
    for (const id of ids) clearTimeout(this.pendingRefresh.get(id));
    this.pendingRefresh.clear();
    await Promise.allSettled(ids.map((id) => this.refreshPublished(id).catch((err) => logger.warn(`Rafraîchissement du projet ${id} à l'arrêt :`, err?.message))));
  }

  async refreshPublished(projectId) {
    const project = this.repo.get(projectId);
    if (!project?.channelId || !project.messageId) return;
    const channel = await this.client.channels.fetch(project.channelId).catch(() => null);
    const message = channel?.messages ? await channel.messages.fetch(project.messageId).catch(() => null) : null;
    if (!message) {
      // Message ou salon supprimé : on oublie la publication.
      this.repo.update(project.id, { channelId: null, messageId: null });
      return;
    }
    await message.edit(this.render(project, channel.guild));
  }

  async #deletePublished(project) {
    if (!project.channelId || !project.messageId) return;
    const channel = await this.client.channels.fetch(project.channelId).catch(() => null);
    const message = channel?.messages ? await channel.messages.fetch(project.messageId).catch(() => null) : null;
    await message?.delete().catch(() => {});
  }

  // ---------------------------------------------------------------- stats

  stats(guildId) {
    const projects = this.repo.list(guildId);
    const byStatus = {};
    const owners = new Map();
    let overdue = 0;
    const now = Date.now();
    for (const p of projects) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      owners.set(p.ownerId, (owners.get(p.ownerId) || 0) + 1);
      if (p.deadline && !CLOSED_STATUSES.has(p.status) && now > p.deadline + 12 * 3600_000) overdue += 1;
    }
    const topOwners = [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { total: projects.length, byStatus, overdue, topOwners, tasks: this.repo.guildTaskCounts(guildId) };
  }
}

module.exports = { ProjectService };
