# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
Ce projet suit un versionnage sémantique.

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
