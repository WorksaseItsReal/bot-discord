# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
Ce projet suit un versionnage sémantique.

## [0.2.0] — Non publié — Roadmap complète

### Added
- **Modération** : `/mute` `/unmute` (rôle Muted, temporaire), `/tempban`, `/lock` `/unlock`
  `/lockall` `/unlockall`, `/hide` `/unhide`, `/banlist`.
- **Rôles** : `/role` (add/remove/create/delete/list), `/derank`, `/massrole` (par lots),
  `/rolemenu` (menu auto-attribuable persistant).
- **Vocaux** : `/voice` (move/kick/mute/unmute/disconnect/cleanup), `/tempvoice` (join-to-create).
- **AutoMod** (`/automod`) : anti-spam, flood, link, invite, mass-mention, caps, bad words,
  repeat, emoji-spam, duplicate ; salons/rôles ignorés ; sanctions configurables.
- **Sécurité** : `/antiraid` (vagues d'arrivées, âge de compte, anti-bot, actions destructrices
  via audit log), `/whitelist`, `/lockdown`.
- **Community** : `/ticket` (+ panel/boutons), `/modmail`, `/giveaway` (persistant, boutons),
  `/suggestion` (votes), `/reminder` (persistant).
- **Outils** : `/embed` (modal + options), `/custom` + `/tag` (variables), `/backup`
  (create/list/info/delete/restore/auto).
- **Logs** étendus : rôles, salons, vocaux, bans (avec exécuteur via audit log).
- **Infra** : routeur de composants persistants (boutons/menus/modals), migration #2
  (tickets, modmail, giveaways, suggestions, custom commands, role menus, backups,
  lock state, temp voice), scheduler étendu (fin des giveaways, auto-backup, mute temporaire).
- **Tests** : 35 tests (automod, fenêtre glissante, tirage gagnants, couleurs, tags…).

### Notes
- Passage de 19 à 48 slash commands. `better-sqlite3` reste le moteur (fichier unique).
- Backups : structure uniquement (rôles/salons). Discord ne permet pas de restaurer
  messages ni membres — documenté dans la commande.

## [0.1.0] — Non publié

### Added
- Architecture modulaire complète (core, config, database, services, utils, commands, events).
- Configuration centralisée via `.env` (+ `.env.example`) et defaults par serveur.
- Logger multi-niveaux et gestion globale des erreurs (anti-crash) avec `UserError`.
- `GadgetClient` : conteneur d'injection de dépendances, chargement des commandes/événements.
- Base de données SQLite (`better-sqlite3`) avec migrations versionnées et repositories
  (guild config, sanctions, strikes, reminders), isolés par `guildId`.
- Services : ConfigService, ModerationService, StrikeService (escalade), LoggingService,
  SchedulerService (bans temporaires + rappels persistants).
- Helpers UI centralisés : embeds thématisés, composants, pagination, confirmation.
- Commandes :
  - Information : `/help` (interactif + autocomplete), `/botinfo`, `/serverinfo`, `/user`,
    `/roleinfo`, `/channel`, `/avatar`.
  - Configuration : `/settings`, `/diagnostics`, `/health`.
  - Modération : `/ban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/unban`, `/clear`, `/sanctions`.
  - Utilitaires : `/ping`.
- Événements : `ready`, `interactionCreate`, `guildCreate/Delete`, `guildMemberAdd/Remove`,
  `messageDelete/Update` (logs).
- Scripts : `deploy-commands` (dev/global), `migrate`, `healthcheck` (démarrage sans login).
- Tests unitaires (19) : temps, permissions/hiérarchie, config, strikes, sanctions.
- Documentation : README, ARCHITECTURE, ROADMAP, SECURITY, CONTRIBUTING.

### Removed
- Ancien bot mono-fichier « Epic Games » (`index.js`) qui contenait un **token codé en dur**.

### Security
- Suppression du token en dur. Les secrets ne vivent plus que dans `.env` (ignoré par git).
- ⚠️ Le token historique reste présent dans l'historique git et **doit être révoqué**.
