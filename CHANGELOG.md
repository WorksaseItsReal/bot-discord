# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
Ce projet suit un versionnage sémantique.

## [0.3.0] — Non publié — Fiabilité, projets et nouvelles commandes

### Added
- **Projets** (`/projet`, 20 sous-commandes) : création, fiche en embed (statut coloré, barre de
  progression, responsable, équipe avec rôles, tâches cochables, échéance avec alerte de retard,
  tags, image, boutons de liens), modification par formulaire, publication dans un salon avec
  mise à jour automatique, liste paginée, statistiques, transfert, configuration par serveur
  (rôle gestionnaire, salon par défaut, création ouverte ou non, limite par membre).
  Migration #3 (`projects`, `project_members`, `project_tasks`).
- **19 nouvelles commandes** : `/projet`, `/sondage`, `/8ball`, `/pileface`, `/de`, `/choisir`,
  `/pfc`, `/calcul` (évaluateur sûr, sans `eval`), `/timestamp`, `/couleur`, `/invite`, `/uptime`,
  `/emoji`, `/banniere`, `/membres`, `/roles`, `/inrole`, `/slowmode`, `/pseudo`.
- **Couche de sûreté des interactions** : plus de double réponse, conversion des options
  dépréciées (`ephemeral`, `fetchReply`), troncature automatique des embeds.
- **Routeur d'interactions** : garde « serveur uniquement », cooldowns, vérification des
  permissions du bot (`botPermissions`), traduction des erreurs Discord, code de référence.
- Écouteurs de santé de la connexion (`error`, `shardDisconnect`, `shardReconnecting`…),
  statut tournant, arrêt propre asynchrone.
- Thème d'embeds unifié avec pied de page de marque ; refonte de `/help`, `/ping`, `/botinfo`,
  `/avatar`, `/user`.
- Tests : 35 → 90 (validation des 67 commandes, couche de sûreté, projets, outils).

### Fixed
- `/rolemenu` et `/roleinfo` plantaient systématiquement.
- `/unlockall` et `/lockdown disable` rendaient écrivables des salons en lecture seule.
- Un ban permanent après un tempban était annulé à l'expiration du tempban ; les tempbans expirés
  pouvaient ne jamais être levés après une panne.
- Kick/ban enregistrés (sanction, MP, log) même quand l'action Discord échouait.
- Giveaways et suggestions modifiables depuis un autre serveur ; giveaways terminés deux fois.
- ModMail : salons en double et MP routés vers le mauvais serveur.
- Ticket supprimé à la main bloquant définitivement l'utilisateur.
- Élévation de privilèges via `/role`, `/rolemenu`, `/massrole`.
- Restauration de backup rendant publics les salons privés.
- AntiRaid : rôles whitelistés ignorés, alertes et lockdowns répétés à chaque arrivée.
- AutoMod : mauvaise fenêtre anti-flood, compteurs jamais réinitialisés, contournement par édition.
- Nombreux dépassements de limites d'embeds et délais de réponse dépassés (`/serverinfo`, `/warn`…).

### Changed
- `setDMPermission` (déprécié) remplacé par les contextes d'interaction, appliqués centralement.
- `/tag` n'autorise plus les mentions de rôles ni @everyone.
- Le menu de rôles ne retire plus les rôles non sélectionnés.

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
