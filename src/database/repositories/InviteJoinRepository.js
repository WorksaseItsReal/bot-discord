'use strict';

/**
 * Arrivées par invitation (table invite_joins, migration 14). Requêtes préparées uniquement.
 *
 * Comptes d'un inviteur :
 *  - réelles  : arrivées dont le compte n'était pas « faux » (trop récent) ;
 *  - départs  : réelles dont le membre est reparti ;
 *  - fausses  : arrivées d'un compte trop récent ;
 *  - net      : réelles − départs (le chiffre affiché partout).
 */
const STATS_COLUMNS = `
  SUM(CASE WHEN fake = 0 THEN 1 ELSE 0 END) AS regular,
  SUM(CASE WHEN fake = 0 AND left_at IS NOT NULL THEN 1 ELSE 0 END) AS left_count,
  SUM(CASE WHEN fake = 1 THEN 1 ELSE 0 END) AS fake_count`;

const NET = 'SUM(CASE WHEN fake = 0 AND left_at IS NULL THEN 1 ELSE 0 END)';

class InviteJoinRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO invite_joins (guild_id, user_id, inviter_id, code, joined_at, fake)
       VALUES (@guild_id, @user_id, @inviter_id, @code, @joined_at, @fake)`,
    );
    this.markLeftStmt = db.prepare(
      `UPDATE invite_joins SET left_at = ?
        WHERE id = (SELECT id FROM invite_joins WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1)`,
    );
    this.statsStmt = db.prepare(`SELECT ${STATS_COLUMNS} FROM invite_joins WHERE guild_id = ? AND inviter_id = ?`);
    this.boardStmt = db.prepare(
      `SELECT inviter_id, ${STATS_COLUMNS}, ${NET} AS net
         FROM invite_joins WHERE guild_id = ? AND inviter_id IS NOT NULL
        GROUP BY inviter_id
       HAVING COUNT(*) > 0
        ORDER BY net DESC, regular DESC, inviter_id ASC
        LIMIT ? OFFSET ?`,
    );
    this.boardCountStmt = db.prepare('SELECT COUNT(DISTINCT inviter_id) AS n FROM invite_joins WHERE guild_id = ? AND inviter_id IS NOT NULL');
    this.lastJoinStmt = db.prepare('SELECT * FROM invite_joins WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1');
    this.resetGuildStmt = db.prepare('DELETE FROM invite_joins WHERE guild_id = ?');
    this.resetInviterStmt = db.prepare('DELETE FROM invite_joins WHERE guild_id = ? AND inviter_id = ?');
  }

  /**
   * Enregistre une arrivée.
   * @param {{ guildId: string, userId: string, inviterId?: string|null, code?: string|null, joinedAt?: number, fake?: boolean }} row
   */
  recordJoin({ guildId, userId, inviterId = null, code = null, joinedAt = Date.now(), fake = false }) {
    const info = this.insertStmt.run({ guild_id: guildId, user_id: userId, inviter_id: inviterId, code, joined_at: joinedAt, fake: fake ? 1 : 0 });
    return Number(info.lastInsertRowid);
  }

  /** Marque le départ du membre (sa dernière arrivée encore ouverte). @returns {boolean} */
  markLeft(guildId, userId, at = Date.now()) {
    return this.markLeftStmt.run(at, guildId, userId).changes > 0;
  }

  /** Dernière arrivée enregistrée d'un membre, ou null. */
  lastJoin(guildId, userId) {
    return this.lastJoinStmt.get(guildId, userId) ?? null;
  }

  /** @returns {{ regular: number, left: number, fake: number, net: number }} */
  stats(guildId, inviterId) {
    return normalize(this.statsStmt.get(guildId, inviterId));
  }

  /** Classement (net décroissant). @returns {Array<{ inviterId: string, regular: number, left: number, fake: number, net: number }>} */
  leaderboard(guildId, limit = 10, offset = 0) {
    return this.boardStmt.all(guildId, limit, offset).map((r) => ({ inviterId: r.inviter_id, ...normalize(r) }));
  }

  /** Nombre d'inviteurs connus. */
  inviterCount(guildId) {
    return this.boardCountStmt.get(guildId).n;
  }

  /** Efface tout le suivi d'un serveur (ou d'un seul inviteur). @returns {number} lignes supprimées */
  reset(guildId, inviterId = null) {
    return (inviterId ? this.resetInviterStmt.run(guildId, inviterId) : this.resetGuildStmt.run(guildId)).changes;
  }
}

function normalize(row) {
  const regular = Number(row?.regular ?? 0);
  const left = Number(row?.left_count ?? 0);
  const fake = Number(row?.fake_count ?? 0);
  return { regular, left, fake, net: Math.max(0, regular - left) };
}

module.exports = { InviteJoinRepository };
