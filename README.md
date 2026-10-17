<div align="center">

# 🕵️ Inspecteur Gadget

**Le bot Discord tout-en-un pour administrer, modérer, sécuriser et animer votre serveur.**

97 slash commands (dont la console `/bot` des propriétaires) · 4 menus contextuels · anti-nuke Secur à 20 modules · plus de 200 actions · multi-serveurs · 100 % en français

![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embarqu%C3%A9-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-1800%2B%20verts-57F287)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

</div>

---

## Sommaire

- [Points forts](#-points-forts)
- [Projets : la vitrine de votre serveur](#-projets--la-vitrine-de-votre-serveur)
- [AutoMod](#-automod)
- [Secur (anti-nuke type CrowBot)](#%EF%B8%8F-secur-anti-nuke-type-crowbot)
- [Niveaux de permissions](#-niveaux-de-permissions)
- [Logs](#-logs)
- [Modération et administration](#-modération-et-administration)
- [Accueil, niveaux et vocaux](#-accueil-niveaux-et-vocaux)
- [Communauté, signalements et automatisations](#-communauté-signalements-et-automatisations)
- [Outils des membres](#-outils-des-membres)
- [Économie et mini-jeux](#-économie-et-mini-jeux)
- [Statistiques et membres inactifs](#-statistiques-et-membres-inactifs)
- [Toutes les commandes](#-toutes-les-commandes)
- [Installation](#-installation)
- [Exploitation : Docker, supervision, sauvegardes](#-exploitation--docker-supervision-sauvegardes)
- [Premiers pas sur un serveur](#-premiers-pas-sur-un-serveur)
- [Fiabilité](#%EF%B8%8F-fiabilité)
- [Architecture](#-architecture)
- [Dépannage](#-dépannage)

---

## ✨ Points forts

| | |
| --- | --- |
| 📁 **Projets** | Fiches de projet en embed avec progression, équipe, tâches et liens, mises à jour en direct. |
| 🔨 **Modération complète** | Ban, tempban, softban, mute, timeout, warn avec strikes (qui peuvent expirer) et escalade, fiches de sanction, notes internes, signalements par clic droit, verrous et mode lent levés automatiquement, statistiques de l'équipe (`/modstats`). |
| 🤖 **AutoMod** | 16 filtres résistants aux contournements, anti-arnaques (liens masqués compris), quarantaine des comptes piratés, contrôle des pseudos, bouton « Faux positif », exemptions par filtre, AutoMod natif Discord. |
| 🛡️ **Secur (anti-nuke)** | 20 modules type CrowBot (salons, rôles, webhooks, bans, bots, @everyone…), préréglages `on` / `max` / `off`, sanction de l'auteur et annulation automatique, owners et bots de confiance, liste noire et blrank, audit de sécurité noté de A à E. Coupé par défaut. |
| 🚨 **AntiRaid** | Tableau de bord `/antiraid` (vagues d'arrivées, comptes récents, suppressions et expulsions en masse, simulation), whitelist, verrouillage d'urgence, suspension des invitations et des MP par les mesures d'incident de Discord. |
| 🔑 **Niveaux de permissions** | `/permissions` : rôles des niveaux 1 à 3, mode strict, délégation limitée et journalisée, sans jamais contourner les permissions Discord des commandes sensibles. |
| 👋 **Accueil** | Bienvenue et départ personnalisés, rôles automatiques, vérification anti-robot par bouton, suivi des invitations. |
| 📈 **Niveaux** | XP par message et en vocal, rôles de récompense, classement, tableau de bord `/niveaux`. |
| 🎫 **Communauté** | Tickets configurables avec `/tickets` (motifs, panneau, notes de satisfaction, statistiques), candidatures, ModMail avec transcript, giveaways à conditions, starboard, annonces programmées, anniversaires, suggestions, menus de rôles, sondages. |
| 🎲 **Animation** | Mini-jeux `/jeu` (morpion, puissance 4, pendu, quiz), économie virtuelle avec boutique (désactivée par défaut), absences `/afk` et alertes de mots-clés. |
| 📊 **Statistiques** | Activité du serveur sans jamais enregistrer le contenu des messages, membres inactifs et actions groupées. |
| 🔊 **Vocaux temporaires** | Panneau de contrôle dans le chat du vocal : verrou, nom, limite, expulsion, transfert, débit, région. |
| 📋 **Logs** | 9 catégories et 51 événements activables un par un, tableau de bord `/logs` et création automatique des salons. |
| 💾 **Backups** | Sauvegarde et restauration de la structure du serveur, permissions comprises. |
| 🎨 **Design soigné** | Chaque réponse est un embed cohérent, avec des boutons utiles et un bouton 🗑️ sur les réponses publiques. |
| 🧠 **Fiable** | Aucune double réponse, actions protégées contre les double clics, permissions revérifiées par le bot, boutons protégés contre la falsification, erreurs expliquées en français, plus de 1 800 tests automatiques dont des tests de bout en bout sur le vrai discord.js, CI GitHub Actions. |

---

## 📁 Projets : la vitrine de votre serveur

La commande `/projet` transforme chaque projet en une fiche claire et vivante :

```
┃ 📁 Projet #3 · Mon Serveur
┃ 🚧 Serveur Minecraft
┃ Un serveur survie avec économie et quêtes personnalisées.
┃
┃ 📊 Progression
┃ ████████░░░░░░  60 % · 3/5 tâches
┃
┃ 📌 Statut         👑 Responsable     ⏰ Échéance
┃ 🚧 En cours       @Alice             31 décembre 2026 (dans 3 mois)
┃
┃ 👥 Équipe (2)     @Bob · Développeur
┃                   @Chloé · Builder
┃ 🏷️ Tags           `minecraft` `java` `survie`
┃ 🧩 Tâches (3/5)   ✅ Installer Paper   ✅ Plugins   ✅ Spawn   ⬜ Quêtes   ⬜ Ouverture
┃
┃ [🔗 Site]  [🔗 GitHub]   [🔄 Actualiser]  [🧩 Tâches]
```

- **Couleur par statut** : 💡 Idée, 🗓️ Planifié, 🚧 En cours, 🧪 En test, ⏸️ En pause, ✅ Terminé, 🛑 Abandonné.
- **Progression automatique** : elle se calcule à partir des tâches cochées. Toutes les tâches cochées font passer le projet à « Terminé ».
- **Publication en direct** : `/projet publier` poste la fiche dans un salon. Elle se met à jour toute seule à chaque modification.
- **Droits par projet** : le responsable et son équipe modifient le projet. Seuls le responsable et les gestionnaires peuvent le supprimer.
- **Garde-fous** : noms uniques, liens `https` uniquement, limites anti-spam par membre et par serveur.

| Sous-commande | Rôle |
| --- | --- |
| `creer` | Crée un projet : nom, description, statut, tags, échéance, lien, image, couleur. |
| `voir` · `liste` · `stats` | Affiche une fiche, la liste paginée filtrable, ou les statistiques du serveur. |
| `modifier` | Ouvre un formulaire pour le nom, la description, les tags, l'image et la couleur. |
| `statut` · `progression` · `echeance` | Met à jour l'avancement. L'échéance accepte `31/12/2026`, `2026-12-31` ou `2w`. |
| `membre-ajouter` · `membre-retirer` | Gère l'équipe, avec un rôle optionnel pour chaque membre. |
| `tache-ajouter` · `tache-cocher` · `tache-supprimer` | Gère la liste de tâches, avec autocomplétion. |
| `lien-ajouter` · `lien-retirer` | Ajoute jusqu'à 5 boutons de liens sur la fiche. |
| `publier` | Publie la fiche dans un salon, avec mise à jour automatique. |
| `transferer` · `supprimer` | Change de responsable, ou supprime le projet après confirmation. |
| `config` | Rôle gestionnaire, salon par défaut, création ouverte ou non, limite par membre. |

## 🤖 AutoMod

Un AutoMod pensé pour les vraies attaques, pas seulement les gros mots.

**Ce qu'il détecte**

| Filtre | Ce qu'il bloque |
| --- | --- |
| 🎣 Anti-arnaques | Faux « Nitro gratuit », faux domaines Discord/Steam (`dlscord-gift.com`, `dіscord.com` en cyrillique, `steamcommunity.co`), liens déguisés (`https://discord.com@evil.ru`), liens masqués (`[discord.com/gift](https://evil.ru)`), punycode, liens raccourcis piégés. |
| 🦠 Compte piraté | Mêmes fichiers ou même message dans plusieurs salons, ou lien d'arnaque très probable : **quarantaine** (timeout, suppression des messages récents partout, retrait facultatif des rôles rendus à la levée) et alerte avec « Lever la quarantaine » / « Bannir ». |
| 🏴‍☠️ Spam multi-salons | Le même message posté dans plusieurs salons en quelques secondes : signe typique d'un **compte piraté**. Toutes les copies sont supprimées. |
| 🚫 Mots interdits | Résiste aux contournements : `c0n`, `cooon`, `c.o.n`, `c o n`, accents, lettres cyrilliques identiques, caractères invisibles. `mot*` bloque aussi les dérivés. Sans faux positif sur « conseil » ou « classe ». |
| 🔗 Liens et ✉️ invitations | Liens avec ou sans `https://`, invitations masquées (`discord . gg / code`), listes blanches de domaines et d'invitations. |
| 💬 Spam, flood, doublons, répétitions | Chaque filtre a sa propre fenêtre et son propre seuil. |
| 📣 Mentions, 🔠 majuscules, 😀 emojis, 📜 pavés, 👾 zalgo | Messages pénibles ou illisibles. |
| ↪️ Messages transférés | Le texte des messages transférés est analysé aussi (contournement courant). |
| 🪪 Pseudos | Désactivé par défaut. Vérifiés à l'arrivée et à chaque changement : symbole en tête pour remonter dans la liste, mot interdit, usurpation (« admin », « discord », « staff »… ou pseudo d'un modérateur imité), pseudo illisible. Le membre est renommé selon un modèle (`Membre {id}`) ; le staff, les bots et les rôles exemptés sont épargnés. Faux positifs possibles (« Staffy », « Discordia ») : exemptez un rôle ou coupez la vérification « Usurpation ». |

**Ce qu'il fait ensuite**

- **Sanctions progressives** : 3 infractions en 30 minutes donnent un timeout de 10 minutes, 5 un timeout d'une heure, 8 une expulsion. Le compteur survit aux redémarrages.
- **Nouveaux venus** : liens, invitations et fichiers bloqués pour les comptes récents ou les membres tout juste arrivés.
- **Prévenir le membre** : message dans le salon supprimé après 8 secondes, ou message privé.
- **Logs détaillés** : règle déclenchée, indices, sanction, boutons « Retirer le timeout », « Sanctions » et **« Faux positif »** (l'infraction sort du compteur, le timeout est levé, le domaine ou le mot est corrigé en un clic, le message peut être renvoyé à son auteur en MP).
- **Rafales** : un compte qui poste 20 fois n'est sanctionné qu'une fois, et un timeout plus long n'est jamais raccourci.

**Un seul tableau de bord : `/automod`**

Tapez `/automod` : un panneau interactif s'ouvre et tout se règle depuis là, avec des boutons, des menus et des formulaires.

| Section | Ce qu'on y fait |
| --- | --- |
| 🏠 Accueil | Vue d'ensemble, activer/désactiver, tester un message, préréglages. |
| 🛡️ 💬 ✍️ Filtres | Choisir un filtre, l'activer, choisir sa sanction (jusqu'à l'expulsion), régler durée, seuil et fenêtre, salons et rôles exemptés **pour ce filtre seulement** (ex. liens autorisés dans #médias). |
| 📋 Listes | Ajouter ou retirer des mots interdits, des domaines et des invitations autorisés. |
| 📈 Sanctions progressives | Activer, régler la fenêtre et les paliers (`3=timeout 10m, 8=kick`). |
| 🐣 Nouveaux venus | Âge du compte, ancienneté, blocage des liens, invitations et fichiers. |
| 🔔 Notifications & exemptions | Prévenir le membre, choisir les salons et rôles ignorés dans de vrais sélecteurs. |
| 🧱 AutoMod de Discord | Synchroniser les règles natives, qui bloquent avant l'envoi même bot hors ligne. |
| 🎚️ Préréglages | Faible, Équilibré ou Strict en un clic, sans toucher à vos listes. |
| 📊 Statistiques | Infractions sur 24 h, 7 ou 30 jours, par filtre et par membre. |

---

## 🛡️ Secur (anti-nuke type CrowBot)

Secur protège le serveur contre le **nuke** : un compte de modérateur volé, un administrateur malveillant ou un bot compromis qui supprime des salons et des rôles, bannit en masse, crée des webhooks de spam ou donne Administrateur à un complice. Secur lit le **journal d'audit**, compte les actions de chaque auteur sur une courte fenêtre, **sanctionne** l'auteur au-delà du seuil, **annule** ce qui peut l'être et publie une carte d'incident.

> ⚠️ **Tous les modules sont coupés par défaut.** Rien ne change sur votre serveur tant que vous n'activez pas Secur. L'AntiRaid historique (`/antiraid`) reste disponible à côté ; un module Secur actif prend le relais du seuil AntiRaid correspondant (salons, rôles, bannissements, expulsions, anti-bot).

**Bien démarrer**

1. **`/diagnostics` › 🛡️ Audit de sécurité** (administrateurs) : 14 contrôles notés de A à E (@everyone et ses surcharges, bots Administrateur, nombre d'administrateurs, rôles mentionnables, vérification, filtre de contenu, 2FA, notifications, alertes de sécurité de Discord, hiérarchie, configuration du bot, whitelist, accès en attente), avec des corrections en un clic, confirmées puis journalisées. Le groupe « Secur » du diagnostic liste les permissions qui manquent au bot pour les modules actifs.
2. Placez le rôle du bot **au-dessus** des rôles d'administration et donnez-lui **Voir les logs du serveur** : sans journal d'audit, Secur est aveugle (une alerte critique part si le bot perd cette permission, ou « Gérer les rôles », « Gérer les salons », « Bannir », « Expulser »).
3. **`/secur owner ajouter`** (propriétaire du serveur) nomme vos owners de sécurité ; **`/secur confiance ajouter`** exempte vos autres bots qui ont des permissions dangereuses.
4. **`/secur on`** : l'exposition (membres et bots aux permissions dangereuses) s'affiche, puis **Appliquer**. **Commencez par « on »** ; passez à `/secur max` seulement quand les owners et les bots de confiance sont en place. Le salon d'alerte se règle dans `/antiraid` › Alertes, le raid ping et les MP dans `/secur panneau` › Accès et alertes.

**Les 20 modules**

| Domaine | Modules | Annulation |
| --- | --- | --- |
| 🗂️ Salons | Création, suppression et modification de salons (permissions comprises), suppression de fils, webhooks | Salon créé supprimé ; salon supprimé **recréé** (nom, type, catégorie, permissions, salons enfants, configuration du bot et message épinglé rebranchés) ; modification rétablie ; webhook créé supprimé (webhooks de suivi d'annonces tolérés en « on »). Fils supprimés : sanction seule. |
| 🎭 Rôles | Création, suppression et modification de rôles, rôles sensibles attribués, rôles retirés en masse | Rôle créé supprimé ; rôle supprimé **recréé** avec ses membres (250 au plus), ses surcharges et ses références (configuration et base) ; modification rétablie ; rôle sensible retiré au complice ; rôles du staff dérangé rendus. |
| 🏠 Serveur | Paramètres du serveur, emojis et autocollants | Nom, vérification, notifications, salons système rétablis ; icône, bannière et emojis ré-uploadés **au mieux** via le CDN de Discord (10 par incident). |
| 👥 Membres | Bannissements, débannissements, expulsions (prune compris), ajout de bots, déconnexions vocales, exclusions temporaires | Victimes débannies (option, jamais un blacklisté) ; cible d'un débannissement rebannie ; bot ajouté expulsé (c'est l'**inviteur** qui est jugé) ; timeout levé s'il est inchangé. Expulsions et déconnexions : sanction seule. Les arrivants de moins de 10 min (raid) ne comptent jamais. |
| 💬 Messages | Mentions @everyone, purges de messages (20 messages au moins) | Message @everyone supprimé (sans sanction par défaut) ; purge : sanction seule. |

Chaque module a un **mode** — ⚫ `off` (ne compte rien), 🟢 `on` (la whitelist et les bots de confiance sont exemptés ; les changements bénins de salons, les modifications de rôles sans permission dangereuse et les webhooks de suivi sont ignorés), 🔴 `max` (seuls les owners et les bots de confiance sont exemptés, tout compte) —, un **seuil** (1 à 100 actions), une **fenêtre** (1 à 3 600 s, 10 s par défaut), une **sanction** et l'**annulation** oui/non : `/secur module` ou `/secur panneau`.

**Préréglages** — ils ne touchent jamais aux sanctions ni aux annulations, et les réappliquer ne change rien.

| Commande | Effet |
| --- | --- |
| `/secur on` | 🟢 Protection standard : tous les modules en « on », seuils par défaut. |
| `/secur max` | 🔴 Protection maximale : tous en « max », seuils resserrés (bannissements 2, expulsions 2, déconnexions 3, rôles retirés 2, emojis 2, timeouts 3, fils 3). |
| `/secur off` | ⚫ Tout couper (l'AntiRaid historique reste actif s'il l'est). |

Tant qu'un bot aux permissions dangereuses n'est pas exempté (ni whitelisté ni de confiance en « on », de confiance en « max »), « Appliquer » est désactivé : on l'ajoute aux bots de confiance en un clic, ou on applique en acceptant le risque. Cela évite une guerre entre deux anti-nuke qui défont mutuellement leurs corrections.

**Punitions** — 🔕 Aucune (alerte seule), 🎭 Retrait des rôles (par défaut), 👢 Expulsion, ⛔ Bannissement. Un incident donne **une seule sanction et une seule carte**, quel que soit le nombre d'actions (il reste ouvert 60 s après la dernière). Si l'expulsion ou le bannissement échoue, Secur retire les rôles ; un retrait de rôles qui laisse une permission dangereuse (rôle que le bot ne peut pas retirer, surcharge de salon) passe à l'expulsion ; un auteur déjà parti est banni par identifiant avec la sanction « bannissement ». Un **bot** auteur est expulsé s'il est arrivé il y a moins de 7 jours (réglage « bot auteur » : récent, toujours ou jamais ; sinon carte avec « Expulser ce bot »).

**Annulation** — une file par serveur défait les actions dans l'ordre rôles › catégories › salons › surcharges › membres (500 tâches au plus ; au-delà, la carte renvoie vers `/backup`). Chaque tâche relit l'état et s'abstient si quelqu'un a modifié l'objet depuis. Une entrée d'audit reçue plus de 60 s après coup est comptée mais jamais annulée. Un **disjoncteur** suspend 5 min les annulations d'un objet annulé 3 fois en 60 s (boucle entre deux bots), sans couper le reste du module. La carte d'incident propose **Rendre les rôles** ou **Débannir** (niveau owner) en cas d'erreur.

**Qui est exempté**

| Niveau | Qui | `on` | `max` | Pouvoirs |
| --- | --- | :---: | :---: | --- |
| 👑 Propriétaire du serveur | Le propriétaire (plus `OWNER_IDS` si `SECUR_TRUST_BOT_OWNERS=on`) | ✅ | ✅ | Nomme les owners, seul à pouvoir couper son propre MP. |
| 🛡️ Owners de sécurité | `/secur owner ajouter\|retirer\|liste` (humains présents, 25 au plus) | ✅ | ✅ | Modifient Secur, approuvent les accès, gèrent la liste noire et le blrank. |
| 🤖 Bots de confiance | `/secur confiance ajouter\|retirer\|liste` (bots présents, 25 au plus) | ✅ | ✅ | Aucun : un bot de confiance compromis n'est plus surveillé. |
| ✅ Whitelist | `/whitelist` (membres ou rôles, jamais un rôle géré) | ✅ | ❌ | Aucun. |
| Membres | Tous les autres | ❌ | ❌ | — |

- La **lecture** de `/secur` est réservée aux administrateurs ; les **modifications** exigent en plus le niveau owner (un owner sans « Administrateur » ne peut pas ouvrir `/secur`).
- **Accès en attente** : un membre ou un rôle de la whitelist ajouté par quelqu'un qui n'est pas owner (`/whitelist`, `/role`, `/massrole`) n'exempte **pas** tant qu'un owner ne l'a pas approuvé ; la carte « Approuver / Révoquer » et un MP préviennent le propriétaire. L'accès ne s'active jamais tout seul.
- **Verrou** (`/secur panneau` › Accès et alertes) : réserve aux owners `/whitelist add|remove` et les réglages de `/antiraid`.
- **Alertes hors filtres** : les cartes de Secur et de l'AntiRaid arrivent dans le salon d'alerte ou les logs Sécurité même si `/logs` est en pause, avec des MP plafonnés au propriétaire et aux owners et un raid ping facultatif (une fois par minute au plus).
- **Pré-blocage des destructions via le bot** : `/ban`, `/kick`, `/unban`, `/role`, `/massrole`, `/derank`, `/backup restore`, `/channel` (gestion et `renouveler`), `/emoji supprimer`, `/voice cleanup|kick|disconnect`, `/clear` (grosses purges), `/annonce` et `/embed texte` avec @everyone, `/unhide` et `/unlock` (refus d'@everyone que le bot n'a pas posé), la suppression des salons de `/logs` et `/compteurs` et l'expulsion groupée de `/activite` sont vérifiés **avant** l'appel à Discord : une opération qui atteindrait le seuil est refusée d'emblée. Trois tentatives refusées en 10 min valent un incident.

**Liste noire et blrank** (niveau owner pour ajouter et retirer)

- **`/secur blacklist ajouter|retirer|liste|info`** : l'utilisateur est banni, même absent, et le reste. Un débannissement (manuel, autre bot) est annulé aussitôt avec un log qui nomme l'auteur ; `/unban`, `/softban`, le bouton « Débannir » et la fin d'un tempban sont refusés pour lui ; il est rebanni à son retour et au contrôle périodique (toutes les 6 h). Le retrait lève le bannissement, sauf avec `debannir:false`. Le propriétaire, les owners, les whitelistés et les bots de confiance ne peuvent pas y être ajoutés.
- **`/secur blrank ajouter|retirer|liste`** : le membre ne peut plus recevoir aucun rôle (arrivée, menus de rôles, boutique, niveaux, à la main) ; ses rôles actuels restent, et le rôle Muted ou « non vérifié » peut toujours lui être posé.

**Riposte native de Discord** — `/lockdown suspendre [invitations] [messages_prives] [duree]` suspend les arrivées par invitation et/ou les MP entre membres grâce aux mesures d'incident de Discord (1 à 24 h, une échéance plus lointaine n'est jamais raccourcie) ; `/lockdown reprendre` les rétablit ; `/lockdown riposte actif:oui` le fait automatiquement à chaque vague d'arrivées de l'AntiRaid (une fois par 10 min, jamais renouvelée au-delà de 24 h) ; `/lockdown status` affiche les échéances. Le bot a besoin de « Gérer le serveur ».

**Ce que Secur ne fait pas (et pourquoi)**

- **Il ne s'active pas tout seul** : mal réglé, un anti-nuke sanctionne vos propres modérateurs ou se bat avec un autre bot de sécurité. D'où les modules coupés par défaut, l'exposition affichée avant chaque préréglage et le conseil de commencer par « on ».
- **Il ne surveille pas** le propriétaire du serveur (Discord ne permet pas de le sanctionner), ni les owners et les bots de confiance (par choix), ni les actions du bot lui-même et les restaurations `/backup`.
- **Il ne dépasse pas les limites de Discord** : rien sur un membre ou un rôle placé au-dessus du sien, et jamais une permission qu'il n'a pas lui-même (un rôle recréé peut donc en avoir moins, la carte le dit).
- **Il ne ressuscite pas les contenus** : un salon recréé est vide (messages et fils perdus, nouvel identifiant) ; tickets, ModMail, vocaux temporaires, compteurs, fils et rôles gérés (bots, intégrations, boosters) ne sont jamais recréés ; expulsions, déconnexions, purges et fils supprimés sont sanctionnés, pas annulés.
- **Il restaure les images au mieux** : le CDN de Discord ne garantit pas l'image d'un objet supprimé ; les autocollants animés Lottie et les icônes de rôle ne sont pas restaurés, les tags de forum modifiés sont seulement signalés, et un rôle recréé ne retrouve que les membres présents dans le cache (250 au plus).
- **Il ne rappelle pas** une notification @everyone déjà partie : il supprime le message.
- **Il ne voit que le journal d'audit** : les suppressions de messages une par une et les déplacements vocaux ne sont pas comptés ; une entrée arrivée plus de 60 s en retard est comptée sans être annulée.
- **Pas de liste noire partagée** entre serveurs.

---

## 🔑 Niveaux de permissions

`/permissions` (Administrateur) range vos rôles en **niveaux 1 à 3**, à la manière de CrowBot, et décide qui peut utiliser quelles commandes.

> **Règle d'or : un palier ne donne jamais une permission Discord qu'on n'a pas.** Une commande qui protège une action sensible (sanctions, rôles, administration du serveur, webhooks, mention de masse) exige toujours la permission Discord qu'elle déclare : un niveau 3 sans « Bannir des membres » ne peut pas bannir. Un niveau peut seulement **restreindre** ces commandes. Seule exception, encadrée : les quatre commandes du palier « courant » (`/embed`, `/clear`, `/slowmode`, `/pseudo`) peuvent être **déléguées** ; le bot agit alors pour le membre, dans un salon qu'il voit, et chaque utilisation (commande, bouton, menu ou formulaire) est journalisée dans Logs › Sécurité.

- **Rangs** : propriétaire (5) › owners de sécurité (4, `/secur owner`) › niveaux 3, 2, 1 › membres. Le niveau d'un membre est le plus haut de ses rôles ; un administrateur vaut le niveau 3. 10 rôles au plus par niveau, nom personnalisable (32 caractères).
- **Paliers figés** :

| Palier | Commandes | Attribué par | Effet |
| --- | --- | --- | --- |
| 🟢 Courant | `/embed`, `/clear`, `/slowmode`, `/pseudo` | Administrateurs | Délégation possible |
| 🟠 Modération | `/warn`, `/timeout`, `/untimeout`, `/mute`, `/unmute`, `/kick`, `/sanctions` | Owners de sécurité et propriétaire | Restriction seulement |
| 🔴 Sanctions lourdes | `/ban`, `/tempban`, `/unban`, `/softban` | Propriétaire | Restriction seulement |
| Autres commandes slash | Toutes, sauf `/permissions`, `/bot` et les menus contextuels | Administrateurs | Restriction seulement |

- **Mode strict** (coupé par défaut, vue « Mode strict » du panneau) : une commande attribuée au niveau N est refusée en dessous de N, même avec la permission Discord ; administrateurs et owners sont exemptés. Il s'applique à l'action elle-même (boutons d'autres commandes, escalade de `/warn`, expulsion de `/activite`, menus « Sanctions du membre » et « Note de modération »). Le couper exige le rang du palier le plus exigeant parmi les commandes attribuées ; changer ou retirer une attribution exige le même rang que l'attribuer.
- **Protections** : un membre ne peut être sanctionné, renommé (`/pseudo`), dérangé (`/derank`, `/role remove`) ou visé par les actions groupées de `/activite` que par un rang égal ou supérieur ; un owner de sécurité, seulement par le propriétaire. Les rôles de niveau et de whitelist ne sont jamais donnés automatiquement (menus de rôles, boutique, récompenses, candidatures, rôle soutien…).
- **Commandes** : `/permissions panneau` (accueil, niveaux, commandes, mode strict avec aperçu, vérifications) ; `/permissions commande nom niveau` (0 retire l'attribution) ; `/permissions niveau numero action role` ; `/permissions verifier membre` (rang, commandes ouvertes ou fermées).
- **Deux clés distinctes** : Discord *affiche* une commande selon **Paramètres du serveur › Intégrations**, que le bot ne peut pas modifier ; le bot *l'autorise* selon le niveau. La vue « Vérifications » signale une commande déléguée que Discord masque aux rôles de son niveau.

---

## 📋 Logs

**Un seul tableau de bord : `/logs`**

| Section | Ce qu'on y fait |
| --- | --- |
| 🏠 Accueil | État de chaque catégorie (🟢 actif, ❌ salon supprimé, 🔒 permission manquante, ⏸️ en pause), pause globale, test, bouton **🛠️ Réparer** (recrée un salon supprimé, rétablit les permissions). |
| 🔨 💬 👥 … Catégories | Choisir le salon, cocher les événements à journaliser, mettre en pause, envoyer un log de test. |
| ⚡ Création automatique | Crée une catégorie **📋 Logs** privée et ses salons : un par catégorie, trois regroupés ou un seul. Le rôle staff choisi peut lire sans écrire. Relancer complète sans dupliquer (même après une erreur en cours de route), sans jamais toucher à vos propres salons ni écraser vos permissions manuelles ; suppression en deux clics. Une alerte s'affiche si un salon de logs choisi à la main est visible par @everyone. |
| ⚙️ Options | Ignorer les messages des bots, ignorer des salons ou des catégories entières (fils compris). |

**Ce qui est journalisé**

| Catégorie | Événements |
| --- | --- |
| 🔨 Modération | Sanctions, levées de sanction, bans, kicks et timeouts faits hors du bot (avec leur auteur), tickets et leurs notes, signalements, candidatures, consultations de `/snipe`, actions groupées sur les inactifs, messages publiés par `/embed texte` |
| 💬 Messages | Suppressions, modifications, suppressions en masse (transcript `.txt` joint) |
| 👥 Membres | Arrivées (avec l'invitation utilisée), départs, rôles ajoutés/retirés et pseudos (avec l'auteur du changement), boosts, vérifications réussies |
| 🎭 Rôles | Créations, suppressions, modifications (permissions comprises) |
| 🗂️ Salons | Salons et fils créés, supprimés, modifiés ; salons renouvelés (`/channel renouveler`) |
| 🔊 Vocal | Connexions, déconnexions, changements de salon |
| 🛡️ Sécurité | Alertes AntiRaid, verrouillages, levées automatiques (verrou, mode lent), incidents et tentatives bloquées de Secur, réglages de sécurité modifiés, accès de whitelist en attente, liste noire, mesures d'incident (invitations, MP), permissions déléguées modifiées et utilisées |
| 🤖 AutoMod | Messages filtrés, pseudos renommés et sanctions automatiques |
| 🏠 Serveur | Paramètres du serveur, emojis ajoutés/supprimés, administration de l'économie (soldes, boutique, réglages), flux RSS, automatisations, profil et thème du bot (`/settings`), corrections de l'audit de sécurité |

> L'auteur des changements de rôles, de pseudos et des actions manuelles provient du journal d'audit :
> donnez au bot la permission **Voir les logs du serveur**.
>
> Les alertes de sécurité (AntiRaid, Secur, réglages critiques) ne sont pas de simples logs : elles arrivent
> même si `/logs` ou la catégorie Sécurité est en pause.

---

## 🔨 Modération et administration

**Sanctions** — `/warn`, `/mute`, `/timeout`, `/kick`, `/ban`, `/tempban` et **`/softban`** (ban puis débannissement immédiat : le membre est expulsé et ses messages des 1 à 7 derniers jours effacés ; la sanction reste dans son casier). Chaque sanction a sa fiche (`/sanctions voir`), un historique filtrable et des notes internes. Les strikes peuvent **expirer** : `/settings moderation decroissance:<jours>` (0 = jamais) ; les plus anciens restent dans l'historique mais ne comptent plus pour les paliers.

**Levées automatiques** — `/lock duree`, `/slowmode pendant` et `/lockdown enable duree` acceptent une durée (`30m`, `2h`, `1d`) : à l'échéance, le salon est déverrouillé, le mode lent d'avant rétabli ou le lockdown levé, même après un redémarrage (log Sécurité).

**`/modstats`** (Exclure temporairement des membres) — activité de l'équipe sur 7, 30 ou 90 jours, ou d'un seul modérateur : sanctions par modérateur et par type, tendance, raisons fréquentes, signalements traités, tickets pris en charge.

**Gestion du serveur depuis Discord** — `/role modifier` (nom, couleur, affichage séparé, mentionnable) ; `/channel creer|supprimer|cloner|renommer|sujet|nsfw` (Gérer les salons ; suppression confirmée, copie sans les messages) ; `/emoji ajouter|supprimer|renommer` (Gérer les expressions, pour vous comme pour le bot ; image de 256 Ko au plus ou lien d'un emoji Discord).

> **Changement d'usage** : l'affichage d'un salon ou d'un emoji passe désormais par **`/channel info`** et **`/emoji info`**. Relancez `npm run deploy` après la mise à jour.

**Renouveler, rassembler, lister**

- **`/channel renouveler [salon]`** (Gérer les salons, jamais délégable) recrée un salon à l'identique mais vide : catégorie, position, permissions, sujet, mode lent, NSFW, réglages vocaux et de forum. Tout ce que le bot y rattache suit le nouveau salon (logs, accueil, flux, annonces, rappels, message épinglé republié, règles AutoMod natives, salons bloqués des alertes, salon système ou AFK…). Un bilan annonce ce qui sera reporté ou perdu, puis il faut recopier `RENOUVELER`. Refusé pour les salons de la communauté (règles, mises à jour, alertes), un ticket ou un ModMail ouvert, un vocal temporaire, un giveaway en cours, un salon verrouillé ou un compteur ; un renouvellement toutes les 30 s par serveur ; si l'original ne peut pas être supprimé, tout est remis comme avant.
- **`/voice rassembler [vers] [depuis] [bots]`** déplace jusqu'à 100 membres des autres vocaux vers un salon (le vôtre par défaut) ; les salons qui vous sont fermés sont ignorés sans révéler leurs occupants, et le bouton **↩️ Renvoyer chacun** ramène chacun chez lui pendant 10 min.
- **`/membres liste:<admins|moderateurs|bots|boosters|vocal|role> [role]`** affiche des listes paginées par 20 ; les administrateurs et modérateurs sont réservés à « Exclure temporairement » ou « Gérer le serveur » (réponse éphémère), la liste « vocal » ne nomme que les salons que vous voyez, et `/membres` sans option affiche toujours le compteur.

**Identité et parole du bot**

- **`/embed texte`** (Gérer les messages) fait parler le bot : 2 000 caractères au plus, dans un salon, un fil ou le chat d'un vocal, en réponse à un message de ce serveur (`repondre_a`) et avec un fichier facultatif. Les rôles ne sont notifiés qu'avec `mentionner_roles`, et @everyone qu'avec `notifier_tous` **et** votre propre permission « Mentionner @everyone » ; liens d'arnaque et contenus bloqués par l'AutoMod refusés ; 5 s entre deux envois, 10 par minute et par serveur ; chaque envoi est journalisé.
- **`/settings theme couleur:`** (Gérer le serveur) change la couleur des cartes du bot sur ce serveur (`#FF0000`, `rgb(255, 0, 0)`, `rouge`… ou `défaut`), sans toucher aux couleurs choisies ni aux couleurs de sens (succès, erreur, avertissement, sanction).
- **`/settings profil`** règle le pseudo, l'avatar, la bannière et la bio du bot **sur ce serveur uniquement** (filtres d'usurpation et de mots interdits, images PNG, JPEG, GIF ou WebP de 8 Mo au plus, une par 10 min ; `reinitialiser` revient au profil global).
- **`/bot`** est la console des propriétaires du bot (`OWNER_IDS`, Administrateur, serveur `OWNER_GUILD_ID` uniquement) : nom, avatar et bannière globaux, activité imposée (joue, regarde, écoute, participe, stream Twitch ou YouTube, statut personnalisé) prioritaire sur la rotation, statut, `rotation`, `serveurs`, `quitter` (confirmation par le nom du serveur), `infos`. Voir [Déployer `/bot`](#console-bot-des-propriétaires).

Voir aussi le filtre [AutoMod « Pseudos »](#-automod), les [signalements](#-communauté-signalements-et-automatisations), `/snipe` ([outils des membres](#-outils-des-membres)) et `/activite` ([membres inactifs](#-statistiques-et-membres-inactifs)).

---

## 👋 Accueil, niveaux et vocaux

**`/bienvenue`** (Gérer le serveur) règle tout l'accueil depuis un tableau de bord :

- **Bienvenue et départ** : salon, titre, texte, couleur, bannière ; variables `{membre}`, `{pseudo}`, `{serveur}`, `{nombre}`, `{compte}` ; mention du membre et copie en MP facultatives ; aperçu et envoi de test.
- **Rôles automatiques** séparés humains / bots (10 chacun), hiérarchie vérifiée, rôles Administrateur refusés.
- **Vérification par bouton** : rôle « vérifié » donné (ou « non vérifié » retiré), question anti-robot écrite en toutes lettres (« Combien font sept plus trois ? », réponse en chiffres ou en lettres), âge minimal du compte, log « Vérifications réussies ». Les rôles automatiques ne sont donnés qu'après vérification.
- L'accueil passe **après l'AntiRaid** (un raider puni ne reçoit rien) et attend l'acceptation de l'écran d'adhésion Discord ; @everyone et @here ne sont jamais mentionnés.

**Niveaux et XP** (désactivés par défaut) — `/niveaux` (Gérer le serveur) :

- 15 à 25 XP par message, une fois par minute et par membre (réglable) ; les bots, messages de moins de 3 caractères et messages supprimés par l'AutoMod ne comptent pas.
- XP vocale optionnelle : par minute passée micro ouvert, à plusieurs, hors salon AFK.
- Annonces de niveau (même salon, salon dédié, MP ou désactivées ; `{membre}`, `{niveau}`), rôles de récompense cumulatifs ou seulement le plus haut, multiplicateurs par rôle, salons et rôles exclus, gestion de l'XP (donner, retirer, définir, importer, réinitialiser).
- Les membres consultent leur carte avec **`/rang [membre]`** et le classement paginé avec **`/classement`**. Les membres qui quittent le serveur sortent du classement sans perdre leur XP (rendue s'ils reviennent) ; `/niveaux` › Gérer l'XP › « Membres partis » purge les départs anciens.

**Vocaux temporaires** — rejoindre le salon créateur crée un vocal personnel (permissions de la catégorie conservées), supprimé quand il est vide. Un **panneau de contrôle** est posté dans son chat : 🔒 verrouiller, 👁️ masquer, ✏️ renommer, 👥 limite, 🚪 expulser, ⛔ bannir du salon, ✅ autoriser, 👑 transférer, 🙋 réclamer, 🎚️ débit, 🌍 région. Seuls le propriétaire et les modérateurs s'en servent ; les noms sont filtrés (mots interdits de l'AutoMod compris). Le nom, la limite et le verrou sont mémorisés pour les prochains vocaux. `/tempvoice config` règle le salon créateur, la catégorie, le nom par défaut (`{pseudo}`, `{username}`, `{n}`) et la limite.

---

## 🧩 Communauté, signalements et automatisations

**Signalements et menus contextuels** — clic droit sur un message → Applications → **Signaler le message** : n'importe quel membre signale un message à l'équipe (raison facultative). Une carte arrive dans le salon du staff (`/signalements`, sinon le salon de logs Modération), avec les boutons **Supprimer**, **Avertir**, **Timeout 10 min**, **Classer**, **Rejeter** (permissions et hiérarchie vérifiées). Anti-abus : un signalement toutes les 30 s, un seul par message, ni soi-même ni un bot ; le signaleur peut être masqué. Les modérateurs ont trois menus sur un membre : **Infos du membre**, **Sanctions du membre**, **Note de modération**.

**Invitations et compteurs** — le bot retrouve l'invitation utilisée par chaque arrivant (classique, lien personnalisé, usage unique, bot ajouté par OAuth2) et l'affiche dans le log d'arrivée. `/invitations voir|classement|reinitialiser|reglages` : invitations réelles, départs, fausses (comptes récents), total net. `/compteurs` crée en un clic une catégorie « 📊 Statistiques » de salons vocaux verrouillés qui affichent membres, humains, bots, boosts, salons et rôles (noms modifiables, `{n}`), mis à jour au plus toutes les 10 min (limite Discord).

**Starboard, réponses automatiques, sticky** — `/communaute` (Gérer le serveur) : un message qui atteint N réactions ⭐ est reposté dans un salon dédié (carte avec auteur, contenu, image, lien, compteur en direct ; l'auteur et les bots ne comptent pas ; NSFW cloisonné) ; jusqu'à 25 **réponses automatiques** (mot entier, contient, commence par, exact — jamais d'expression régulière) avec texte et/ou réaction, salons autorisés/exclus et délai. `/sticky definir|retirer|liste` (Gérer les messages) maintient un message épinglé en bas d'un salon, réaffiché après N messages.

**Réactions automatiques, ghostping et rôle soutien** — dans **`/communaute` › Réactions automatiques** (Gérer le serveur), jusqu'à 10 salons reçoivent 1 à 3 réactions sur chaque nouveau message (emojis Unicode ou du serveur, dans l'ordre ; tous les messages, seulement ceux avec média ou lien, ou seulement ceux sans média ; fils facultatifs ; dans un forum, le message d'ouverture de chaque post) ; bots et messages supprimés par l'AutoMod ignorés, file bornée à 20 messages par salon. **`/bienvenue` › Ghostping** mentionne chaque nouveau membre dans 5 salons au plus puis supprime la mention 1 à 10 s plus tard : après la vérification si elle est active, jamais pour un bot, ni pendant une vague d'arrivées ou un lockdown, sans aucun log. **`/automatisations` › Rôle soutien** donne un rôle dédié aux membres qui affichent le tag du serveur (sans intent privilégié) et le retire quand ils l'enlèvent ; « Resynchroniser » relit tous les membres (une fois par 10 min). Avec `PRESENCE_INTENT=on`, la condition peut être un texte du statut personnalisé.

**Planifié** — `/role temporaire` donne un rôle pour une durée limitée (retiré à l'échéance, rendu si le membre revient avant la fin ; `/role temporaires` pour lister, retirer, prolonger). `/annonce programmer` publie une annonce (titre, message, couleur, image, rôle) à une date (`14h30`, `25/12 18h`, `+2h`), une fois ou chaque jour/semaine/mois ; `/annonce liste` pour envoyer tout de suite ou supprimer. `/anniversaire definir|retirer|liste` et `/anniversaire config` (salon, message, rôle porté 24 h, fuseau, heure) fêtent les anniversaires une fois par jour et par membre, sans jamais afficher l'âge sans accord.

**Candidatures, notes et conditions** — `/candidatures` (Gérer le serveur) : jusqu'à 5 formulaires (1 à 5 questions, réponse courte ou longue), un panneau public « Postuler » et les réponses en carte dans un salon du staff (rôle mentionné facultatif). Le staff (Gérer le serveur ou Gérer les rôles) accepte (rôles donnés et MP), refuse (motif en MP) ou ouvre un entretien (ticket, sinon fil privé dans le salon du panneau) ; une seule décision par candidature, même sur double clic. Une candidature en attente par membre et par formulaire, avec un délai réglable entre deux ; les membres suivent les leurs avec `/candidature statut|retirer`. À la fermeture d'un ticket, son auteur peut le **noter** de 1 à 5 ⭐ en MP (commentaire facultatif, notation désactivable) ; la vue « Statistiques » de `/tickets` affiche la note moyenne, les tickets et notes par membre du staff et les délais moyens de prise en charge et de fermeture. Les **giveaways** acceptent `niveau_min`, `invitations_min` et `anciennete_min` (jours sur le serveur), affichés sur la carte et vérifiés à l'inscription comme au tirage.

**Automatisations et flux RSS** — **`/flux ajouter url salon [role_mention] [filtre_mot]`** (Gérer le serveur) suit un flux RSS / Atom ou une chaîne YouTube (identifiant `UC…` ou lien `youtube.com/channel/UC…` ; les liens `@pseudo` ne sont pas reconnus) dans un salon. Les articles déjà parus ne sont jamais republiés ; les nouveautés sont vérifiées toutes les 10 minutes et publiées en carte (titre, extrait, lien, image), avec un rôle mentionné et un mot-filtre facultatifs (25 flux par serveur). Un flux en erreur 10 fois de suite est désactivé et signalé dans les logs ; `/flux liste` le réactive, `/flux tester` vérifie un lien. Les requêtes sortantes refusent les adresses privées ou locales, même après redirection, et `FEEDS_NETWORK=off` les coupe toutes. **`/automatisations`** (Gérer le serveur) regroupe la **publication automatique** des salons d'annonces (file d'attente dans la limite de Discord de 10 par heure et par salon), les **fils automatiques** sous chaque message (ou seulement ceux avec image / lien, nom `{pseudo}` / `{n}`), un **rôle vocal** porté tant qu'un membre est en vocal (global ou par salon, rattrapé au démarrage) et le **remerciement des boosters** (message `{membre}` `{serveur}` `{boosts}`, rôle facultatif retiré à la fin du boost). La présence du bot se règle avec `PRESENCE_STATUSES` et `PRESENCE_INTERVAL_MINUTES` ; une activité imposée par `/bot` passe avant (la vue Présence l'indique « Source : /bot »).

**Sécurité renforcée** — l'AntiRaid surveille aussi les **expulsions massives** (seuil « Expulsions », désactivé par défaut, 5 en préréglage Strict), faites à la main ou via le bot ; voir aussi [Secur](#%EF%B8%8F-secur-anti-nuke-type-crowbot). `/backup restore` remet les rôles recréés dans l'ordre et peut, sur option, rétablir les permissions des salons existants. `/tickets` peut archiver les **pièces jointes** avec les transcripts (8 Mo par fichier, 24 Mo au total).

---

## 🙋 Outils des membres

Activables un par un pour le serveur avec **`/alertes config`** (Gérer le serveur) ; tous actifs par défaut.

- **`/afk [raison]`** signale une absence : le pseudo reçoit le préfixe « [AFK] » (si la hiérarchie le permet ; rétabli au retour), ceux qui vous mentionnent reçoivent une réponse courte (raison et durée, supprimée après 10 s, au plus une fois par 30 s et par salon) et votre prochain message met fin à l'absence.
- **`/alertes ajouter|retirer|liste|pause`** et **`/alertes bloquer salon|membre`** : jusqu'à 10 mots-clés (3 à 40 caractères, mot entier, majuscules et accents ignorés). Quand un autre membre en écrit un dans un salon que vous pouvez lire, vous recevez un MP (auteur, salon, extrait, lien), au plus une fois toutes les 5 minutes par salon et jamais si vous y avez écrit depuis moins de 5 minutes. Les alertes se mettent en pause d'elles-mêmes si vos MP sont fermés.
- **`/snipe supprime|modifie [salon]`** (Gérer les messages) montre le dernier message supprimé ou modifié d'un salon, gardé 10 minutes en mémoire seulement ; jamais les messages des bots, ceux filtrés par l'AutoMod ni ceux des salons ignorés par les logs. Chaque consultation est journalisée (logs Modération).

---

## 🪙 Économie et mini-jeux

**Économie** (désactivée par défaut) — une monnaie virtuelle propre au serveur, **sans valeur réelle**. Avec **`/eco`**, les membres consultent leur `solde`, réclament une récompense `quotidien` (bonus de série) et `hebdo`, utilisent `travail`, se paient entre eux avec `payer` (taxe facultative, confirmation au-delà d'un seuil), achètent des objets ou des rôles dans la `boutique` (stock facultatif, protection contre le double achat, remboursement si le rôle ne peut pas être donné), consultent `inventaire`, `classement` et `historique`, et jouent à `pile-ou-face` ou à la `machine-a-sous` (mise plafonnée, délai entre deux parties, espérance négative réglable). Les soldes ne deviennent jamais négatifs. Le tableau de bord **`/economie`** (Gérer le serveur) règle la monnaie, les gains, la taxe, les plafonds, les jeux et la boutique (25 articles), permet de donner, retirer, définir ou réinitialiser des soldes et affiche des statistiques ; tout est journalisé (logs Serveur).

> ⚠️ **Jeux d'argent** : pile ou face et machine à sous (espérance négative) sont **désactivés par défaut**, même une fois l'économie activée : on les ouvre un par un dans `/economie` › Jeux. Sur un serveur qui accueille des mineurs, laissez-les fermés.

**Mini-jeux** — **`/jeu morpion|puissance4 [adversaire]`** : défiez un membre (il a 60 s pour accepter) ou le bot (morpion imbattable ; au puissance 4, il gagne quand il peut, bloque vos victoires et vise le centre). **`/jeu pendu [solo|salon]`** (plus de 400 mots, lettres choisies dans des menus, 6 erreurs), **`/jeu quiz [theme] [manches]`** (140 questions en 5 thèmes, 15 s par question, le plus rapide marque) et **`/jeu devine`** (nombre de 1 à 100). Une partie à la fois par joueur (par salon pour le quiz et le pendu en mode salon), arrêtée après 10 min d'inactivité ; scores conservés et **`/jeu classement [jeu]`**.

---

## 📊 Statistiques et membres inactifs

**`/statistiques`** présente l'activité du serveur **sans jamais enregistrer le contenu des messages** (compteurs uniquement ; bots et salons ignorés par les logs exclus) :

- `/statistiques serveur` : messages par jour sur 7, 30 ou 90 jours (courbes en caractères), arrivées, départs, solde et membres actifs ; vues salons et membres les plus actifs (texte et vocal), **heures de pointe** (histogramme sur 24 h) et croissance ;
- `/statistiques membre` : messages par jour, salons favoris et temps de vocal d'un membre ;
- `/statistiques reglages` (Gérer le serveur) : collecte activée ou non, lecture publique ou non, conservation (90 jours par défaut, de 7 à 365).

Lecture réservée à « Gérer le serveur », sauf si les statistiques sont rendues publiques ; chacun peut toujours voir les siennes. Les jours et les heures sont comptés **en UTC**.

**`/activite [jours]`** (Gérer le serveur) liste les membres sans message ni vocal depuis N jours (30 par défaut ; rôles exclus réglables, pour le staff par exemple) et propose des actions groupées, toujours confirmées et journalisées : donner ou retirer un rôle, envoyer un MP (au plus une fois par semaine et par membre), expulser (50 membres au plus, en tapant `EXPULSER`). Ces actions restent bloquées tant que la collecte tourne depuis moins de N jours.

---

## 📚 Toutes les commandes

Tapez `/help` sur Discord pour un menu interactif, ou `/help commande:<nom>` pour le détail d'une commande.
Les commandes marquées 🔒 demandent une permission Discord, par exemple « Bannir des membres » pour `/ban`.

<details>
<summary><b>📊 Informations</b> (14)</summary>

| Commande | Description |
| --- | --- |
| `/help` | Menu d'aide interactif, par catégorie. |
| `/serverinfo` | Informations détaillées du serveur. |
| `/user` | Profil d'un membre : dates, rôles, permissions clés. |
| `/roleinfo` · `/roles` · `/inrole` | Détail d'un rôle, liste des rôles, membres ayant un rôle. |
| `/channel` | `info` : informations d'un salon ; `creer`, `supprimer`, `cloner`, `renommer`, `sujet`, `nsfw`, `renouveler` 🔒 (Gérer les salons, pré-contrôlées par Secur). |
| `/avatar` · `/banniere` | Avatar ou bannière en grand, avec liens de téléchargement. |
| `/emoji` | `info` : emoji en grand, avec son identifiant ; `ajouter`, `supprimer`, `renommer` 🔒 (Gérer les expressions). |
| `/membres` | Compteur de membres ; `liste:` admins, modérateurs (réservées à Exclure temporairement ou Gérer le serveur), bots, boosters, vocal, membres d'un rôle. |
| `/botinfo` | Statistiques et informations techniques du bot. |
| `/invitations` | Qui a invité qui : `voir`, `classement`, `reinitialiser` 🔒, `reglages` 🔒. |
| `/statistiques` | Activité du serveur (`serveur`), d'un membre (`membre`), réglages de la collecte (`reglages` 🔒) ; lecture réservée à Gérer le serveur sauf statistiques publiques. |

</details>

<details>
<summary><b>🔨 Modération</b> (25 + 4 menus contextuels) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/ban` · `/tempban` · `/unban` · `/banlist` | Bannissements définitifs ou temporaires, levée automatique. |
| `/kick` · `/softban` | Expulsion d'un membre ; `/softban` efface aussi ses messages des 1 à 7 derniers jours (ban puis débannissement immédiat). |
| `/warn` | Avertissement avec strikes et sanction automatique au palier atteint. |
| `/mute` · `/unmute` · `/timeout` · `/untimeout` | Rendre muet par rôle ou par exclusion Discord, permanent ou temporaire. |
| `/sanctions` | Fiches et historique des sanctions : `voir`, `historique`, `raison`, `note`, `notes`, `remove` (auteur ou Gérer le serveur), `clear` (Gérer le serveur, confirmé et journalisé). |
| `/clear` | Suppression de messages en masse, filtrable par membre. |
| `/lock` · `/unlock` · `/lockall` · `/unlockall` | Verrouillage d'un salon (durée facultative, levée automatique) ou de tout le serveur, avec restauration exacte. |
| `/hide` · `/unhide` | Masquer ou réafficher un salon. |
| `/slowmode` | Mode lent d'un salon, jusqu'à 6 heures ; `pendant` rétablit automatiquement le délai d'avant. |
| `/pseudo` | Modifier ou réinitialiser le pseudo d'un membre. |
| `/signalements` | Tableau de bord des signalements : salon, rôle, anonymat, statistiques, signalements ouverts. |
| `/snipe` | Dernier message supprimé (`supprime`) ou modifié (`modifie`) d'un salon, gardé 10 minutes ; consultation journalisée. |
| `/modstats` | Activité de l'équipe sur 7, 30 ou 90 jours : sanctions par modérateur et par type, signalements, tickets. |
| `/activite` | Membres inactifs depuis N jours et actions groupées confirmées : rôle, MP, expulsion. |
| Clic droit → Applications | **Signaler le message** (tous) ; **Infos du membre**, **Sanctions du membre**, **Note de modération** (modérateurs). |

</details>

<details>
<summary><b>🤖 AutoMod & 🛡️ Sécurité</b> (6) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/automod` | Tableau de bord interactif : tout l'AutoMod se configure avec des boutons, menus et formulaires. |
| `/antiraid` | Tableau de bord : vagues d'arrivées, comptes récents et bots, suppressions en masse, alertes, whitelist, préréglages, simulation, bouton « Anti-nuke ». |
| `/secur` | Anti-nuke : `panneau`, `statut`, `on`, `max`, `off`, `module` ; `owner ajouter\|retirer\|liste` ; `confiance ajouter\|retirer\|liste` ; `blacklist ajouter\|retirer\|liste\|info` ; `blrank ajouter\|retirer\|liste`. Lecture : Administrateur ; modifications : niveau owner. |
| `/permissions` | Niveaux de permissions : `panneau`, `commande`, `niveau`, `verifier`. |
| `/whitelist` | Membres et rôles de confiance, ignorés par l'AntiRaid et exemptés de Secur en mode « on » (ajout par un non-owner en attente d'approbation). |
| `/lockdown` | `enable` (durée facultative, levée automatique), `disable`, `status` ; `suspendre`, `reprendre`, `riposte` : invitations et MP suspendus par les mesures d'incident de Discord. |

</details>

<details>
<summary><b>🎫 Communauté</b> (16)</summary>

| Commande | Description |
| --- | --- |
| `/tickets` 🔒 | Tableau de bord des tickets : catégorie, staff, transcripts, motifs, panneau, notation, statistiques (notes, délais, staff). |
| `/ticket` | Actions dans un ticket : fermer (avec confirmation), prendre en charge, transcript, ajouter, retirer, renommer. |
| `/bienvenue` 🔒 | Messages de bienvenue et de départ, rôles automatiques, vérification par bouton. |
| `/modmail` | Les membres écrivent au bot en MP, le staff répond depuis un salon privé ; transcript à la fermeture. |
| `/giveaway` 🔒 | Concours avec participation par bouton, fin automatique et nouveau tirage ; conditions facultatives (rôle, `niveau_min`, `invitations_min`, `anciennete_min`). |
| `/suggestion` | Idées de la communauté avec votes 👍/👎, acceptées ou refusées par le staff. |
| `/rolemenu` 🔒 | Menu de rôles que les membres s'attribuent eux-mêmes. |
| `/role` · `/derank` · `/massrole` 🔒 | Gestion des rôles (dont `modifier`, `temporaire` et `temporaires`), retrait complet, attribution en masse. |
| `/communaute` 🔒 | Starboard et réponses automatiques. |
| `/annonce` 🔒 | Annonces programmées : `programmer`, `liste`. |
| `/anniversaire` | `definir`, `retirer`, `liste` ; `config` 🔒 pour le salon, le message, le rôle et l'heure. |
| `/candidatures` 🔒 | Tableau de bord des candidatures : formulaires, panneau « Postuler », salon du staff, rôles donnés. |
| `/candidature` | Pour les membres : `statut` de leurs candidatures, `retirer` une candidature en attente. |
| `/sondage` | Sondage natif Discord, de 2 à 10 réponses, jusqu'à 32 jours. |

</details>

<details>
<summary><b>🔊 Vocaux</b> (2) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/voice` | `move`, `kick`, `disconnect`, `mute`, `unmute`, `cleanup` (vider un salon) et `rassembler` (100 membres au plus, bouton « Renvoyer chacun »). |
| `/tempvoice` | Salons vocaux temporaires avec panneau de contrôle ; `config` ouvre le tableau de bord. |

</details>

<details>
<summary><b>📈 Niveaux</b> (3)</summary>

| Commande | Description |
| --- | --- |
| `/rang` | Carte de niveau : XP, progression, rang, messages, minutes vocales. |
| `/classement` | Classement paginé du serveur. |
| `/niveaux` 🔒 | Tableau de bord : XP, annonces, récompenses, multiplicateurs, exclusions, gestion de l'XP. |

</details>

<details>
<summary><b>🧰 Outils</b> (13)</summary>

| Commande | Description |
| --- | --- |
| `/embed` 🔒 | Embeds personnalisés (`create` par formulaire, `send`) ; `texte` fait parler le bot (mentions explicites, fichier, réponse à un message). |
| `/custom` 🔒 · `/tag` | Commandes personnalisées avec variables. |
| `/reminder` | Rappels personnels, conservés même après un redémarrage. |
| `/sticky` 🔒 | Message épinglé en bas d'un salon : `definir`, `retirer`, `liste`. |
| `/afk` | Signale une absence : préfixe « [AFK] », réponse à ceux qui vous mentionnent, retour au premier message. |
| `/alertes` | Alertes de mots-clés en MP : `ajouter`, `retirer`, `liste`, `pause`, `bloquer salon`, `bloquer membre` ; `config` 🔒 active l'AFK, les alertes et le snipe. |
| `/calcul` | Calculatrice : `(2+3)^2 / sqrt(16)`, fonctions et constantes. |
| `/timestamp` | Dates Discord affichées dans le fuseau horaire de chaque lecteur (`14h30`, `25/12 18h`, ou une durée `+2h`). |
| `/couleur` | Aperçu d'une couleur en HEX, RGB et HSL, ou couleur aléatoire. |
| `/invite` · `/ping` · `/uptime` | Lien d'invitation, latence, disponibilité. |

</details>

<details>
<summary><b>🎲 Fun</b> (6)</summary>

| Commande | Description |
| --- | --- |
| `/8ball` | La boule magique répond à vos questions. |
| `/pileface` | Pile ou face, avec pari optionnel. |
| `/de` | Dés en notation JDR : `d20`, `2d6`, `3d8+2`, avec coups critiques. |
| `/choisir` | Le bot choisit pour vous parmi plusieurs options. |
| `/pfc` | Pierre-feuille-ciseaux contre le bot, avec des boutons. |
| `/jeu` | Mini-jeux : `morpion`, `puissance4`, `pendu`, `quiz`, `devine` et `classement`. |

</details>

<details>
<summary><b>🪙 Économie</b> (2)</summary>

| Commande | Description |
| --- | --- |
| `/eco` | Monnaie virtuelle : `solde`, `quotidien`, `hebdo`, `travail`, `payer`, `boutique`, `inventaire`, `classement`, `historique`, `pile-ou-face`, `machine-a-sous`. |
| `/economie` 🔒 | Tableau de bord : activation, monnaie, gains, taxe, plafonds, jeux, boutique, gestion des soldes, statistiques. |

</details>

<details>
<summary><b>⚙️ Configuration</b> (10) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/logs` | Tableau de bord des logs : salons, événements, création automatique des salons. |
| `/settings` | `view` : vue d'ensemble ; `moderation` règle DM, confirmations, raison obligatoire, strikes, paliers et leur décroissance, rôle muet ; `theme` (couleur des cartes) ; `profil` (pseudo, avatar, bannière, bio du bot sur ce serveur). |
| `/diagnostics` | Analyse la configuration et signale les permissions manquantes ; **Audit de sécurité** noté de A à E avec corrections en un clic (administrateurs). |
| `/backup` | Sauvegarde, restauration (ordre des rôles, permissions sur option) et sauvegarde automatique de la structure du serveur. |
| `/compteurs` | Salons de statistiques (membres, bots, boosts…) mis à jour automatiquement. |
| `/flux` | Flux RSS / Atom / YouTube publiés dans un salon : `ajouter`, `retirer`, `liste`, `tester`. |
| `/automatisations` | Tableau de bord : publication automatique, fils automatiques, rôle vocal, remerciement des boosters. |
| `/health` | État technique du bot : latence, base de données, services. |
| `/projet config` | Réglages du module projets. |
| `/bot` | Console des propriétaires du bot (`OWNER_IDS`), enregistrée seulement sur `OWNER_GUILD_ID` : `nom`, `avatar`, `banniere`, `activite`, `statut`, `rotation`, `serveurs`, `quitter`, `infos`. |

</details>

---

## 🚀 Installation

**Prérequis** : Node.js 22 ou plus récent, et une application Discord créée sur le [Developer Portal](https://discord.com/developers/applications). Aucune base de données à installer : SQLite est embarqué.

```bash
# 1. Installer les dépendances
npm install

# 2. Créer le fichier de configuration, puis le remplir
cp .env.example .env

# 3. Vérifier que tout est bien câblé (sans connexion à Discord)
npm run check

# 4. Enregistrer les slash commands
npm run deploy           # sur le serveur de test DEV_GUILD_ID (instantané), + /bot sur OWNER_GUILD_ID
npm run deploy:global    # sur tous les serveurs (jusqu'à 1 h de propagation), + /bot sur OWNER_GUILD_ID

# 5. Démarrer le bot
npm start                # ou npm run dev pour relancer à chaque modification
```

> ⚠️ Relancez `npm run deploy` après chaque mise à jour qui ajoute ou modifie des commandes (en 0.7.0 : `/secur`,
> `/permissions`, `/bot` et de nouvelles sous-commandes).

### Console `/bot` des propriétaires

`/bot` n'est **jamais** déployée globalement : c'est une commande de serveur, enregistrée uniquement sur `OWNER_GUILD_ID`.

1. Renseignez `OWNER_IDS` (vos identifiants) et `OWNER_GUILD_ID` (votre serveur privé), puis invitez le bot sur ce serveur.
2. Lancez `npm run deploy` (ou `npm run deploy:global`) : le script vérifie d'abord que le bot est bien sur `OWNER_GUILD_ID` et s'arrête **avant tout envoi** sinon, pour ne jamais laisser un déploiement à moitié fait. Si `DEV_GUILD_ID` vaut `OWNER_GUILD_ID`, un seul envoi regroupe les deux lots.
3. Sans `OWNER_GUILD_ID`, `/bot` n'est déployée nulle part (avertissement). `npm run deploy -- --skip-owner` ne déploie que les commandes globales ; `--dry-run` montre les cibles sans rien envoyer.

Sur Discord, `/bot` exige d'être dans `OWNER_IDS`, d'avoir « Administrateur » et de l'utiliser sur `OWNER_GUILD_ID` ; `/help` ne la montre qu'aux propriétaires.

### Variables d'environnement (`.env`)

| Variable | Obligatoire | Description |
| --- | :---: | --- |
| `DISCORD_TOKEN` | ✅ | Token du bot (Developer Portal → Bot → Reset Token). |
| `CLIENT_ID` | ✅ | Identifiant de l'application (Developer Portal → General Information). |
| `DEV_GUILD_ID` | ➖ | Serveur de test où `npm run deploy` enregistre les commandes instantanément. |
| `OWNER_GUILD_ID` | ➖ | Serveur des propriétaires : seul endroit où la console `/bot` est enregistrée (vide : `/bot` n'est déployée nulle part). |
| `OWNER_IDS` | ➖ | Identifiants des propriétaires du bot, séparés par des virgules (console `/bot`). |
| `SECUR_TRUST_BOT_OWNERS` | ➖ | `on` donne aux `OWNER_IDS` le niveau « propriétaire du bot » de Secur sur tous les serveurs (exemptés, peuvent nommer les owners de sécurité). Coupé par défaut : seul le propriétaire de chaque serveur décide. |
| `DATABASE_PATH` | ➖ | Fichier SQLite (défaut : `./data/gadget.sqlite`). |
| `LOG_LEVEL` | ➖ | `error`, `warn`, `info` ou `debug` (défaut : `info`). |
| `NODE_ENV` | ➖ | `development` ou `production`. |
| `PRESENCE_STATUSES` | ➖ | Statuts tournants du bot, séparés par une barre verticale et préfixés de `joue:`, `regarde:` ou `écoute:` (variables `{serveurs}`, `{membres}` ; voir `.env.example`). |
| `PRESENCE_INTERVAL_MINUTES` | ➖ | Intervalle de rotation des statuts (1 minute au minimum). |
| `PRESENCE_INTENT` | ➖ | `on` active l'intent privilégié **GuildPresences** (à cocher aussi dans le Developer Portal) pour le rôle soutien par statut personnalisé. Désactivé par défaut ; le cache des présences reste vide, donc pas de compteur « En ligne ». |
| `FEEDS_NETWORK` | ➖ | `off` coupe toute requête sortante des flux RSS. |
| `CDN_NETWORK` | ➖ | `off` coupe les téléchargements depuis le CDN de Discord (avatar et bannière de `/bot` et `/settings profil`, fichier de `/embed texte`, images restaurées par Secur). Ces téléchargements sont limités à `cdn.discordapp.com` et `media.discordapp.net`, en https, 8 Mo par image, 10 s. |

Les variables d'exploitation (`HEALTH_PORT`, `HEALTH_HOST`, `LOG_FORMAT`, `DB_BACKUP_DIR`, `DB_BACKUP_KEEP`, `DB_BACKUP_INTERVAL_HOURS`) sont décrites dans [Exploitation](#-exploitation--docker-supervision-sauvegardes) et dans `.env.example`.

> 🔐 Ne committez jamais le fichier `.env` : il est déjà ignoré par `.gitignore`.

### Intents à activer

Le bot demande 10 intents, plus un 11ᵉ facultatif (`src/config/intents.js`). Dans le Developer Portal, onglet **Bot**, activez les deux intents privilégiés **Server Members Intent** et **Message Content Intent** ; les huit autres ne sont pas privilégiés et n'ont rien à activer. **Presence Intent** n'est demandé qu'avec `PRESENCE_INTENT=on` (rôle soutien par statut personnalisé) : cochez-le alors aussi dans le Developer Portal (validation de Discord au-delà de 100 serveurs). Même activé, le cache des présences reste vide : le compteur « En ligne » de `/compteurs` n'est pas proposé.

| Intent | Utilisé pour |
| --- | --- |
| `Guilds` | Serveurs, salons, rôles ; instantanés de Secur. |
| `GuildMembers` 🔒 | Arrivées et départs, hiérarchie, AntiRaid, Secur, contrôle des pseudos, membres inactifs, rôle soutien (tag du serveur). |
| `GuildModeration` | Bannissements et journal d'audit en direct : logs des actions manuelles, AntiRaid, Secur. |
| `GuildMessages` | Logs de messages, AutoMod, XP, statistiques, AFK, alertes, snipe, réponses et réactions automatiques, sticky, module @everyone de Secur. |
| `MessageContent` 🔒 | Contenu des messages : AutoMod, logs d'édition, alertes de mots-clés, réponses automatiques, snipe. |
| `GuildVoiceStates` | Vocaux temporaires, gestion et logs vocaux, XP et statistiques vocales, déconnexions vocales de Secur. |
| `DirectMessages` | ModMail. |
| `GuildExpressions` | Logs des emojis ; instantanés des emojis et autocollants pour Secur. |
| `GuildInvites` | Suivi des invitations (qui a invité qui). |
| `GuildMessageReactions` | Starboard. |
| `GuildPresences` 🔒 | **Facultatif** (`PRESENCE_INTENT=on`) : rôle soutien par statut personnalisé. |

### Inviter le bot

Une fois le bot démarré, la commande `/invite` donne un lien d'invitation qui demande ces 28 permissions (la liste `INVITE_PERMISSIONS`, celle que `/diagnostics` contrôle) :
Gérer le serveur · Voir les salons · Envoyer des messages · Envoyer des messages dans les fils · Intégrer des liens · Joindre des fichiers · Voir l'historique des messages · Ajouter des réactions · Utiliser des emojis externes · Gérer les messages · Gérer les salons · Gérer les rôles · **Gérer les pseudos** (AFK, AutoMod des pseudos, `/pseudo`) · Gérer les fils · **Gérer les webhooks** (Secur supprime les webhooks créés par un compte compromis) · Expulser des membres · Bannir des membres · Exclure temporairement des membres · Rendre muet · Mettre en sourdine · Déplacer des membres · **Voir les logs du serveur** (indispensable à Secur et à l'AntiRaid) · Créer des sondages · Se connecter · Gérer les expressions (`/emoji ajouter|supprimer|renommer`, emojis restaurés par Secur) · Créer des fils publics (fils automatiques) · Créer des fils privés (entretiens de candidature sans tickets) · **Mentionner @everyone** (annonces et `/embed texte` avec @everyone, raid ping et rôles non mentionnables ; sans elle sur le rôle du bot, la correction « @everyone » de l'audit de sécurité la lui retirerait).

> Bot invité avant la 0.7.0 : ajoutez **Gérer les webhooks** et **Mentionner @everyone** à son rôle, ou réinvitez-le avec le lien de `/invite`.

Placez ensuite le rôle du bot **au-dessus** des rôles qu'il doit gérer, et au-dessus des rôles d'administration si vous activez Secur : Discord interdit d'agir sur un rôle plus haut que le sien (ni sur le pseudo d'un membre placé au-dessus).

---

## 🐳 Exploitation : Docker, supervision, sauvegardes

- **Docker** : `Dockerfile` (image `node:22-bookworm-slim`, utilisateur non-root, base dans le volume `/app/data`) et `docker-compose.yml` d'exemple : copiez `.env.example` en `.env`, puis `docker compose up -d --build`.
- **Supervision** : définissez `HEALTH_PORT` pour activer `GET /healthz` (200 quand le bot est connecté et que la base répond, 503 sinon) et `GET /metrics` (métriques Prometheus : serveurs, latence, mémoire, commandes). Laissez-le sur `127.0.0.1` ou un réseau privé.
- **Logs JSON** : `LOG_FORMAT=json` produit une ligne JSON par entrée (Loki, ELK, Datadog…), secrets masqués.
- **Sauvegardes** : `npm run backup:db` crée une copie cohérente de la base dans `data/backups/` (14 conservées, `DB_BACKUP_KEEP`) ; avec `DB_BACKUP_INTERVAL_HOURS=24`, le bot sauvegarde lui-même chaque jour.
- **Déploiement des commandes** : `npm run deploy -- --dry-run` affiche ce qui serait envoyé sans rien changer ; `--clear-guild` vide les commandes du serveur de test.
- **CI** : GitHub Actions lance les tests et le healthcheck sur Node 22 et 24, puis construit l'image Docker, à chaque push.

---

## 🧭 Premiers pas sur un serveur

1. **`/diagnostics`** vérifie les permissions et la position du rôle du bot.
2. **`/logs`** puis **⚡ Création automatique** crée et branche tous les salons de logs en un clic.
3. **`/automod`** : choisissez le préréglage **Équilibré**, puis synchronisez l'**AutoMod de Discord** ; ensuite **`/antiraid`** → préréglage **Équilibré**, salon d'alerte et activation.
4. **Anti-nuke** : **`/diagnostics` › Audit de sécurité** (corrigez ce qui est rouge), **`/secur owner ajouter`** et **`/secur confiance ajouter`**, puis **`/secur on`** (voir [Secur](#%EF%B8%8F-secur-anti-nuke-type-crowbot)).
5. **`/bienvenue`** : salon d'accueil, rôles automatiques et, si besoin, vérification par bouton.
6. **`/tickets`** : catégorie, staff, motifs, puis **Publier le panneau**.
7. **`/niveaux`** et **`/tempvoice config`** si vous voulez l'XP et les vocaux temporaires.
8. **`/projet config`** règle le module projets, puis **`/projet creer`** crée votre premier projet.
9. Selon vos besoins : **`/permissions`** (niveaux de votre équipe), **`/signalements`**, **`/candidatures`**, **`/communaute`**, **`/economie`** (désactivée par défaut), **`/statistiques reglages`** et **`/alertes config`**.

> Donnez au bot **Gérer les rôles** (rôle placé au-dessus des rôles à attribuer), **Gérer les salons**, **Déplacer des membres** et **Voir les logs du serveur** : `/invite` génère un lien avec toutes ces permissions.

---

## 🛡️ Fiabilité

Chaque interaction passe par une couche de sûreté commune, avant même d'atteindre la commande :

- **Aucune double réponse** : une réponse arrivée après un délai remplace le message « réfléchit… » au lieu de provoquer une erreur.
- **Embeds toujours valides** : les textes trop longs sont coupés proprement au lieu de faire échouer la réponse.
- **Vérifications avant exécution** : commande disponible sur un serveur uniquement, permission déclarée par la commande revérifiée par le bot (ni un rôle autorisé dans Paramètres du serveur › Intégrations, ni un niveau de `/permissions` ne la contournent pour une commande sensible), permissions du bot présentes, délai anti-spam respecté.
- **Erreurs compréhensibles** : « il me manque la permission Bannir des membres » plutôt qu'une erreur générique. Les erreurs imprévues affichent un **code de référence** retrouvable dans les logs.
- **Double clics** : une action (levée de sanction, achat, décision de candidature, envoi d'annonce…) n'est exécutée qu'une fois, même sur des clics simultanés.
- **Résistance aux pannes** : bans temporaires, giveaways, verrous à durée, rôles temporaires et annonces programmées repris après un redémarrage, reconnexion automatique, arrêt propre et borné.

```bash
npm test        # plus de 1 800 tests, dont la validation des 101 commandes (menus contextuels compris) contre les limites de Discord
npm run test:e2e  # tests de bout en bout : le vrai bot sur le vrai discord.js, sans réseau
npm run test:chaos  # version longue des tests de chaos : valeurs hostiles, clics simultanés, marches aléatoires (CHAOS_SEED pour changer de graine)
npm run check   # healthcheck : base, commandes, événements, sans connexion
```

---

## 🧱 Architecture

Les commandes restent fines : toute la logique métier vit dans des services réutilisables.

```
src/
├── index.js        Point d'entrée, arrêt propre
├── config/         Configuration, intents, valeurs par défaut par serveur
├── core/           Client, chargeurs, couche de sûreté, erreurs, cooldowns, logger
├── database/       SQLite, migrations versionnées, repositories
├── services/       Logique métier : modération, projets, tickets, giveaways, antiraid…
│   └── secur/      Moteur anti-nuke : modules, sections de /secur, file d'annulation, alertes
├── commands/       Slash commands, un dossier par catégorie
├── components/     Boutons, menus et formulaires persistants (survivent aux redémarrages)
├── events/         Événements Discord : interactions, logs, connexion
└── utils/          Embeds, pagination, confirmation, dates, calcul, permissions
scripts/            Déploiement des commandes, migrations, healthcheck
tests/              Tests automatiques (node --test)
```

Ajouter une commande revient à déposer un fichier dans `src/commands/<catégorie>/`, sans registre central à modifier.
Le contrat complet d'une commande est décrit dans [ARCHITECTURE.md](./ARCHITECTURE.md), et le guide de contribution dans [CONTRIBUTING.md](./CONTRIBUTING.md).

**Données** : toutes les données sont rattachées à un serveur, donc isolées entre serveurs. Les migrations s'appliquent automatiquement au démarrage, ou à la main avec `npm run migrate`.

---

## 🩺 Dépannage

| Symptôme | Solution |
| --- | --- |
| `DISCORD_TOKEN manquant` | Copiez `.env.example` vers `.env` et renseignez le token. |
| `TokenInvalid` | Le token est faux ou révoqué : régénérez-le dans le Developer Portal. |
| Les commandes n'apparaissent pas | Lancez `npm run deploy`, avec `DEV_GUILD_ID` pour un effet immédiat. |
| « Cette commande n'existe plus » | Les commandes enregistrées sont anciennes : relancez `npm run deploy`. |
| « Il me manque des permissions » | Donnez la permission indiquée au bot, ou montez son rôle, puis lancez `/diagnostics`. |
| Membres ou messages non détectés | Activez les intents privilégiés dans le Developer Portal. |
| `/emoji ajouter` : « Il me manque la permission Gérer les expressions » | Bot invité avant la 0.6.0 : donnez cette permission à son rôle, ou réinvitez-le avec le lien de `/invite`. |
| `/bot` n'apparaît pas | Renseignez `OWNER_GUILD_ID`, invitez le bot sur ce serveur, puis relancez `npm run deploy`. |
| Secur ne réagit pas | Ses modules sont coupés par défaut : `/secur statut`, puis `/secur on`. Vérifiez que le bot a **Voir les logs du serveur** et que l'auteur n'est pas exempté (whitelist en « on », owners et bots de confiance). |
| « Appliquer » grisé dans `/secur on` ou `max` | Un bot aux permissions dangereuses n'est pas exempté : ajoutez-le aux bots de confiance, ou appliquez en acceptant le risque. |
| Un rôle whitelisté n'exempte pas | Donné par un non-owner, il attend l'approbation d'un owner : `/secur panneau` › Accès en attente. |
| Erreur avec un code de référence | Cherchez ce code dans les logs du bot pour voir l'erreur complète. |

---

## 📎 Liens utiles

- [ARCHITECTURE.md](./ARCHITECTURE.md) : fonctionnement interne.
- [CONTRIBUTING.md](./CONTRIBUTING.md) : ajouter une commande ou un service.
- [ROADMAP.md](./ROADMAP.md) : ce qui est fait, en cours et prévu.
- [CHANGELOG.md](./CHANGELOG.md) : historique des versions.
- [SECURITY.md](./SECURITY.md) : politique de sécurité.

## Licence

MIT.
