# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
Ce projet suit un versionnage sémantique.

## [0.6.0] — Non publié — Nouvelles fonctionnalités, revue n° 4

### Added
- **Signalements** : menu contextuel « Signaler le message » pour tous (raison facultative, anti-abus), carte du staff
  (Supprimer, Avertir, Timeout 10 min, Classer, Rejeter), tableau de bord `/signalements` ; menus des modérateurs
  « Infos du membre », « Sanctions du membre », « Note de modération ».
- **Invitations et compteurs** : invitation utilisée affichée dans le log d'arrivée, `/invitations voir|classement|reinitialiser|reglages` ;
  `/compteurs` (salons vocaux verrouillés : membres, humains, bots, boosts, salons, rôles).
- **Communauté** : starboard et réponses automatiques (`/communaute`), messages épinglés automatiques (`/sticky definir|retirer|liste`).
- **Planifié** : rôles temporaires (`/role temporaire|temporaires`), annonces programmées avec répétition (`/annonce programmer|liste`),
  anniversaires (`/anniversaire definir|retirer|liste|config`).
- **Candidatures** : `/candidatures` (formulaires, panneau « Postuler », carte du staff Accepter / Refuser / Entretien, une seule décision,
  MP, journal) et `/candidature statut|retirer` ; **notation des tickets** en MP et vue « Statistiques » de `/tickets` (notes, délais, staff) ;
  **conditions de giveaway** `niveau_min`, `invitations_min`, `anciennete_min`.
- **Outils des membres** : `/afk` (préfixe [AFK], réponse aux mentions, retour automatique), `/alertes` (mots-clés en MP, blocages,
  pause automatique), `/snipe supprime|modifie` (10 min en mémoire, AutoMod et bots exclus, consultation journalisée), réglages `/alertes config`.
- **Économie** (désactivée par défaut) : `/eco` et `/economie` — monnaie virtuelle sans valeur réelle, quotidien (série) et hebdo, travail,
  virements taxables avec confirmation, boutique d'objets et de rôles, inventaire, classement, historique, pile ou face et machine à sous
  à espérance négative réglable, tableau de bord journalisé ; soldes écrits en transactions SQLite, jamais négatifs.
- **Mini-jeux `/jeu`** : morpion (IA imbattable), puissance 4, pendu (solo ou salon), quiz (140 questions), devine le nombre,
  défis entre membres, scores et classement.
- **Statistiques** : `/statistiques serveur|membre|reglages` (messages, vocal, arrivées, salons, membres, heures de pointe en UTC, croissance ;
  compteurs uniquement, conservation réglable) et `/activite` (membres inactifs, actions groupées : rôle, MP hebdomadaire, expulsion limitée à 50).
- **Outils d'administration** : `/softban`, `/modstats`, levées automatiques (`/lock duree`, `/slowmode pendant`, `/lockdown enable duree`),
  décroissance des strikes (`/settings moderation decroissance`), filtre AutoMod « Pseudos » (désactivé par défaut), `/role modifier`,
  `/channel creer|supprimer|cloner|renommer|sujet|nsfw`, `/emoji ajouter|supprimer|renommer`.
- **Limites levées** : AntiRaid sur les expulsions massives (seuil « Expulsions », désactivé par défaut), niveaux sans les membres partis
  (XP conservée, purge dans `/niveaux`), `/backup restore` dans l'ordre des rôles et avec permissions sur option, pièces jointes archivées
  avec les transcripts (désactivé par défaut), question anti-robot de `/bienvenue` en toutes lettres.
- **Logs** : 8 nouveaux événements (notes des tickets, signalements, candidatures, `/snipe`, inactifs, levées automatiques, pseudos renommés, économie).
- **Tests de chaos** (`npm run test:chaos`, `CHAOS_SEED`) : valeurs hostiles, double clics, marches aléatoires, bot sans droits ;
  audit UX de bout en bout (chaque sous-commande répond par une embed, en admin comme en membre).
- Migrations #13 (signalements), #14 (invitations), #15 (starboard, sticky), #16 (rôles temporaires, annonces, anniversaires),
  #17 (départs des niveaux), #18 (économie), #19 (statistiques), #20 (outils des membres), #21 (strikes datés, levées automatiques),
  #23 (candidatures, notes des tickets, conditions de giveaway), #24 (scores des mini-jeux), #25 (réessais des rôles temporaires, garde des anniversaires).

### Changed
- **`/channel` et `/emoji` passent en sous-commandes** : l'affichage devient `/channel info` et `/emoji info` (relancer `npm run deploy`).
- 41 descriptions d'options clarifiées ; raccourcis (boutons du projet après modification, « Prochains anniversaires »,
  « Classement » des invitations, « Ouvrir l'AntiRaid » depuis `/whitelist`) ; `/help` présente les menus contextuels et la catégorie Économie.
- Intents `GuildInvites` (suivi des invitations) et `GuildMessageReactions` (starboard) ajoutés.

### Security
- La permission déclarée par chaque commande est revérifiée par le bot : un rôle autorisé dans Paramètres du serveur › Intégrations
  ne permet plus de bannir, expulser ou rendre muet sans la permission Discord correspondante (28 commandes concernées).
- Option texte `__proto__`, `constructor`… : ne corrompt plus les caches de discord.js (interactionGuard).
- Signalements : « Supprimer » exige « Gérer les messages » dans le salon du message signalé, plus dans celui de la carte.
- Annonces : permission de mention de l'auteur revérifiée à chaque envoi programmé.
- Starboard : jamais de repost d'un salon ou d'un fil privé dans un starboard public ; images spoiler jamais affichées en clair.

### Fixed
- **Starboard et sticky** : plus de carte orpheline ni de doublon, plus d'auto-étoile par super-réaction ; sticky sans ping-pong entre bots.
- **Annonces** : « Envoyer maintenant » ne publie plus deux fois. **Rôles temporaires** : un serveur bloqué ne retarde plus les autres,
  `/role remove` clôt le rôle temporaire. **Anniversaires** : pas de fête le jour d'une modification, au plus une par 300 jours,
  rôle d'anniversaire jamais oublié en silence.
- **Signalements** : actions verrouillées par signalement et relues (pas de double avertissement), salon supprimé → repli sur les logs
  Modération et contrôle dans `/diagnostics`, avertissement si le rôle mentionné ne sera pas notifié.
- **Arrivées** : mute et rôles d'arrivée réappliqués sans attendre le suivi des invitations (raids) ; une lecture des invitations par lot.
- **Niveaux et invitations** : départs survenus hors ligne rattrapés au démarrage ; un gain d'XP différé ne remet plus un membre parti au classement.
- **AntiRaid** : le lockdown automatique attend un verrouillage ou une levée en cours ; un échec propose « Réessayer le lockdown ».
- **Double clics** : boutons de levée (démute, timeout, débannissement), salon créateur de `/tempvoice`, lockdowns globaux simultanés.
- **Arrêt du bot** : un seul passage parallèle borné à 6 s, puis déconnexion et fermeture de la base ; budget de temps par étape du scheduler.
- **Divers** : compteurs bornés face aux limites de renommage de Discord ; compteurs et vocaux temporaires exclus des sauvegardes ;
  tickets archivés sans téléchargement à l'arrêt ; texte fait d'espaces refusé proprement dans les embeds ; `/diagnostics` signale
  aussi la catégorie des vocaux temporaires et le rôle gestionnaire des projets supprimés.

## [0.5.2] — Non publié — Revue n° 3 et tests de bout en bout

### Added
- **Tests de bout en bout** (`tests/e2e`, `npm run test:e2e`) : le vrai bot tourne sur le vrai discord.js sans réseau
  (REST simulé et validé contre les limites Discord, passerelle réelle). Les 73 commandes, environ 1 500 clics,
  choix de menus et formulaires, 25 types d'événements, les parcours complets (tickets, giveaways, vérification,
  niveaux, vocaux…) et des invariants d'état (lock/hide/lockdown/mute restaurent exactement l'état de départ).

### Fixed
- `/unban` lève une ligne « ban » restée active alors que Discord ne bannit plus (casier débloqué).
- Tempban échu face à un ban définitif enregistré : reste banni, staff prévenu.
- Rôle Muted posé sur les salons créés après coup (+ rattrapage en arrière-plan).
- Événement d'audit en retard : ne lève plus une sanction posée après l'action manuelle.
- `/settings moderation role_muet` : refuse un rôle à permissions, porté par des membres non muets ou au niveau de l'auteur.
- Accueil après redémarrage : plus de réaccueil ni de re-verrouillage d'un membre vérifié.
- Menus de rôles : un rôle devenu sensible peut toujours être abandonné ; rôles automatiques des bots moins restreints.
- `/lock` posé pendant un lockdown n'est plus levé avec lui ; `/unlock` et `/unhide` ne laissent plus de surcharge vide.
- Tickets, ModMail (accès au salon perdu), `/timestamp` (heure passée → lendemain), délais de réponse (logs après la réponse).

## [0.5.1] — Non publié — Revue complète n° 2

### Security
- Mentions de masse et de rôles bloquées par défaut au niveau du client (les pings du staff sont explicites).
- `/bienvenue` refuse les rôles de modération/administration et les rôles au niveau de l'auteur (rôles automatiques et rôle de vérification).
- `/sanctions remove` réservé à l'auteur ou à « Gérer le serveur », `/sanctions clear` à « Gérer le serveur », confirmés et journalisés.
- Bans faits via le bot surveillés par l'AntiRaid (arrivants récents exemptés) ; retrait des rôles de l'auteur vérifié.
- `/lock`, `/hide` et leurs inverses exigent « Gérer les permissions » ; menus de rôles : plus de permissions interdites.
- Permissions revérifiées dans `/backup`, `/custom`, `/giveaway`, `/modmail` (pas seulement côté Discord).

### Fixed
- **Rôles attribués un par un** : deux modifications successives ne s'annulent plus (mute réappliqué au retour, rôles de vérification, récompenses de niveau).
- **Quarantaine AutoMod** : rôles retirés conservés en base (migration 12), levée partielle signalée ; « Faux positif » ne lève que le timeout posé par l'AutoMod.
- **Anti-arnaques** : moins de faux positifs (marque + extension dans une phrase, services d'invitation, miroirs) ; seuil Strict à 3.
- **Sanctions** : `/tempban` refusé sur un utilisateur déjà banni, le planificateur relit chaque sanction avant de la lever, mutes/timeouts retirés à la main synchronisés, palier d'escalade en colonne dédiée (migration 10), bouton « Annuler » de `/pseudo` réparé, confirmations pour `/derank`, `/massrole`, `/role delete`, `/lockall`.
- **Communauté** : menus de rôles et de motifs remis à zéro, restauration de sauvegarde avec échecs détaillés et verrou, participation aux giveaways idempotente (bouton « Se retirer ») et annonce mémorisée (migration 11), délai entre deux tickets, `/ticket rename` non bloquant, transcripts complets, ModMail plus robuste, 25 rappels actifs maximum.
- **Accueil, niveaux, vocaux** : accueil des membres après un redémarrage, départs des raiders tus, vocaux créés par héritage de la catégorie, actions du panneau sérialisées, bot seul ne garde plus un vocal en vie.
- **Interface** : `/settings moderation` règle enfin raison obligatoire, strikes, paliers et rôle muet ; `/diagnostics` vérifie les rôles et salons référencés ; `/embed` refuse les embeds trop longs ; `/emoji` accepte les keycaps ; « Gérer le serveur » demandé à l'invitation ; `/logs` à interrupteurs idempotents.
- **Cœur** : un bouton lent n'écrase plus une carte d'erreur, ids de migration vérifiés, travail différé vidé à l'arrêt.

### Changed
- `/timestamp` : « 14h30 » est une heure ; une durée s'écrit « +2h ».
- Node.js 22 minimum (Node 20 en fin de vie) ; CI sur Node 22 et 24.

## [0.5.0] — Non publié — Accueil, niveaux, tableaux de bord et exploitation

### Added
- **`/bienvenue`** : messages de bienvenue et de départ personnalisables (variables, couleur, bannière, MP,
  aperçu), rôles automatiques humains/bots avec contrôle de hiérarchie, vérification par bouton
  (question anti-robot, âge minimal du compte, log « Vérifications réussies »), intégrée après l'AntiRaid.
- **Niveaux / XP** : `/rang`, `/classement` paginé et tableau de bord `/niveaux` (XP par message et en vocal,
  annonces, récompenses de rôle, multiplicateurs, exclusions, gestion et import de l'XP), désactivé par défaut.
- **Tableaux de bord `/antiraid`** (remplace enable/disable/status/set ; simulation, préréglages, test
  d'alerte, whitelist) et **`/tickets`** (catégorie, staff, transcripts, motifs, panneau, statistiques) ;
  `/ticket setup|panel` redirigent, la fermeture d'un ticket par bouton demande confirmation.
- **Vocaux temporaires** : panneau de contrôle dans le chat du vocal (verrou, visibilité, nom filtré,
  limite, expulsion, bannissement, autorisation, transfert, réclamation, débit, région), préférences
  mémorisées par propriétaire, tableau de bord `/tempvoice config`.
- **Sanctions** : fiches (`/sanctions voir`), historique paginé et filtrable avec résumé, raisons
  modifiables avec historique et mise à jour du log, notes de modération internes, bouton Lever,
  « Historique de modération » dans `/user`, levées tracées (qui, quand, pourquoi).
  `/sanctions list` devient `/sanctions historique`.
- **AutoMod** : liens masqués trompeurs, bouton « Faux positif » sur les logs (correctifs en un clic,
  renvoi en MP), filtre « Compte piraté » avec quarantaine, exemptions par filtre, sanction « Expulsion ».
- **Exploitation** : CI GitHub Actions (Node 20/22 + image Docker), `Dockerfile` multi-étapes et
  `docker-compose.yml`, `/healthz` et `/metrics` (`HEALTH_PORT`), logs JSON (`LOG_FORMAT=json`),
  sauvegarde SQLite `npm run backup:db` avec rotation et sauvegarde automatique (`DB_BACKUP_INTERVAL_HOURS`).
- `/settings` : raccourcis vers les tableaux de bord AutoMod, AntiRaid, Tickets, Bienvenue et Niveaux.
- Migrations #6 (niveaux), #7 (fiches de sanction, notes), #9 (panneau et préférences des vocaux).

### Changed
- Le propriétaire d'un vocal temporaire n'a plus « Gérer les salons » (renommage uniquement par le panneau, filtré).
- `/unban` marque aussi les bans définitifs comme levés dans l'historique.

### Security
- Le routeur de boutons refuse les noms hérités d'`Object.prototype` (`constructor`, `__proto__`…).

## [0.4.0] — Non publié — Design, boutons et AutoMod v2

### Added
- **Système de design** (`src/utils/ui.js`, `docs/DESIGN.md`) : palette sémantique, icônes uniques,
  cartes homogènes ; toutes les commandes, logs, MP et panneaux migrés. Garde-fous en tests.
- **Boutons d'action persistants** sur les commandes (actualiser, relancer, débannir, annuler,
  sanctions, détails…) et bouton 🗑️ automatique sur les réponses publiques.
- **AutoMod v2** :
  - détection résistante aux contournements (leet, accents, homoglyphes, lettres espacées, invisibles) ;
  - nouveaux filtres : anti-arnaques, spam multi-salons (comptes piratés), pavés, zalgo ;
  - liens sans protocole et invitations masquées détectés, listes blanches ;
  - messages transférés analysés ;
  - sanctions progressives persistantes, protection des nouveaux venus, notification du membre ;
  - **`/automod` devient un tableau de bord interactif unique** (plus de sous-commandes) : navigation par
    menu, réglage de chaque filtre (activation, sanction, durée, seuil, fenêtre), listes par formulaire,
    sanctions progressives, nouveaux venus, notifications, salons/rôles ignorés par sélecteurs natifs,
    préréglages, test d'un message, statistiques, synchronisation avec l'AutoMod natif de Discord.
- **Logs refondus** :
  - **`/logs`**, tableau de bord unique : état de chaque catégorie (salon supprimé, permission manquante,
    pause), salon par sélecteur, événements cochés un par un, pause par catégorie ou globale, logs de test ;
  - **création automatique des salons** : catégorie « 📋 Logs » privée, disposition au choix (un salon par
    catégorie, trois regroupés, un seul), rôle staff en lecture seule, relance sans doublon, suppression ;
  - options : ignorer les bots, ignorer des salons ou des catégories (fils compris) ;
  - 9 catégories et 29 événements : nouveaux logs des rôles et pseudos des membres, boosts,
    suppressions en masse, fils, paramètres du serveur, emojis (intent GuildExpressions) ;
  - jamais de log sur l'activité des salons de logs eux-mêmes ; `/settings logs` remplacé par `/logs`.
- Migrations #4 (décisions de suggestions) et #5 (journal AutoMod, gagnants de giveaways).

### Fixed
- Boutons forgés : un clic n'est accepté que si le bouton existe sur le message ; arguments de
  chemin refusés (détournement de « Débannir » en expulsion) ; identifiants validés.
- Une erreur après la mise à jour d'un bouton n'écrase plus le message public.
- Escalade des strikes soumise aux permissions du modérateur ; lockdown étendu aux fils et forums.
- Logs de bans sans doublon, AntiRaid sans sous-comptage, `/hide` réversible.
- AutoMod : messages modifiés de membres hors cache, fils de salons ignorés, suppression échouée
  signalée, erreurs journalisées.
- Giveaways : édition groupée (rate-limit), relance excluant tous les anciens gagnants.
- Nombreuses requêtes SQL regroupées, latence inconnue gérée, migrations concurrentes sûres.

### Fixed — revue complète du code
- **AutoMod** : liens déguisés `https://discord.com@evil.ru`, homoglyphes et fautes de frappe dans les
  faux domaines (dіscord, stearncommunity, dicsord, steamcommunity.co), sites légitimes épargnés
  (steamgifts…) ; « Bonjour.Ca va » n'est plus un lien, « ok » répété n'est plus un doublon ; séparateurs
  exotiques, emojis à teinte, drapeaux et mots composés détectés ; une seule sanction par rafale, un
  timeout long n'est jamais raccourci, plus de double MP ; boutons du tableau de bord idempotents.
- **Logs** : auteur des rôles/pseudos/kicks/timeouts manuels via le journal d'audit, pas de doublon
  pour les messages supprimés par l'AutoMod, transcript des suppressions en masse ; création des salons
  protégée du double clic, sauvegardée au fur et à mesure, sans écraser les permissions manuelles ;
  bouton Réparer, alerte si un salon de logs est public.
- **Cœur** : module cassé signalé (deploy/healthcheck en échec), plus de double réponse aux
  interactions, erreurs privées après un defer public, jetons de webhook masqués dans les logs, arrêt
  propre, mutes et rappels jamais perdus, configuration corrompue sauvegardée, purge 30 j après départ.
- **Modules** : suppression d'une sanction active refusée, mute réappliqué au retour, vagues AntiRaid
  réellement sanctionnées, backups (quotas, ordre des rôles), giveaways (gagnants éligibles), ModMail
  (transcript), tickets orphelins fermés au démarrage, hiérarchie respectée par `/voice`, `/tempban` confirmé.
- `discord.js` ^14.22.0 requis ; `npm run deploy -- --dry-run` et `--clear-guild`.

## [0.3.0] — Non publié — Fiabilité, projets et nouvelles commandes

### Added
- **Projets** (`/projet`, 19 sous-commandes) : création, fiche en embed (statut coloré, barre de
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
