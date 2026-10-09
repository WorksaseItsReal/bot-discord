'use strict';

class TempVoiceRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.insertStmt = db.prepare(
      'INSERT OR REPLACE INTO temp_voice (channel_id, guild_id, owner_id, created_at, locked, hidden) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.getStmt = db.prepare('SELECT * FROM temp_voice WHERE channel_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM temp_voice WHERE channel_id = ?');
    this.allStmt = db.prepare('SELECT * FROM temp_voice');
    this.setOwnerStmt = db.prepare('UPDATE temp_voice SET owner_id = ? WHERE channel_id = ?');
    this.setPanelStmt = db.prepare('UPDATE temp_voice SET panel_message_id = ? WHERE channel_id = ?');
    this.setStateStmt = db.prepare('UPDATE temp_voice SET locked = COALESCE(?, locked), hidden = COALESCE(?, hidden) WHERE channel_id = ?');

    this.getPrefsStmt = db.prepare('SELECT * FROM temp_voice_prefs WHERE guild_id = ? AND user_id = ?');
    this.putPrefsStmt = db.prepare(
      'INSERT OR REPLACE INTO temp_voice_prefs (guild_id, user_id, name, user_limit, locked, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.deletePrefsStmt = db.prepare('DELETE FROM temp_voice_prefs WHERE guild_id = ? AND user_id = ?');
    this.countPrefsStmt = db.prepare('SELECT COUNT(*) AS n FROM temp_voice_prefs WHERE guild_id = ?');
  }

  create(channelId, guildId, ownerId, { locked = false, hidden = false } = {}) {
    this.insertStmt.run(channelId, guildId, ownerId, Date.now(), locked ? 1 : 0, hidden ? 1 : 0);
  }

  get(channelId) {
    return this.getStmt.get(channelId);
  }

  delete(channelId) {
    this.deleteStmt.run(channelId);
  }

  all() {
    return this.allStmt.all();
  }

  setOwner(channelId, ownerId) {
    this.setOwnerStmt.run(ownerId, channelId);
  }

  setPanel(channelId, messageId) {
    this.setPanelStmt.run(messageId, channelId);
  }

  /** @param {{ locked?: boolean, hidden?: boolean }} state champs absents inchangés */
  setState(channelId, { locked, hidden } = {}) {
    const v = (b) => (b === undefined ? null : b ? 1 : 0);
    this.setStateStmt.run(v(locked), v(hidden), channelId);
  }

  // -------------------------------------------------------------- préférences

  getPrefs(guildId, userId) {
    return this.getPrefsStmt.get(guildId, userId) ?? null;
  }

  /** Fusionne les champs fournis ({ name, limit, locked }) avec les préférences existantes. */
  savePrefs(guildId, userId, patch = {}) {
    const cur = this.getPrefs(guildId, userId) ?? {};
    const name = patch.name !== undefined ? patch.name : cur.name ?? null;
    const limit = patch.limit !== undefined ? patch.limit : cur.user_limit ?? null;
    const locked = patch.locked !== undefined ? (patch.locked ? 1 : 0) : cur.locked ?? 0;
    this.putPrefsStmt.run(guildId, userId, name, limit, locked, Date.now());
  }

  deletePrefs(guildId, userId) {
    return this.deletePrefsStmt.run(guildId, userId).changes > 0;
  }

  countPrefs(guildId) {
    return this.countPrefsStmt.get(guildId).n;
  }
}

module.exports = { TempVoiceRepository };
