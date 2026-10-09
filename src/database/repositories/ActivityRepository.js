'use strict';

/**
 * Statistiques du serveur (/statistiques, /activite) : compteurs agrégés par jour UTC
 * (AAAA-MM-JJ), jamais de contenu. Écritures groupées (ActivityService vide son tampon
 * toutes les 30 s) ; lectures bornées à une date de début incluse (`fromDay`).
 */
class ActivityRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.addMessagesStmt = db.prepare(
      `INSERT INTO activity_daily (guild_id, day, channel_id, user_id, messages) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, day, channel_id, user_id) DO UPDATE SET messages = messages + excluded.messages`,
    );
    this.addVoiceStmt = db.prepare(
      `INSERT INTO activity_daily (guild_id, day, channel_id, user_id, voice_seconds) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, day, channel_id, user_id) DO UPDATE SET voice_seconds = voice_seconds + excluded.voice_seconds`,
    );
    this.addHourStmt = db.prepare(
      `INSERT INTO activity_hourly (guild_id, day, hour, messages) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, day, hour) DO UPDATE SET messages = messages + excluded.messages`,
    );
    this.addFlowStmt = db.prepare(
      `INSERT INTO member_flow_daily (guild_id, day, joins, leaves) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, day) DO UPDATE SET joins = joins + excluded.joins, leaves = leaves + excluded.leaves`,
    );
    this.batchTx = db.transaction(({ messages = [], voice = [], hours = [], flows = [] }) => {
      for (const r of messages) this.addMessagesStmt.run(r.guildId, r.day, r.channelId, r.userId, r.count);
      for (const r of voice) this.addVoiceStmt.run(r.guildId, r.day, r.channelId, r.userId, r.seconds);
      for (const r of hours) this.addHourStmt.run(r.guildId, r.day, r.hour, r.count);
      for (const r of flows) this.addFlowStmt.run(r.guildId, r.day, r.joins, r.leaves);
    });

    // Début de la collecte.
    this.ensureSinceStmt = db.prepare('INSERT OR IGNORE INTO stats_guilds (guild_id, since) VALUES (?, ?)');
    this.setSinceStmt = db.prepare('INSERT INTO stats_guilds (guild_id, since) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET since = excluded.since');
    this.getSinceStmt = db.prepare('SELECT since FROM stats_guilds WHERE guild_id = ?');
    this.clearSinceStmt = db.prepare('DELETE FROM stats_guilds WHERE guild_id = ?');
    this.guildsStmt = db.prepare(
      `SELECT guild_id FROM stats_guilds
       UNION SELECT DISTINCT guild_id FROM member_flow_daily
       UNION SELECT DISTINCT guild_id FROM activity_hourly`,
    );
    this.nextGuildStmt = db.prepare('SELECT guild_id FROM activity_daily WHERE guild_id > ? ORDER BY guild_id LIMIT 1');

    // Purge.
    this.purgeDailyStmt = db.prepare('DELETE FROM activity_daily WHERE guild_id = ? AND day < ?');
    this.purgeHourlyStmt = db.prepare('DELETE FROM activity_hourly WHERE guild_id = ? AND day < ?');
    this.purgeFlowStmt = db.prepare('DELETE FROM member_flow_daily WHERE guild_id = ? AND day < ?');
    this.purgeDmsStmt = db.prepare('DELETE FROM inactivity_dms WHERE sent_at < ?');
    this.wipeTx = db.transaction((guildId) => {
      let n = 0;
      for (const table of ['activity_daily', 'activity_hourly', 'member_flow_daily', 'inactivity_dms', 'stats_guilds']) {
        n += db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId).changes;
      }
      return n;
    });

    // Lectures « serveur ».
    this.dailyStmt = db.prepare(
      `SELECT day, SUM(messages) AS messages, SUM(voice_seconds) AS voice FROM activity_daily
       WHERE guild_id = ? AND day >= ? GROUP BY day ORDER BY day`,
    );
    this.totalsStmt = db.prepare(
      `SELECT COALESCE(SUM(messages), 0) AS messages, COALESCE(SUM(voice_seconds), 0) AS voice,
              COUNT(DISTINCT user_id) AS members, COUNT(DISTINCT CASE WHEN messages > 0 THEN channel_id END) AS channels
       FROM activity_daily WHERE guild_id = ? AND day >= ?`,
    );
    this.topChannelsStmt = db.prepare(
      `SELECT channel_id, SUM(messages) AS messages, COUNT(DISTINCT user_id) AS members FROM activity_daily
       WHERE guild_id = ? AND day >= ? AND messages > 0 GROUP BY channel_id ORDER BY messages DESC, channel_id LIMIT ?`,
    );
    this.topVoiceChannelsStmt = db.prepare(
      `SELECT channel_id, SUM(voice_seconds) AS voice, COUNT(DISTINCT user_id) AS members FROM activity_daily
       WHERE guild_id = ? AND day >= ? AND voice_seconds > 0 GROUP BY channel_id ORDER BY voice DESC, channel_id LIMIT ?`,
    );
    this.topMembersStmt = db.prepare(
      `SELECT user_id, SUM(messages) AS messages, SUM(voice_seconds) AS voice FROM activity_daily
       WHERE guild_id = ? AND day >= ? GROUP BY user_id HAVING SUM(messages) > 0 ORDER BY messages DESC, user_id LIMIT ?`,
    );
    this.topVoiceMembersStmt = db.prepare(
      `SELECT user_id, SUM(messages) AS messages, SUM(voice_seconds) AS voice FROM activity_daily
       WHERE guild_id = ? AND day >= ? GROUP BY user_id HAVING SUM(voice_seconds) > 0 ORDER BY voice DESC, user_id LIMIT ?`,
    );
    this.hourlyStmt = db.prepare(
      'SELECT hour, SUM(messages) AS messages FROM activity_hourly WHERE guild_id = ? AND day >= ? GROUP BY hour ORDER BY hour',
    );
    this.flowsStmt = db.prepare('SELECT day, joins, leaves FROM member_flow_daily WHERE guild_id = ? AND day >= ? ORDER BY day');

    // Lectures « membre ».
    this.memberDailyStmt = db.prepare(
      `SELECT day, SUM(messages) AS messages, SUM(voice_seconds) AS voice FROM activity_daily
       WHERE guild_id = ? AND user_id = ? AND day >= ? GROUP BY day ORDER BY day`,
    );
    this.memberChannelsStmt = db.prepare(
      `SELECT channel_id, SUM(messages) AS messages, SUM(voice_seconds) AS voice FROM activity_daily
       WHERE guild_id = ? AND user_id = ? AND day >= ? GROUP BY channel_id
       ORDER BY messages DESC, voice DESC, channel_id LIMIT ?`,
    );
    this.memberLastStmt = db.prepare('SELECT MAX(day) AS day FROM activity_daily WHERE guild_id = ? AND user_id = ?');
    this.rankStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT user_id FROM activity_daily WHERE guild_id = ? AND day >= ?
       GROUP BY user_id HAVING SUM(messages) > ?)`,
    );
    this.lastActiveStmt = db.prepare('SELECT user_id, MAX(day) AS day FROM activity_daily WHERE guild_id = ? GROUP BY user_id');

    // MP « membre inactif ».
    this.claimDmStmt = db.prepare(
      `INSERT INTO inactivity_dms (guild_id, user_id, sent_at) VALUES (@guildId, @userId, @now)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET sent_at = excluded.sent_at WHERE inactivity_dms.sent_at <= @before`,
    );
    this.recentDmsStmt = db.prepare('SELECT user_id FROM inactivity_dms WHERE guild_id = ? AND sent_at > ?');
  }

  /**
   * Ajoute un lot de compteurs en une transaction.
   * @param {{ messages?: object[], voice?: object[], hours?: object[], flows?: object[] }} batch
   */
  applyBatch(batch) {
    this.batchTx(batch);
  }

  ensureSince(guildId, at = Date.now()) {
    return this.ensureSinceStmt.run(guildId, at).changes > 0;
  }

  setSince(guildId, at = Date.now()) {
    this.setSinceStmt.run(guildId, at);
  }

  /** @returns {number|null} début de la collecte (ms) */
  getSince(guildId) {
    return this.getSinceStmt.get(guildId)?.since ?? null;
  }

  clearSince(guildId) {
    this.clearSinceStmt.run(guildId);
  }

  /** Serveurs ayant des statistiques (purge quotidienne). */
  guilds() {
    const ids = new Set(this.guildsStmt.all().map((r) => r.guild_id));
    // activity_daily : parcours de la clé primaire, sans DISTINCT complet (saut d'un serveur à l'autre).
    let last = '';
    for (let row = this.nextGuildStmt.get(last); row; row = this.nextGuildStmt.get(last)) {
      ids.add(row.guild_id);
      last = row.guild_id;
    }
    return [...ids];
  }

  /** Supprime les compteurs antérieurs à `day` (exclu). @returns {number} lignes supprimées */
  purgeBefore(guildId, day) {
    return this.purgeDailyStmt.run(guildId, day).changes + this.purgeHourlyStmt.run(guildId, day).changes + this.purgeFlowStmt.run(guildId, day).changes;
  }

  purgeDmsBefore(ts) {
    return this.purgeDmsStmt.run(ts).changes;
  }

  /** Efface toutes les statistiques d'un serveur (y compris le début de collecte). */
  wipe(guildId) {
    return this.wipeTx(guildId);
  }

  daily(guildId, fromDay) {
    return this.dailyStmt.all(guildId, fromDay);
  }

  totals(guildId, fromDay) {
    return this.totalsStmt.get(guildId, fromDay);
  }

  topChannels(guildId, fromDay, limit = 10) {
    return this.topChannelsStmt.all(guildId, fromDay, limit);
  }

  topVoiceChannels(guildId, fromDay, limit = 5) {
    return this.topVoiceChannelsStmt.all(guildId, fromDay, limit);
  }

  topMembers(guildId, fromDay, limit = 10) {
    return this.topMembersStmt.all(guildId, fromDay, limit);
  }

  topVoiceMembers(guildId, fromDay, limit = 5) {
    return this.topVoiceMembersStmt.all(guildId, fromDay, limit);
  }

  hourly(guildId, fromDay) {
    return this.hourlyStmt.all(guildId, fromDay);
  }

  flows(guildId, fromDay) {
    return this.flowsStmt.all(guildId, fromDay);
  }

  memberDaily(guildId, userId, fromDay) {
    return this.memberDailyStmt.all(guildId, userId, fromDay);
  }

  memberChannels(guildId, userId, fromDay, limit = 5) {
    return this.memberChannelsStmt.all(guildId, userId, fromDay, limit);
  }

  /** @returns {string|null} dernier jour d'activité du membre (dans la rétention) */
  memberLastDay(guildId, userId) {
    return this.memberLastStmt.get(guildId, userId)?.day ?? null;
  }

  /** Rang d'un membre par messages sur la période (1 = le plus actif). */
  rank(guildId, fromDay, messages) {
    return this.rankStmt.get(guildId, fromDay, messages).n + 1;
  }

  /** @returns {Map<string, string>} membre → dernier jour d'activité (messages ou vocal) */
  lastActive(guildId) {
    return new Map(this.lastActiveStmt.all(guildId).map((r) => [r.user_id, r.day]));
  }

  /**
   * Réserve l'envoi d'un MP « inactif » : faux si un MP a été envoyé après `before`.
   * Écrit AVANT l'envoi : deux exécutions simultanées n'envoient jamais deux MP.
   */
  claimDm(guildId, userId, now, before) {
    return this.claimDmStmt.run({ guildId, userId, now, before }).changes > 0;
  }

  /** @returns {Set<string>} membres ayant reçu un MP après `after` */
  recentDms(guildId, after) {
    return new Set(this.recentDmsStmt.all(guildId, after).map((r) => r.user_id));
  }
}

module.exports = { ActivityRepository };
