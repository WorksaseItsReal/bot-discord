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
  {
    id: 3,
    name: 'projects',
    up: `
      -- Projets du serveur (vitrine + suivi). number = numéro lisible propre au serveur.
      CREATE TABLE IF NOT EXISTS projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        number      INTEGER NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'planifie',
        progress    INTEGER,                       -- null = calculée depuis les tâches
        owner_id    TEXT NOT NULL,
        color       INTEGER,
        image_url   TEXT,
        thumbnail_url TEXT,
        deadline    INTEGER,
        tags        TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
        links       TEXT NOT NULL DEFAULT '[]',    -- JSON {label,url}[]
        channel_id  TEXT,                          -- message publié (mise à jour en direct)
        message_id  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (guild_id, number)
      );
      CREATE INDEX IF NOT EXISTS idx_projects_guild ON projects (guild_id, status);

      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        role       TEXT,
        added_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS project_tasks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        done_by    TEXT,
        done_at    INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks (project_id);
    `,
  },
  {
    id: 4,
    name: 'suggestion_decisions',
    up: `
      -- Décision du staff sur une suggestion (raison + auteur), conservée en base.
      ALTER TABLE suggestions ADD COLUMN decision_reason TEXT;
      ALTER TABLE suggestions ADD COLUMN decided_by TEXT;
      ALTER TABLE suggestions ADD COLUMN decided_at INTEGER;
    `,
  },
  {
    id: 5,
    name: 'automod_events_and_giveaway_winners',
    up: `
      -- Infractions AutoMod : sanctions progressives (persistantes) et statistiques.
      CREATE TABLE IF NOT EXISTS automod_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        filter     TEXT NOT NULL,
        action     TEXT NOT NULL,
        channel_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automod_events_user ON automod_events (guild_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_automod_events_guild ON automod_events (guild_id, created_at);

      -- Gagnants tirés (premier tirage et relances) : une relance exclut tous les anciens gagnants.
      CREATE TABLE IF NOT EXISTS giveaway_winners (
        giveaway_id INTEGER NOT NULL,
        user_id     TEXT NOT NULL,
        drawn_at    INTEGER NOT NULL,
        PRIMARY KEY (giveaway_id, user_id)
      );
    `,
  },
  {
    id: 6,
    name: 'levels',
    up: `
      -- Niveaux / XP : une ligne par membre et par serveur.
      CREATE TABLE IF NOT EXISTS levels (
        guild_id        TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        xp              INTEGER NOT NULL DEFAULT 0,
        level           INTEGER NOT NULL DEFAULT 0,
        messages        INTEGER NOT NULL DEFAULT 0,
        voice_minutes   INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER,
        PRIMARY KEY (guild_id, user_id)
      );
      -- Classement et rang (COUNT des XP supérieures) par serveur.
      CREATE INDEX IF NOT EXISTS idx_levels_guild_xp ON levels (guild_id, xp DESC);
    `,
  },
  {
    id: 7,
    name: 'sanction_cases',
    up: `
      -- Fiches de sanction : qui a levé la sanction, quand et pourquoi ; message de log associé.
      ALTER TABLE sanctions ADD COLUMN revoked_by TEXT;
      ALTER TABLE sanctions ADD COLUMN revoked_at INTEGER;
      ALTER TABLE sanctions ADD COLUMN revoke_reason TEXT;
      ALTER TABLE sanctions ADD COLUMN log_channel_id TEXT;
      ALTER TABLE sanctions ADD COLUMN log_message_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_sanctions_guild_user_type ON sanctions (guild_id, user_id, type, created_at);

      -- Historique des modifications de raison (l'ancienne raison est conservée).
      CREATE TABLE IF NOT EXISTS sanction_edits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sanction_id INTEGER NOT NULL REFERENCES sanctions(id) ON DELETE CASCADE,
        guild_id    TEXT NOT NULL,
        editor_id   TEXT NOT NULL,
        old_reason  TEXT,
        new_reason  TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sanction_edits_sanction ON sanction_edits (guild_id, sanction_id, created_at);

      -- Notes de modération internes (sans effet sur le membre), éventuellement liées à une sanction.
      CREATE TABLE IF NOT EXISTS mod_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        author_id   TEXT NOT NULL,
        sanction_id INTEGER REFERENCES sanctions(id) ON DELETE SET NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mod_notes_user ON mod_notes (guild_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_mod_notes_sanction ON mod_notes (guild_id, sanction_id);
    `,
  },
  {
    id: 9,
    name: 'temp_voice_panel_and_prefs',
    up: `
      -- Vocaux temporaires : message du panneau de contrôle et état (verrouillé / masqué).
      ALTER TABLE temp_voice ADD COLUMN panel_message_id TEXT;
      ALTER TABLE temp_voice ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE temp_voice ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

      -- Préférences mémorisées du propriétaire, réappliquées à ses prochains vocaux.
      CREATE TABLE IF NOT EXISTS temp_voice_prefs (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        name       TEXT,
        user_limit INTEGER,
        locked     INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
    `,
  },
  {
    id: 10,
    name: 'sanctions_escalation_step',
    up: `
      -- Palier d'escalade (nombre de strikes) appliqué par une sanction automatique de /warn.
      -- Remplace la lecture du texte de la raison, qu'un modérateur pouvait imiter.
      ALTER TABLE sanctions ADD COLUMN escalation_step INTEGER;

      -- Reprise de l'historique : seules les sanctions qu'une escalade peut produire
      -- (timeout/mute, kick, ban) sont reprises, jamais un avertissement dont la raison
      -- imiterait le format « Escalade automatique (palier de N strikes) ».
      UPDATE sanctions
         SET escalation_step = CAST(
               CASE WHEN substr(reason, 23) LIKE 'palier de %' THEN substr(reason, 33) ELSE substr(reason, 23) END
             AS INTEGER)
       WHERE type IN ('timeout', 'mute', 'kick', 'ban')
         AND reason LIKE 'Escalade automatique (%'
         AND (substr(reason, 23) GLOB '[0-9]* strikes)*' OR substr(reason, 23) GLOB 'palier de [0-9]* strikes)*');
      UPDATE sanctions SET escalation_step = NULL WHERE escalation_step IS NOT NULL AND escalation_step <= 0;
      CREATE INDEX IF NOT EXISTS idx_sanctions_escalation ON sanctions (guild_id, user_id, escalation_step);
    `,
  },
];

module.exports = { migrations };
