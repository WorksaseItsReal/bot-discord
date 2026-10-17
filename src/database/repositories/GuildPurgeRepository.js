'use strict';

/**
 * Tables filles SANS colonne guild_id, rattachées à une table du serveur (colonne, parent) :
 * purgées avec leur parent. Toute nouvelle table sans guild_id doit être classée ici ou dans
 * GLOBAL_TABLES (vérifié par tests/review6-coeur.test.js).
 */
const CHILD_TABLES = [
  ['giveaway_entries', 'giveaway_id', 'giveaways'],
  ['giveaway_winners', 'giveaway_id', 'giveaways'],
  ['suggestion_votes', 'suggestion_id', 'suggestions'],
  ['feed_items', 'feed_id', 'feeds'],
  ['project_members', 'project_id', 'projects'],
  ['project_tasks', 'project_id', 'projects'],
];

/** Tables sans lien avec un serveur. */
// bot_settings : réglages de l'instance (console /bot), sans serveur par conception.
const GLOBAL_TABLES = ['_migrations', 'bot_settings'];

/**
 * Tables à guild_id dont les lignes appartiennent au MEMBRE : détachées du serveur (plus aucune
 * trace du serveur ni de ses salons) au lieu d'être supprimées.
 *  - reminders : le rappel de l'utilisateur est encore livré, en message privé, puis supprimé.
 */
const DETACHED = {
  reminders: 'UPDATE reminders SET guild_id = NULL, channel_id = NULL WHERE guild_id = ?',
};

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Purge des données d'un serveur quitté (scheduler, 30 jours après le départ) : TOUTES les
 * tables portant une colonne guild_id (découvertes dans le schéma, donc aussi celles des
 * migrations futures) et leurs tables filles, en UNE transaction.
 */
class GuildPurgeRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    /** @type {{ guildTables: string[], run: (guildId: string) => Record<string, number> } | null} */
    this.plan = null;
    /** @type {Map<string, import('better-sqlite3').Statement>} */
    this.idsStmts = new Map();
  }

  /** Tables de la base et leurs colonnes. */
  #schema() {
    const names = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    return names.map((name) => ({ name, columns: this.db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((c) => c.name) }));
  }

  #buildPlan() {
    if (this.plan) return this.plan;
    const schema = this.#schema();
    const names = new Set(schema.map((t) => t.name));
    const guildTables = schema.filter((t) => t.columns.includes('guild_id')).map((t) => t.name);
    const statements = [];
    // Filles d'abord (leur parent porte le guild_id), puis les tables du serveur.
    for (const [child, column, parent] of CHILD_TABLES) {
      if (!names.has(child) || !guildTables.includes(parent)) continue;
      statements.push([child, this.db.prepare(`DELETE FROM ${quote(child)} WHERE ${quote(column)} IN (SELECT id FROM ${quote(parent)} WHERE guild_id = ?)`)]);
    }
    for (const table of guildTables) {
      statements.push([table, this.db.prepare(DETACHED[table] ?? `DELETE FROM ${quote(table)} WHERE guild_id = ?`)]);
    }
    const run = this.db.transaction((guildId) => {
      const counts = {};
      for (const [table, stmt] of statements) {
        const n = stmt.run(guildId).changes;
        if (n) counts[table] = (counts[table] ?? 0) + n;
      }
      return counts;
    });
    this.plan = { guildTables, run };
    return this.plan;
  }

  /** Tables portant une colonne guild_id. @returns {string[]} */
  guildTables() {
    return [...this.#buildPlan().guildTables];
  }

  /** Serveurs présents dans une table (rattrapage des départs hors ligne). @returns {string[]} */
  guildIds(table) {
    if (!this.#buildPlan().guildTables.includes(table)) return [];
    let stmt = this.idsStmts.get(table);
    if (!stmt) this.idsStmts.set(table, (stmt = this.db.prepare(`SELECT DISTINCT guild_id FROM ${quote(table)} WHERE guild_id IS NOT NULL`)));
    return stmt.all().map((r) => String(r.guild_id));
  }

  /**
   * Supprime toutes les données d'un serveur (transaction : tout ou rien).
   * @returns {Record<string, number>} lignes supprimées (ou détachées) par table
   */
  purgeGuild(guildId) {
    if (!guildId) return {};
    return this.#buildPlan().run(String(guildId));
  }
}

module.exports = { GuildPurgeRepository, CHILD_TABLES, GLOBAL_TABLES, DETACHED };
