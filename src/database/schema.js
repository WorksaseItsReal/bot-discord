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
  {
    id: 2,
    name: 'community_and_tools',
    up: `
      -- Tickets
      CREATE TABLE IF NOT EXISTS tickets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        claimed_by  TEXT,
        status      TEXT NOT NULL DEFAULT 'open',   -- open | claimed | closed
        created_at  INTEGER NOT NULL,
        closed_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_guild_user ON tickets (guild_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_channel ON tickets (channel_id);

      -- ModMail : conversations DM <-> serveur
      CREATE TABLE IF NOT EXISTS modmail_threads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_modmail_user ON modmail_threads (user_id, status);
      CREATE INDEX IF NOT EXISTS idx_modmail_channel ON modmail_threads (channel_id);

      -- Giveaways
      CREATE TABLE IF NOT EXISTS giveaways (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        message_id    TEXT,
        prize         TEXT NOT NULL,
        winners       INTEGER NOT NULL DEFAULT 1,
        host_id       TEXT NOT NULL,
        required_role TEXT,
        forbidden_role TEXT,
        ends_at       INTEGER NOT NULL,
        ended         INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_giveaways_due ON giveaways (ended, ends_at);

      CREATE TABLE IF NOT EXISTS giveaway_entries (
        giveaway_id INTEGER NOT NULL,
        user_id     TEXT NOT NULL,
        PRIMARY KEY (giveaway_id, user_id)
      );

      -- Suggestions
      CREATE TABLE IF NOT EXISTS suggestions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        message_id  TEXT,
        author_id   TEXT NOT NULL,
        content     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_suggestions_guild ON suggestions (guild_id, status);

      CREATE TABLE IF NOT EXISTS suggestion_votes (
        suggestion_id INTEGER NOT NULL,
        user_id       TEXT NOT NULL,
        value         INTEGER NOT NULL,            -- 1 = up, -1 = down
        PRIMARY KEY (suggestion_id, user_id)
      );

      -- Commandes personnalisées
      CREATE TABLE IF NOT EXISTS custom_commands (
        guild_id   TEXT NOT NULL,
        name       TEXT NOT NULL,
        content    TEXT NOT NULL,
        is_embed   INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, name)
      );

      -- Role menus (self-assign)
      CREATE TABLE IF NOT EXISTS role_menus (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        data       TEXT NOT NULL,                  -- JSON: { title, roles: [{roleId,label,emoji,description}] }
        created_at INTEGER NOT NULL
      );

      -- Sauvegardes serveur
      CREATE TABLE IF NOT EXISTS backups (
        id         TEXT PRIMARY KEY,               -- id court généré
        guild_id   TEXT NOT NULL,
        name       TEXT,
        data       TEXT NOT NULL,                  -- JSON
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backups_guild ON backups (guild_id, created_at);

      -- État sauvegardé lors d'un lock/lockdown (pour restauration)
      CREATE TABLE IF NOT EXISTS lock_state (
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        data       TEXT NOT NULL,                  -- JSON des overwrites précédents
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
      );

      -- Salons vocaux temporaires
      CREATE TABLE IF NOT EXISTS temp_voice (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        owner_id   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

module.exports = { migrations };
