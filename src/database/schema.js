'use strict';

/**
 * Migrations SQL versionnées. Chaque entrée est appliquée une seule fois,
 * dans l'ordre, en s'appuyant sur la table `_migrations`.
 * Ajouter une migration = pousser un nouvel objet { id, up } à la fin.
 */
const migrations = [
  {
    id: 1,
    name: 'initial_schema',
    up: `
      -- Configuration par serveur (JSON stocké en texte)
      CREATE TABLE IF NOT EXISTS guild_config (
        guild_id   TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Historique des sanctions de modération
      CREATE TABLE IF NOT EXISTS sanctions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        type        TEXT NOT NULL,          -- warn | mute | timeout | kick | ban | tempban
        reason      TEXT,
        duration_ms INTEGER,                -- durée demandée (null = permanent)
        expires_at  INTEGER,                -- timestamp d'expiration (null = permanent)
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sanctions_guild_user ON sanctions (guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_sanctions_active_expiry ON sanctions (active, expires_at);

      -- Strikes cumulés par membre (pour l'escalade automatique)
      CREATE TABLE IF NOT EXISTS strikes (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      -- Rappels persistants (survivent au redémarrage)
      CREATE TABLE IF NOT EXISTS reminders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT,
        channel_id  TEXT,
        user_id     TEXT NOT NULL,
        message     TEXT NOT NULL,
        remind_at   INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (remind_at);
    `,
  },
];

module.exports = { migrations };
