'use strict';

/**
 * États sauvegardés avant un verrouillage (lock / lockdown) ou un masquage (hide),
 * pour pouvoir restaurer exactement les permissions d'origine.
 *
 * La table `lock_state` a pour clé (guild_id, channel_id). Pour stocker plusieurs
 * « sortes » d'état par salon sans migration, la clé d'une sorte autre que
 * `send` (verrouillage d'écriture, historique) est suffixée : `<channelId>:<kind>`.
 * Les lignes renvoyées exposent toujours le vrai `channel_id` et leur `kind`.
 */
const DEFAULT_KIND = 'send';

function keyOf(channelId, kind = DEFAULT_KIND) {
  return kind === DEFAULT_KIND ? channelId : `${channelId}:${kind}`;
}

function parseRow(row) {
  const [channelId, kind = DEFAULT_KIND] = String(row.channel_id).split(':');
  return { ...row, channel_id: channelId, kind, data: JSON.parse(row.data) };
}

class LockRepository {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.upsertStmt = db.prepare(
      `INSERT INTO lock_state (guild_id, channel_id, data, created_at) VALUES (@guildId, @channelId, @data, @createdAt)
       ON CONFLICT(guild_id, channel_id) DO UPDATE SET data = @data, created_at = @createdAt`,
    );
    this.getStmt = db.prepare('SELECT * FROM lock_state WHERE guild_id = ? AND channel_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM lock_state WHERE guild_id = ? AND channel_id = ?');
    this.deleteChannelStmt = db.prepare("DELETE FROM lock_state WHERE guild_id = ? AND (channel_id = ? OR channel_id LIKE ? || ':%')");
    this.listStmt = db.prepare('SELECT * FROM lock_state WHERE guild_id = ?');
  }

  save(guildId, channelId, data, kind = DEFAULT_KIND) {
    this.upsertStmt.run({ guildId, channelId: keyOf(channelId, kind), data: JSON.stringify(data), createdAt: Date.now() });
  }

  get(guildId, channelId, kind = DEFAULT_KIND) {
    const row = this.getStmt.get(guildId, keyOf(channelId, kind));
    return row ? parseRow(row) : undefined;
  }

  delete(guildId, channelId, kind = DEFAULT_KIND) {
    this.deleteStmt.run(guildId, keyOf(channelId, kind));
  }

  /** Oublie tous les états d'un salon (salon supprimé). */
  deleteChannel(guildId, channelId) {
    this.deleteChannelStmt.run(guildId, channelId, channelId);
  }

  /** États d'une sorte donnée pour un serveur (par défaut : verrouillages d'écriture). */
  list(guildId, kind = DEFAULT_KIND) {
    return this.listStmt.all(guildId).map(parseRow).filter((r) => r.kind === kind);
  }
}

module.exports = { LockRepository };
