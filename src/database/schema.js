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
  {
    id: 11,
    name: 'giveaway_announced_at',
    up: `
      -- Giveaways : date de publication de l'annonce de fin. /giveaway end ne retente
      -- le tirage que si l'annonce n'a jamais été publiée (sinon, tirage à l'infini).
      ALTER TABLE giveaways ADD COLUMN announced_at INTEGER;
      -- Giveaways terminés avant cette migration : annonce réputée publiée s'il y a des
      -- gagnants mémorisés ou aucun participant (seuls les autres restent reprenables).
      UPDATE giveaways SET announced_at = ends_at
        WHERE ended = 1 AND (
          id IN (SELECT giveaway_id FROM giveaway_winners)
          OR id NOT IN (SELECT giveaway_id FROM giveaway_entries)
        );
    `,
  },
  {
    id: 12,
    name: 'automod_quarantines',
    up: `
      -- Quarantaines AutoMod : rôles retirés conservés en base (écrits AVANT le retrait),
      -- relus à la levée même si le log n'a pas pu être envoyé ou a été tronqué.
      CREATE TABLE IF NOT EXISTS automod_quarantines (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        roles         TEXT NOT NULL DEFAULT '[]',   -- JSON string[] des rôles retirés
        timeout_until INTEGER,                      -- fin du timeout posé par la quarantaine
        event_id      INTEGER,                      -- infraction associée (automod_events)
        created_at    INTEGER NOT NULL,
        lifted_at     INTEGER,
        lifted_by     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_automod_quarantines_user ON automod_quarantines (guild_id, user_id);

      -- Fin prévue du timeout posé par l'AutoMod : « Faux positif » ne lève que celui-là.
      ALTER TABLE automod_events ADD COLUMN timeout_until INTEGER;
      -- Purge horaire du journal (DELETE … WHERE created_at < ?) sans parcours complet.
      CREATE INDEX IF NOT EXISTS idx_automod_events_created ON automod_events (created_at);
      -- Menus de rôles retrouvés par message (clic sur un menu).
      CREATE INDEX IF NOT EXISTS idx_role_menus_message ON role_menus (message_id);
    `,
  },
  {
    id: 13,
    name: 'reports',
    up: `
      -- Signalements de messages (menu contextuel « Signaler le message »).
      CREATE TABLE IF NOT EXISTS reports (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id         TEXT NOT NULL,
        reporter_id      TEXT NOT NULL,
        target_id        TEXT NOT NULL,              -- auteur du message signalé
        channel_id       TEXT NOT NULL,
        message_id       TEXT NOT NULL,
        content          TEXT,                       -- copie tronquée du message
        attachments      TEXT NOT NULL DEFAULT '[]', -- JSON string[] : noms des pièces jointes
        reason           TEXT,                       -- raison donnée par le signaleur (facultative)
        status           TEXT NOT NULL DEFAULT 'open', -- open | handled | dismissed
        actions          TEXT NOT NULL DEFAULT '[]', -- JSON [{ type, by, at, note? }] : actions du staff
        handled_by       TEXT,
        handled_at       INTEGER,
        card_channel_id  TEXT,                       -- carte publiée dans le salon du staff
        card_message_id  TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_guild_status ON reports (guild_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_reports_message ON reports (guild_id, message_id);
      -- Au plus UN signalement ouvert par (signaleur, message) : garanti même en cas de double envoi.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_unique ON reports (guild_id, reporter_id, message_id) WHERE status = 'open';
    `,
  },
  {
    id: 14,
    name: 'invite_joins',
    up: `
      -- Suivi des invitations : une ligne par arrivée (un membre qui revient en crée une nouvelle).
      CREATE TABLE IF NOT EXISTS invite_joins (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        inviter_id TEXT,                     -- null : invitation inconnue, lien personnalisé ou OAuth
        code       TEXT,                     -- code utilisé, 'vanity' (lien personnalisé) ou null
        joined_at  INTEGER NOT NULL,
        left_at    INTEGER,                  -- départ du membre (null : toujours là)
        fake       INTEGER NOT NULL DEFAULT 0 -- 1 : compte trop récent à l'arrivée (« fausse » invitation)
      );
      CREATE INDEX IF NOT EXISTS idx_invite_joins_inviter ON invite_joins (guild_id, inviter_id);
      CREATE INDEX IF NOT EXISTS idx_invite_joins_user ON invite_joins (guild_id, user_id);
    `,
  },
  {
    id: 15,
    name: 'community_starboard_sticky',
    up: `
      -- Starboard : un message source ↔ sa carte dans le salon starboard.
      CREATE TABLE IF NOT EXISTS starboard (
        guild_id        TEXT NOT NULL,
        message_id      TEXT NOT NULL,              -- message d'origine
        channel_id      TEXT NOT NULL,              -- salon du message d'origine
        author_id       TEXT,
        star_message_id TEXT,                       -- carte publiée dans le salon starboard
        stars           INTEGER NOT NULL DEFAULT 0, -- dernier compte publié
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (guild_id, message_id)
      );
      -- Suppression d'une carte du starboard : retrouver sa ligne.
      CREATE INDEX IF NOT EXISTS idx_starboard_star_message ON starboard (star_message_id);

      -- Messages épinglés automatiquement (sticky) : un par salon.
      CREATE TABLE IF NOT EXISTS sticky_messages (
        guild_id        TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        title           TEXT,
        content         TEXT NOT NULL,
        threshold       INTEGER NOT NULL DEFAULT 3, -- réaffiché après N messages (ou un délai)
        last_message_id TEXT,                       -- dernier message sticky publié
        author_id       TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sticky_messages_guild ON sticky_messages (guild_id);
    `,
  },
  {
    id: 16,
    name: 'scheduled_features',
    up: `
      -- Rôles temporaires (/role temporaire) : retirés automatiquement à l'échéance par le
      -- scheduler, réappliqués si le membre revient avant. Une seule ligne active par
      -- (serveur, membre, rôle) : une nouvelle attribution remplace l'échéance.
      CREATE TABLE IF NOT EXISTS temp_roles (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id     TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        role_id      TEXT NOT NULL,
        moderator_id TEXT,
        reason       TEXT,
        expires_at   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        ended_at     INTEGER,
        end_reason   TEXT                           -- expired | removed | left | role_deleted | guild_left | failed
      );
      CREATE INDEX IF NOT EXISTS idx_temp_roles_due ON temp_roles (active, expires_at);
      CREATE INDEX IF NOT EXISTS idx_temp_roles_member ON temp_roles (guild_id, user_id, active);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_temp_roles_active ON temp_roles (guild_id, user_id, role_id) WHERE active = 1;

      -- Annonces programmées (/annonce) : brouillon (aperçu) → programmée → terminée ou désactivée.
      CREATE TABLE IF NOT EXISTS scheduled_announcements (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        author_id     TEXT NOT NULL,
        title         TEXT,
        message       TEXT,
        color         INTEGER,
        image         TEXT,
        role_id       TEXT,                         -- rôle mentionné (identifiant du serveur = @everyone)
        repeat        TEXT NOT NULL DEFAULT 'none', -- none | daily | weekly | monthly
        time_zone     TEXT NOT NULL DEFAULT 'Europe/Paris',
        anchor_at     INTEGER NOT NULL,             -- première échéance (base des répétitions)
        next_run      INTEGER NOT NULL,
        runs          INTEGER NOT NULL DEFAULT 0,   -- échéances écoulées depuis anchor_at
        status        TEXT NOT NULL DEFAULT 'draft',-- draft | scheduled | disabled | done
        sent_count    INTEGER NOT NULL DEFAULT 0,
        last_sent_at  INTEGER,
        last_error    TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_announcements_due ON scheduled_announcements (status, next_run);
      CREATE INDEX IF NOT EXISTS idx_scheduled_announcements_guild ON scheduled_announcements (guild_id, status);

      -- Anniversaires (/anniversaire) : l'année n'est affichée qu'avec l'accord du membre.
      CREATE TABLE IF NOT EXISTS birthdays (
        guild_id       TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        day            INTEGER NOT NULL,
        month          INTEGER NOT NULL,
        year           INTEGER,
        show_age       INTEGER NOT NULL DEFAULT 0,
        last_celebrated TEXT,                       -- date locale (AAAA-MM-JJ) de la dernière fête
        role_id        TEXT,                        -- rôle « anniversaire » donné…
        role_until     INTEGER,                     -- …et retiré à cette date
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_birthdays_date ON birthdays (guild_id, month, day);
      CREATE INDEX IF NOT EXISTS idx_birthdays_role ON birthdays (role_until);
    `,
  },
  {
    id: 17,
    name: 'levels_left_at',
    up: `
      -- Niveaux : date de départ du serveur (NULL = membre présent). Les membres partis
      -- sont exclus du classement, du rang et du total ; leur XP est conservée et
      -- compte de nouveau à leur retour (left_at remis à NULL).
      ALTER TABLE levels ADD COLUMN left_at INTEGER;
      -- Purge « membres partis depuis plus de N jours » sans parcours complet.
      CREATE INDEX IF NOT EXISTS idx_levels_left ON levels (guild_id, left_at);
    `,
  },
  {
    id: 24,
    name: 'game_scores',
    up: `
      -- Mini-jeux (/jeu) : bilan par serveur, membre et jeu (morpion, puissance4, pendu,
      -- quiz, devine). Les parties elles-mêmes vivent en mémoire (GameService) ; seuls
      -- les résultats sont conservés, pour /jeu classement.
      CREATE TABLE IF NOT EXISTS game_scores (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        game       TEXT NOT NULL,
        wins       INTEGER NOT NULL DEFAULT 0,
        losses     INTEGER NOT NULL DEFAULT 0,
        draws      INTEGER NOT NULL DEFAULT 0,
        points     INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, game, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_game_scores_board ON game_scores (guild_id, game, points DESC, wins DESC);
      CREATE INDEX IF NOT EXISTS idx_game_scores_user ON game_scores (guild_id, user_id);
    `,
  },
];

module.exports = { migrations };
