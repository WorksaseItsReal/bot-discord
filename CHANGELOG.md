# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/).
Ce projet suit un versionnage sémantique.

## [0.7.0] — Non publié — Sécurité type CrowBot, revue n° 6 et n° 7

> Après la mise à jour : relancez `npm run deploy` (nouvelles commandes `/secur`, `/permissions`, sous-commandes
> ajoutées ; `/bot` part sur `OWNER_GUILD_ID`), puis donnez au rôle du bot **Gérer les webhooks** et
> **Mentionner @everyone** (ou réinvitez-le avec le lien de `/invite`). Secur est entièrement coupé par défaut.

### Added
- **Secur, anti-nuke à modules** (`/secur`, Administrateur ; migration #28). 20 modules, tous coupés par défaut :
  - salons : création, suppression, modification (permissions et surcharges comprises), suppression de fils, webhooks ;
  - rôles : création, suppression, modification, rôles sensibles attribués, rôles retirés en masse ;
  - serveur : paramètres du serveur (images comprises, au mieux), emojis et autocollants ;
  - membres : bannissements, débannissements, expulsions (prune compris), ajout de bots (l'inviteur est jugé),
    déconnexions vocales, exclusions temporaires ;
  - messages : mentions @everyone, purges de messages (20 messages au moins).
- **Moteur de Secur** : chaque entrée du journal d'audit est comptée sur une fenêtre glissante calculée sur son
  horodatage (un rejeu tardif ne déclenche rien) ; un incident = une sanction et une carte ; sanction au choix
  (aucune, retrait des rôles, expulsion, bannissement), avec repli sur le retrait des rôles si l'expulsion ou le bannissement échoue ;
  annulation par une file à priorités (500 tâches par serveur) protégée par un disjoncteur par objet ; salons et
  rôles supprimés recréés depuis des instantanés (catégorie, permissions, membres, configuration et base rebranchées) ;
  boutons « Rendre les rôles », « Débannir » et « Expulser ce bot » sur la carte d'incident.
- **Préréglages et panneau** : `/secur on|max|off` (exposition affichée d'abord, « Appliquer » bloqué tant qu'un bot
  aux permissions dangereuses n'est pas exempté), `/secur module`, `/secur statut` et `/secur panneau` (modules,
  owners et bots de confiance, accès et alertes, exposition, simulation, journal des incidents, accès en attente).
- **Hiérarchie de sécurité** : propriétaire › owners de sécurité (`/secur owner ajouter|retirer|liste`, nommés par
  le propriétaire seul, 25 au plus) › bots de confiance (`/secur confiance ajouter|retirer|liste`, 25 au plus) ›
  whitelist. Verrou (réserve `/whitelist add|remove` et les réglages de `/antiraid` aux owners), raid ping (aussi sur
  l'alerte de vague d'arrivées de l'AntiRaid), MP plafonnés au propriétaire et aux owners, politique « bot auteur ».
  Un rôle whitelisté donné par un non-owner reste **en attente** jusqu'à la décision d'un owner (carte Approuver /
  Révoquer).
- **Liste noire et blrank** (migration #30) : `/secur blacklist ajouter|retirer|liste|info` (banni même absent, rebanni
  après tout débannissement, à son retour et au contrôle toutes les 6 h ; `/unban`, `/softban`, le bouton « Débannir »
  et la fin d'un tempban refusés pour lui) et `/secur blrank ajouter|retirer|liste` (plus aucun rôle reçu).
- **Riposte native de Discord** : `/lockdown suspendre|reprendre|riposte` et `/lockdown status` étendu (invitations
  et/ou MP entre membres suspendus par les mesures d'incident de Discord, 24 h au plus, aussi en riposte automatique
  à une vague d'arrivées).
- **Audit de sécurité** : `/diagnostics` › « 🛡️ Audit de sécurité » (administrateurs), 14 contrôles notés de A à E,
  corrections en un clic confirmées et journalisées ; groupe « Secur » (permissions requises par les modules actifs).
- **Niveaux de permissions** `/permissions panneau|commande|niveau|verifier` (Administrateur) : rôles des niveaux 1 à 3,
  rangs propriétaire › owners › niveaux (un administrateur vaut le niveau 3) ; délégation limitée à `/embed`, `/clear`,
  `/slowmode` et `/pseudo`, journalisée ; mode strict qui restreint les autres commandes attribuées ; cibles
  protégées par rang ; lecture des surcharges « Intégrations ».
- **Outils d'administration** : `/channel renouveler` (recrée un salon vide à l'identique, données du bot reportées,
  confirmation `RENOUVELER`, retour arrière complet si la suppression échoue), `/voice rassembler` (100 membres au plus,
  bouton « Renvoyer chacun » pendant 10 min), `/membres liste:admins|moderateurs|bots|boosters|vocal|role`.
- **Identité et parole du bot** (migration #29) : `/embed texte` (faire parler le bot : mentions explicites,
  `notifier_tous` avec la permission native, AutoMod, 10 envois par minute et par serveur, log), `/settings theme`
  (couleur des cartes du serveur, couleurs de sens intactes), `/settings profil` (pseudo, avatar, bannière et bio du
  bot sur ce serveur), console `/bot` des propriétaires (nom, avatar, bannière, activité imposée, statut, rotation,
  serveurs, quitter un serveur, infos).
- **Communauté** : réactions automatiques par salon (`/communaute` › Réactions automatiques), ghostping d'arrivée
  (`/bienvenue` › Ghostping), rôle soutien (`/automatisations` › Rôle soutien : tag du serveur, ou statut personnalisé
  avec `PRESENCE_INTENT=on`).
- **Logs** : 11 événements (51 au total) — `/embed texte`, salons renouvelés, incidents, réglages et accès en attente
  de Secur, liste noire, mesures d'incident, permissions déléguées modifiées et utilisées, profil du bot, corrections
  de l'audit.
- Migrations #26 (index des clés étrangères et de `guild_id`, placée avant la #27 livrée en 0.6.0),
  #28 (`security_incidents`, `security_grants`), #29 (`bot_settings`, globale), #30 (`security_blacklist`).

### Changed
- **Pré-blocage des destructions via le bot** : `/ban`, `/kick`, `/unban`, `/role`, `/massrole`, `/derank`,
  `/backup restore`, la suppression des salons de `/logs` et de `/compteurs`, l'expulsion groupée de `/activite`,
  `/channel` (creer, supprimer, cloner, renommer, sujet, nsfw, renouveler), `/emoji supprimer`, `/voice cleanup|kick|disconnect`,
  `/clear` (lots d'au moins 20 messages par défaut), `/annonce` et `/embed texte` avec @everyone, `/unhide` et `/unlock` (refus
  d'@everyone que le bot n'a pas posé) sont vérifiés par Secur et l'AntiRaid **avant** l'appel à Discord : une
  opération qui atteindrait le seuil est refusée d'emblée au lieu de sanctionner son auteur au milieu. Trois
  tentatives refusées en 10 min valent un incident.
- **Alertes de sécurité hors filtres** : les alertes AntiRaid et Secur arrivent dans le salon d'alerte ou les logs
  Sécurité même si `/logs` ou la catégorie est en pause ; repli en MP au propriétaire, puis dans le salon système.
- Un module Secur actif prend le relais du seuil AntiRaid correspondant (salons, rôles, bannissements, expulsions,
  anti-bot) ; les seuils Bannissements et Expulsions de `/antiraid` deviennent la limite héritée des modules Secur.
- **`/bot` est une commande de serveur** : enregistrée uniquement sur `OWNER_GUILD_ID`, jamais globale ;
  `npm run deploy` vérifie que le bot est sur ce serveur avant le premier envoi (`--skip-owner` pour ne déployer
  que les commandes globales) ; `/help` ne la montre qu'aux propriétaires.
- **Nouvelles variables d'environnement** : `OWNER_GUILD_ID`, `CDN_NETWORK`, `PRESENCE_INTENT`, `SECUR_TRUST_BOT_OWNERS`.
  Intent privilégié `GuildPresences` demandé seulement avec `PRESENCE_INTENT=on`.
- `/invite` et `/diagnostics` : **Gérer les webhooks** et **Mentionner @everyone** ajoutées (28 permissions).
- Un rôle de la whitelist ou d'un niveau est refusé par les menus de rôles, la boutique, les récompenses de niveau,
  les candidatures et les attributions automatiques, même s'il y était déjà configuré.
- `/slowmode` contrôle « Gérer les salons » sur le salon visé ; supprimer les salons de `/logs` ou de `/compteurs`
  exige « Gérer les salons » natif, sur le serveur et dans chaque salon.
- Couper les logs, mettre en pause la catégorie Sécurité ou changer son salon, et tout changement de `/antiraid`
  ou de `/whitelist`, sont inscrits au journal de sécurité (critiques : alerte et MP).
- `/compteurs` indique « présences non mises en cache » quand `PRESENCE_INTENT` est actif.

### Security
- Un niveau de `/permissions` ne permet jamais une commande qui protège une action sensible (sanction, rôles,
  administration, webhooks, mention de masse) sans la permission Discord qu'elle déclare ; le mode strict s'applique
  à l'action elle-même (boutons, escalade de `/warn`, expulsion de `/activite`, menus contextuels « Sanctions du
  membre » et « Note de modération ») ; couper le mode strict exige le rang du palier le plus exigeant attribué.
- Une commande déléguée exercée par un bouton, un menu ou un formulaire est journalisée (« Utilisations de
  permissions déléguées »), avec la mention du composant.
- `/activite`, `/role remove` (et le bouton Retirer) et `/pseudo` respectent les cibles protégées par rang ; un
  pseudo posé par un membre qui n'est pas staff passe par le filtre des pseudos de l'AutoMod.
- Une annonce @everyone que Secur n'autorise plus à l'échéance est désactivée au lieu d'être publiée.
- Relever le seuil Bannissements ou Expulsions de `/antiraid` quand le module Secur correspondant en hérite exige le
  niveau owner (journalisé comme critique).
- Alerte critique, hors filtres et en MP au propriétaire, quand le bot perd « Voir les logs du serveur », « Gérer
  les rôles », « Gérer les salons », « Bannir » ou « Expulser » alors que Secur ou l'AntiRaid protège le serveur.
- `/channel renouveler` refuse avant la confirmation les surcharges qui accordent ou refusent une permission que le
  bot n'a pas, ou « Gérer les permissions » sans bot Administrateur ; Secur ne recopie plus ce droit dans un salon
  recréé sans être Administrateur.
- Blrank : les menus de rôles refusent l'ajout ; le plafond « boucle » (3 retraits en 10 min) ne vise plus qu'un autre bot.
- Téléchargements limités au CDN de Discord (`cdn.discordapp.com`, `media.discordapp.net`, https, revalidés à chaque
  redirection, 8 Mo, signature d'image vérifiée, `CDN_NETWORK=off`) ; aucune chaîne n'est plus confiée à la lecture
  d'image de discord.js (pas de lecture de fichier local).
- `/voice` contrôle les droits de l'auteur dans le salon vocal visé (R94, couvert par un test de régression).

### Fixed (revue n° 6 : 112 correctifs)
- **Cœur et données** (14) : une fermeture définitive de la passerelle (4004, 4011, 4014) arrête le bot en code 1 et
  `/healthz` exige des shards connectées ; un serveur quitté depuis 30 jours est purgé entièrement en une transaction
  (rappels livrés en MP), y compris ceux quittés pendant un arrêt ; AFK et alertes des membres partis hors ligne
  effacés ; sanctions, verrous et rôles temporaires échus pendant une absence levés au retour, levées en échec
  vérifiées, espacées, plafonnées et signalées après 24 h ; tirages de giveaways hors du scheduler ; `/embed`
  acquitte avant de publier ; exception synchrone d'un écouteur isolée ; composants refusés si le bot a quitté le
  serveur ; cooldown non contournable ; arrêt borné pendant une sauvegarde et `.partial` nettoyés.
- **Modération** (15) : lockdown étendu aux conférences et salons média, surcharges de rôle qui autorisent l'écriture
  neutralisées puis rendues, bot sans Administrateur qui garde ses salons ; `/hide` sérialisé et appliqué aux salons
  synchronisés d'une catégorie ; états de verrouillage purgés au départ du bot, statut lu sur Discord ; rôle Muted
  complet (conférences, médias, fils, partage d'écran, demande de parole) et créé une seule fois ; sanction échue non
  levée impossible à supprimer ; escalade de `/warn` sérialisée par membre ; `/derank` et `/massrole remove` closent
  les rôles temporaires ; retirer le rôle Muted via le bot lève le mute ; menus de rôles sans permissions Create*,
  statistiques, rôle de mute ni rôle de vérification.
- **AntiRaid** (10) : comptes récents et bots comptés dans la vague même si leur sanction échoue, échecs signalés,
  alertes d'arrivée regroupées ; alerte critique perdue relayée en MP au propriétaire, sinon dans le salon système ;
  rôles gérés jamais whitelistés ; suppressions via `/channel` et `/role` toujours signalées ; « Rôles retirés »
  honnête quand l'auteur garde des outils de nuke ; réglages et whitelist journalisés ; auteur parti banni par
  identifiant ; bot qui supprime ses propres salons épargné ; état oublié au départ du bot ; plus de lecture d'audit
  pour les bans externes sans log Modération.
- **AutoMod** (14) : mots interdits composés sans gel (7 s → moins de 10 ms) ; liens lus comme le navigateur (`?@`,
  points idéographiques, `%2e`, adresses IP, hôtes et invitations encodés) ; normalisation étendue (« ᴀ », caractères
  de format, homoglyphes arméniens et grecs) ; messages d'applications installées par le membre et sondages
  analysés ; listes blanches plafonnées à 500 ; quarantaine levée sans rendre les rôles échus ; AutoMod natif sans
  doublons et retiré quand l'AutoMod est coupé ; doubles clics sans effet sur « Bannir », « Lever la quarantaine »
  et « Faux positif ».
- **Logs** (11) : `/logs` exige « Gérer les salons » et « Gérer les rôles » pour créer, réparer ou choisir le rôle
  staff (rôle contrôlé), suppression réservée aux administrateurs et signalée à l'AntiRaid ; contenu des salons
  privés masqué dans un salon de logs plus lu ; jamais de logs dans un salon d'annonces ; purge journalisée sans
  transcription si « Joindre des fichiers » manque ; l'ancien rôle staff perd l'accès ; file d'envoi par salon,
  sécurité prioritaire ; message supprimé par l'AutoMod journalisé si les logs AutoMod sont en pause ; spoilers
  jamais coupés ; « Réparer » honnête ; sujet des salons réécrit seulement s'il change.
- **Tickets, ModMail, candidatures** (14) : salon jamais supprimé sans archive, salon de transcripts public refusé ;
  ModMail : nouvelle conversation si le salon devient inaccessible, choix du serveur, messages transférés et toutes
  les pièces jointes relayés ; un transcript à la fois (15 s par membre) ; tickets fantômes réconciliés ; prise en
  charge refusée pendant la fermeture et sur son propre ticket ; candidatures traitées selon les permissions du
  serveur, entretien clos par l'équipe ; publication refusée dans un salon où l'auteur ne peut pas écrire ;
  double clic sur « Publier » sans doublon.
- **Communauté** (18) : starboard limité aux salons que voient tous les lecteurs du starboard ; rappels jamais publiés
  là où l'auteur ne peut pas écrire, ni après son départ ; `/suggestion`, `/reminder`, `/sondage` et `/projet` passent
  l'AutoMod ; « Mentionner @everyone » vérifié dans le salon des annonces ; vérification en mode retrait : arrivées
  hors ligne verrouillées, « Me vérifier » ne lève plus un derank, un mute, un timeout ni une quarantaine ;
  récompenses de niveau limitées à la hiérarchie de l'admin, rendues au retour, jamais sensibles ; pseudos jamais en
  lien masqué ; codes d'invitation privés ; tirage des giveaways en O(n), reroll anti-double clic, `/giveaway create`
  acquitté avant publication ; alertes des fils privés bornées ; ping du staff des signalements plafonné ; liens
  masqués neutralisés dans les extraits d'alertes.
- **Serveur** (16) : `/backup restore` associe par identifiant, signale les homonymes et relit les membres hors cache ;
  rôle temporaire prolongé pendant son expiration conservé ; `/activite` compte les salons ignorés des logs ; rôle
  vocal ou de boost devenu sensible retiré ; « Tout effacer » des statistiques par lots ; `/emoji renommer` acquitté,
  `/emoji info` discret sur les autres serveurs ; `/statistiques` publique sans fils privés ; `/serverinfo` masque
  les catégories privées ; une erreur passagère n'oublie plus un vocal temporaire ni une fiche de projet ; achat
  refusé si le prix a changé ; `/automatisations` exige les droits de l'auteur dans les salons ajoutés ; flux
  dédupliqués par lien ; verrous de `/jeu` propres à chaque serveur.

### Fixed (revue n° 7)
- **Secur et AntiRaid, moteur** : vague d'arrivées comptée sur l'heure d'arrivée fixée par Discord (un rejeu après
  reconnexion n'est plus un raid) ; salons supprimés par leur créateur exemptés même après un redémarrage ; rôles
  gérés supprimés (bot expulsé) et bots de confiance jamais sanctionnés ; un derank qui laisse un outil de nuke via
  une surcharge passe à l'expulsion ; refus à fenêtre vide sans escalade ; un incident « alerte seule » n'est plus
  contagieux, les actions restées sous le seuil sont reprises quand l'auteur est sanctionné ; un accès de whitelist
  en attente ne s'active plus jamais tout seul ; le disjoncteur suspend un objet, plus le module entier ; une
  expulsion impossible se replie sur le retrait des rôles ; les actions faites via le bot sont annulables ; file
  pleine : la tâche la moins prioritaire est évincée ; « Débannir » refuse un blacklisté ; membres partiels relus.
- **Secur, modules** : restauration `/backup` pendant la file d'annulation sans doublons ; transfert de propriété
  ignoré ; mémoire des déconnexions vocales propre à chaque serveur, déplacements plus comptés ; disjoncteur fondé
  sur l'identifiant d'origine (homonymes) ; modifications successives annulées en bits sur l'état relu, champs
  rendus à leur valeur d'origine ; rôle recréé jamais rendu à l'auteur sanctionné ; « rôles retirés » ignoré sur
  la cible d'un incident ouvert ; références en base d'un rôle recréé reportées (rôles temporaires, anniversaires,
  boutique, giveaways…) ; mémoires portées à 30 min ; salon recréé dans sa catégorie.
- **Liste noire et riposte** : le blrank ne retire plus le rôle Muted ni le rôle « non vérifié » ; un membre hors
  cache après un redémarrage perd aussi le rôle ajouté ; une série de ripostes automatiques n'est jamais renouvelée
  au-delà de 24 h.
- **Divers** : le formulaire `/embed create` fonctionne en délégation ; `/channel renouveler` et la restauration
  Secur reportent les salons bloqués des alertes de mots-clés et les règles AutoMod natives de Discord (salon exempté,
  salon d'alerte) ; restreindre une commande de configuration (`/automod`) ne bloque plus les boutons de modération
  qui ne dépendent pas de sa permission ; rôle soutien relu sur la liste complète des membres (cache froid) ;
  présence imposée par `/bot` réappliquée après une reconnexion complète à la passerelle.

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
- **Automatisations** : `/flux` (flux RSS / Atom / YouTube : première lecture sans historique, déduplication, ETag, désactivation
  après 10 erreurs, requêtes sortantes sans adresse privée même après redirection, `FEEDS_NETWORK=off`) et tableau de bord
  `/automatisations` (publication automatique des salons d'annonces avec file d'attente, fils automatiques, rôle vocal,
  remerciement des boosters) ; présence du bot réglable (`PRESENCE_STATUSES`, `PRESENCE_INTERVAL_MINUTES`).
- Migrations #13 (signalements), #14 (invitations), #15 (starboard, sticky), #16 (rôles temporaires, annonces, anniversaires),
  #17 (départs des niveaux), #18 (économie), #19 (statistiques), #20 (outils des membres), #21 (strikes datés, levées automatiques),
  #22 (flux RSS, compteurs des fils automatiques), #23 (candidatures, notes des tickets, conditions de giveaway), #24 (scores des mini-jeux), #25 (réessais des rôles temporaires, garde des anniversaires),
  #27 (battement de la collecte des statistiques).

### Changed
- **`/channel` et `/emoji` passent en sous-commandes** : l'affichage devient `/channel info` et `/emoji info` (relancer `npm run deploy`).
- 41 descriptions d'options clarifiées ; raccourcis (boutons du projet après modification, « Prochains anniversaires »,
  « Classement » des invitations, « Ouvrir l'AntiRaid » depuis `/whitelist`) ; `/help` présente les menus contextuels et la catégorie Économie.
- Intents `GuildInvites` (suivi des invitations) et `GuildMessageReactions` (starboard) ajoutés.
- Économie : pile ou face et machine à sous désactivés par défaut, même une fois l'économie activée.
- `/invite` et `/diagnostics` : Gérer les expressions, Créer des fils publics et Créer des fils privés ajoutées (26 permissions).

### Security
- La permission déclarée par chaque commande est revérifiée par le bot : un rôle autorisé dans Paramètres du serveur › Intégrations
  ne permet plus de bannir, expulser ou rendre muet sans la permission Discord correspondante (28 commandes concernées).
- Option texte `__proto__`, `constructor`… : ne corrompt plus les caches de discord.js (interactionGuard).
- Signalements : « Supprimer » exige « Gérer les messages » dans le salon du message signalé, plus dans celui de la carte.
- Annonces : permission de mention de l'auteur revérifiée à chaque envoi programmé.
- Starboard : jamais de repost d'un salon ou d'un fil privé dans un starboard public ; images spoiler jamais affichées en clair.
- **Flux RSS** : adresse validée au moment même de la connexion (plus de DNS rebinding vers le réseau interne), ports 80/443/8080/8443,
  décompression plafonnée à 1 Mo, analyse linéaire ; mention revérifiée à chaque publication ; l'auteur doit avoir accès au salon.
- Rôles attribués automatiquement (boutique, menus de rôles, niveaux, candidatures, rôle vocal…) refusés s'ils ont une permission
  sensible dans une surcharge de salon. `/snipe` et les alertes respectent les fils privés. `/statistiques` ne montre plus
  l'activité des salons privés aux membres. `/channel cloner` contrôlé comme `creer`. Raison d'absence soumise aux filtres de liens.
- AntiRaid : `/channel supprimer`, `/role delete` et les expulsions de `/activite` comptent comme des actions destructrices.

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
- **Double clics** : boutons de levée (démute, timeout, débannissement), salon créateur de `/tempvoice`, lockdowns globaux simultanés,
  interrupteurs de `/economie` (une seule ligne de journal).
- **Arrêt du bot** : un seul passage parallèle borné à 6 s, puis déconnexion et fermeture de la base ; budget de temps par étape du scheduler.
- **Divers** : compteurs bornés face aux limites de renommage de Discord ; compteurs et vocaux temporaires exclus des sauvegardes ;
  tickets archivés sans téléchargement à l'arrêt ; texte fait d'espaces refusé proprement dans les embeds ; `/diagnostics` signale
  aussi la catégorie des vocaux temporaires et le rôle gestionnaire des projets supprimés.

### Fixed (revue n° 5)
- **`/afk` et filtre des pseudos** : le préfixe [AFK] n'est plus renommé « Membre XXXX » et le pseudo est rendu au retour.
- **Économie** : machine à sous à espérance exacte quelle que soit la mise (« Presque remboursé »), remboursement exact d'un rôle
  non attribué, gain au-delà du plafond jamais négatif, taxe arrondie au supérieur. **Jeux** : parties et snipe arrêtés à la
  suppression d'un fil ; classement non gonflable (abandon immédiat, nul contre le bot, quiz en solo).
- **Modération** : softban relu avant le ban (ne lève plus un ban posé pendant la confirmation) ; `/lockdown enable duree` et
  `/lock duree` refusés sur un verrou sans échéance (un lockdown de l'AntiRaid n'est plus levé à l'échéance) ; levées
  automatiques sérialisées avec `/lock` ; `/channel sujet|nsfw` acquittés avant l'appel.
- **Statistiques** : calcul différé, cache de 60 s, délai entre deux clics ; `/activite` bloquée après une coupure de collecte
  de plus de 6 h (migration 27) et limitée à la liste affichée ; sessions vocales fantômes fermées.
- **Candidatures** : un ping par formulaire toutes les 10 min, pas de décision sur sa propre candidature, avertissement si le
  salon de réception est public.
- **Automatisations** : rôle vocal fiable lors de connexions/déconnexions rapides (rattrapage périodique et à la reconnexion),
  un article refusé par Discord n'arrête plus le flux, fils automatiques bornés, file de publication fidèle à la configuration.
- **Alertes** : index développé une fois par mot-clé (10 000 abonnés : 202 ms → 4 ms par message).

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
