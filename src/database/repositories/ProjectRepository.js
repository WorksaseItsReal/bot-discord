'use strict';

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** Convertit une ligne SQL en objet projet (camelCase, JSON décodé). */
function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    number: row.number,
    name: row.name,
    description: row.description,
    status: row.status,
    progress: row.progress,
    ownerId: row.owner_id,
    color: row.color,
    imageUrl: row.image_url,
    thumbnailUrl: row.thumbnail_url,
    deadline: row.deadline,
    tags: parseJson(row.tags, []),
    links: parseJson(row.links, []),
    channelId: row.channel_id,
    messageId: row.message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = {
  name: 'name',
  description: 'description',
  status: 'status',
  progress: 'progress',
  ownerId: 'owner_id',
  color: 'color',
  imageUrl: 'image_url',
  thumbnailUrl: 'thumbnail_url',
  deadline: 'deadline',
  tags: 'tags',
  links: 'links',
  channelId: 'channel_id',
  messageId: 'message_id',
};

/**
 * Accès SQL aux projets, membres et tâches. Toutes les requêtes sont
 * paramétrées et scopées par guild_id quand l'accès part d'un serveur.
 */
class ProjectRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.nextNumberStmt = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM projects WHERE guild_id = ?');
    this.insertStmt = db.prepare(
      `INSERT INTO projects (guild_id, number, name, description, status, progress, owner_id, color, image_url, thumbnail_url, deadline, tags, links, created_at, updated_at)
       VALUES (@guildId, @number, @name, @description, @status, @progress, @ownerId, @color, @imageUrl, @thumbnailUrl, @deadline, @tags, @links, @now, @now)`,
    );
    this.byIdStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.byNumberStmt = db.prepare('SELECT * FROM projects WHERE guild_id = ? AND number = ?');
    this.byNameStmt = db.prepare('SELECT * FROM projects WHERE guild_id = ? AND name = ? COLLATE NOCASE');
    this.listStmt = db.prepare('SELECT * FROM projects WHERE guild_id = ? ORDER BY number ASC');
    this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE guild_id = ?');
    this.countActiveByOwnerStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM projects WHERE guild_id = ? AND owner_id = ? AND status NOT IN ('termine', 'abandonne')",
    );
    this.deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?');
    /** Requêtes UPDATE préparées, par combinaison de colonnes (clé : SQL). */
    this.updateStmts = new Map();

    this.membersStmt = db.prepare('SELECT user_id, role, added_at FROM project_members WHERE project_id = ? ORDER BY added_at ASC');
    this.addMemberStmt = db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
    );
    this.removeMemberStmt = db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?');
    this.isMemberStmt = db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?');
    this.projectsOfMemberStmt = db.prepare(
      `SELECT p.* FROM projects p LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
       WHERE p.guild_id = ? AND (p.owner_id = ? OR m.user_id IS NOT NULL) ORDER BY p.number ASC`,
    );

    this.tasksStmt = db.prepare('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY id ASC');
    this.taskStmt = db.prepare('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?');
    this.addTaskStmt = db.prepare('INSERT INTO project_tasks (project_id, title, created_at) VALUES (?, ?, ?)');
    this.setTaskDoneStmt = db.prepare('UPDATE project_tasks SET done = ?, done_by = ?, done_at = ? WHERE id = ? AND project_id = ?');
    this.removeTaskStmt = db.prepare('DELETE FROM project_tasks WHERE id = ? AND project_id = ?');
    this.taskCountsStmt = db.prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM project_tasks WHERE project_id = ?',
    );
    this.taskCountsByProjectStmt = db.prepare(
      `SELECT t.project_id AS projectId, COUNT(t.id) AS total, COALESCE(SUM(t.done), 0) AS done
       FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE p.guild_id = ? GROUP BY t.project_id`,
    );
    this.guildTaskCountsStmt = db.prepare(
      `SELECT COUNT(t.id) AS total, COALESCE(SUM(t.done), 0) AS done
       FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE p.guild_id = ?`,
    );

    this.createTx = db.transaction((data) => {
      const number = this.nextNumberStmt.get(data.guildId).n;
      const info = this.insertStmt.run({ ...data, number, now: Date.now() });
      return Number(info.lastInsertRowid);
    });
  }

  create(data) {
    const id = this.createTx({
      description: null,
      status: 'planifie',
      progress: null,
      color: null,
      imageUrl: null,
      thumbnailUrl: null,
      deadline: null,
      ...data,
      tags: JSON.stringify(data.tags ?? []),
      links: JSON.stringify(data.links ?? []),
    });
    return this.get(id);
  }

  get(id) {
    return hydrate(this.byIdStmt.get(id));
  }

  getByNumber(guildId, number) {
    return hydrate(this.byNumberStmt.get(guildId, number));
  }

  getByName(guildId, name) {
    return hydrate(this.byNameStmt.get(guildId, name));
  }

  list(guildId) {
    return this.listStmt.all(guildId).map(hydrate);
  }

  listForMember(guildId, userId) {
    return this.projectsOfMemberStmt.all(userId, guildId, userId).map(hydrate);
  }

  count(guildId) {
    return this.countStmt.get(guildId).n;
  }

  countActiveByOwner(guildId, ownerId) {
    return this.countActiveByOwnerStmt.get(guildId, ownerId).n;
  }

  /**
   * Met à jour les champs fournis (clés camelCase autorisées uniquement).
   * @returns {object} projet à jour
   */
  update(id, patch) {
    const sets = [];
    const params = { id, updatedAt: Date.now() };
    for (const [key, value] of Object.entries(patch)) {
      const column = COLUMNS[key];
      if (!column) continue;
      sets.push(`${column} = @${key}`);
      params[key] = key === 'tags' || key === 'links' ? JSON.stringify(value ?? []) : value ?? null;
    }
    sets.push('updated_at = @updatedAt');
    const sql = `UPDATE projects SET ${sets.join(', ')} WHERE id = @id`;
    let stmt = this.updateStmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.updateStmts.set(sql, stmt);
    }
    stmt.run(params);
    return this.get(id);
  }

  /** Marque le projet comme modifié (ex: changement de tâches/membres). */
  touch(id) {
    return this.update(id, {});
  }

  delete(id) {
    return this.deleteStmt.run(id).changes > 0;
  }

  members(projectId) {
    return this.membersStmt.all(projectId).map((r) => ({ userId: r.user_id, role: r.role, addedAt: r.added_at }));
  }

  addMember(projectId, userId, role = null) {
    this.addMemberStmt.run(projectId, userId, role, Date.now());
  }

  removeMember(projectId, userId) {
    return this.removeMemberStmt.run(projectId, userId).changes > 0;
  }

  isMember(projectId, userId) {
    return Boolean(this.isMemberStmt.get(projectId, userId));
  }

  tasks(projectId) {
    return this.tasksStmt.all(projectId).map((t) => ({
      id: t.id,
      title: t.title,
      done: Boolean(t.done),
      doneBy: t.done_by,
      doneAt: t.done_at,
      createdAt: t.created_at,
    }));
  }

  task(projectId, taskId) {
    const t = this.taskStmt.get(taskId, projectId);
    return t ? { id: t.id, title: t.title, done: Boolean(t.done) } : null;
  }

  addTask(projectId, title) {
    return Number(this.addTaskStmt.run(projectId, title, Date.now()).lastInsertRowid);
  }

  setTaskDone(projectId, taskId, done, userId) {
    return this.setTaskDoneStmt.run(done ? 1 : 0, done ? userId : null, done ? Date.now() : null, taskId, projectId).changes > 0;
  }

  removeTask(projectId, taskId) {
    return this.removeTaskStmt.run(taskId, projectId).changes > 0;
  }

  taskCounts(projectId) {
    const r = this.taskCountsStmt.get(projectId);
    return { total: r.total, done: r.done };
  }

  /**
   * Compteurs de tâches de tous les projets du serveur, en une requête.
   * @returns {Map<number, { total: number, done: number }>} (projets sans tâche absents)
   */
  taskCountsByProject(guildId) {
    const map = new Map();
    for (const r of this.taskCountsByProjectStmt.all(guildId)) map.set(r.projectId, { total: r.total, done: r.done });
    return map;
  }

  guildTaskCounts(guildId) {
    const r = this.guildTaskCountsStmt.get(guildId);
    return { total: r.total, done: r.done };
  }
}

module.exports = { ProjectRepository, hydrate };
