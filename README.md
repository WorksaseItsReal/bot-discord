<div align="center">

# 🕵️ Inspecteur Gadget

**Le bot Discord tout-en-un pour administrer, modérer, sécuriser et animer votre serveur.**

68 slash commands · plus de 140 actions · embeds soignés · multi-serveurs · 100 % en français

![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embarqu%C3%A9-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-259%20verts-57F287)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

</div>

---

## Sommaire

- [Points forts](#-points-forts)
- [Projets : la vitrine de votre serveur](#-projets--la-vitrine-de-votre-serveur)
- [AutoMod](#-automod)
- [Logs](#-logs)
- [Accueil, niveaux et vocaux](#-accueil-niveaux-et-vocaux)
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
| 🔨 **Modération complète** | Ban, tempban, mute, timeout, warn avec strikes et escalade, fiches de sanction, raisons modifiables, notes internes. |
| 🤖 **AutoMod** | 15 filtres résistants aux contournements, anti-arnaques (liens masqués compris), quarantaine des comptes piratés, bouton « Faux positif », exemptions par filtre, AutoMod natif Discord. |
| 🛡️ **Sécurité** | Tableau de bord `/antiraid` (vagues d'arrivées, comptes récents, suppressions en masse, simulation), whitelist, verrouillage d'urgence. |
| 👋 **Accueil** | Bienvenue et départ personnalisés, rôles automatiques, vérification anti-robot par bouton. |
| 📈 **Niveaux** | XP par message et en vocal, rôles de récompense, classement, tableau de bord `/niveaux`. |
| 🎫 **Communauté** | Tickets configurables avec `/tickets` (motifs, panneau, statistiques), ModMail avec transcript, giveaways, suggestions, menus de rôles, sondages. |
| 🔊 **Vocaux temporaires** | Panneau de contrôle dans le chat du vocal : verrou, nom, limite, expulsion, transfert, débit, région. |
| 📋 **Logs** | 9 catégories et 29 événements activables un par un, tableau de bord `/logs` et création automatique des salons. |
| 💾 **Backups** | Sauvegarde et restauration de la structure du serveur, permissions comprises. |
| 🎨 **Design soigné** | Chaque réponse est un embed cohérent, avec des boutons utiles et un bouton 🗑️ sur les réponses publiques. |
| 🧠 **Fiable** | Aucune double réponse, boutons protégés contre la falsification, erreurs expliquées en français, plus de 470 tests automatiques, CI GitHub Actions. |

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
| 🔨 Modération | Sanctions, levées de sanction, bans, kicks et timeouts faits hors du bot (avec leur auteur), tickets |
| 💬 Messages | Suppressions, modifications, suppressions en masse (transcript `.txt` joint) |
| 👥 Membres | Arrivées, départs, rôles ajoutés/retirés et pseudos (avec l'auteur du changement), boosts |
| 🎭 Rôles | Créations, suppressions, modifications (permissions comprises) |
| 🗂️ Salons | Salons et fils créés, supprimés, modifiés |
| 🔊 Vocal | Connexions, déconnexions, changements de salon |
| 🛡️ Sécurité | Alertes AntiRaid, verrouillages |
| 🤖 AutoMod | Messages filtrés et sanctions automatiques |
| 🏠 Serveur | Paramètres du serveur, emojis ajoutés/supprimés |

> L'auteur des changements de rôles, de pseudos et des actions manuelles provient du journal d'audit :
> donnez au bot la permission **Voir les logs du serveur**.

---

## 👋 Accueil, niveaux et vocaux

**`/bienvenue`** (Gérer le serveur) règle tout l'accueil depuis un tableau de bord :

- **Bienvenue et départ** : salon, titre, texte, couleur, bannière ; variables `{membre}`, `{pseudo}`, `{serveur}`, `{nombre}`, `{compte}` ; mention du membre et copie en MP facultatives ; aperçu et envoi de test.
- **Rôles automatiques** séparés humains / bots (10 chacun), hiérarchie vérifiée, rôles Administrateur refusés.
- **Vérification par bouton** : rôle « vérifié » donné (ou « non vérifié » retiré), question anti-robot (petit calcul ou mot à recopier), âge minimal du compte, log « Vérifications réussies ». Les rôles automatiques ne sont donnés qu'après vérification.
- L'accueil passe **après l'AntiRaid** (un raider puni ne reçoit rien) et attend l'acceptation de l'écran d'adhésion Discord ; @everyone et @here ne sont jamais mentionnés.

**Niveaux et XP** (désactivés par défaut) — `/niveaux` (Gérer le serveur) :

- 15 à 25 XP par message, une fois par minute et par membre (réglable) ; les bots, messages de moins de 3 caractères et messages supprimés par l'AutoMod ne comptent pas.
- XP vocale optionnelle : par minute passée micro ouvert, à plusieurs, hors salon AFK.
- Annonces de niveau (même salon, salon dédié, MP ou désactivées ; `{membre}`, `{niveau}`), rôles de récompense cumulatifs ou seulement le plus haut, multiplicateurs par rôle, salons et rôles exclus, gestion de l'XP (donner, retirer, définir, importer, réinitialiser).
- Les membres consultent leur carte avec **`/rang [membre]`** et le classement paginé avec **`/classement`**.

**Vocaux temporaires** — rejoindre le salon créateur crée un vocal personnel (permissions de la catégorie conservées), supprimé quand il est vide. Un **panneau de contrôle** est posté dans son chat : 🔒 verrouiller, 👁️ masquer, ✏️ renommer, 👥 limite, 🚪 expulser, ⛔ bannir du salon, ✅ autoriser, 👑 transférer, 🙋 réclamer, 🎚️ débit, 🌍 région. Seuls le propriétaire et les modérateurs s'en servent ; les noms sont filtrés (mots interdits de l'AutoMod compris). Le nom, la limite et le verrou sont mémorisés pour les prochains vocaux. `/tempvoice config` règle le salon créateur, la catégorie, le nom par défaut (`{pseudo}`, `{username}`, `{n}`) et la limite.

---

## 📚 Toutes les commandes

Tapez `/help` sur Discord pour un menu interactif, ou `/help commande:<nom>` pour le détail d'une commande.
Les commandes marquées 🔒 demandent une permission Discord, par exemple « Bannir des membres » pour `/ban`.

<details>
<summary><b>📊 Informations</b> (12)</summary>

| Commande | Description |
| --- | --- |
| `/help` | Menu d'aide interactif, par catégorie. |
| `/serverinfo` | Informations détaillées du serveur. |
| `/user` | Profil d'un membre : dates, rôles, permissions clés. |
| `/roleinfo` · `/roles` · `/inrole` | Détail d'un rôle, liste des rôles, membres ayant un rôle. |
| `/channel` | Informations d'un salon. |
| `/avatar` · `/banniere` | Avatar ou bannière en grand, avec liens de téléchargement. |
| `/emoji` | Emoji personnalisé en grand, avec son identifiant. |
| `/membres` | Compteur de membres et membres en ligne. |
| `/botinfo` | Statistiques et informations techniques du bot. |

</details>

<details>
<summary><b>🔨 Modération</b> (20) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/ban` · `/tempban` · `/unban` · `/banlist` | Bannissements définitifs ou temporaires, levée automatique. |
| `/kick` | Expulsion d'un membre. |
| `/warn` | Avertissement avec strikes et sanction automatique au palier atteint. |
| `/mute` · `/unmute` · `/timeout` · `/untimeout` | Rendre muet par rôle ou par exclusion Discord, permanent ou temporaire. |
| `/sanctions` | Fiches et historique des sanctions : `voir`, `historique`, `raison`, `note`, `notes`, `remove`, `clear`. |
| `/clear` | Suppression de messages en masse, filtrable par membre. |
| `/lock` · `/unlock` · `/lockall` · `/unlockall` | Verrouillage d'un salon ou de tout le serveur, avec restauration exacte. |
| `/hide` · `/unhide` | Masquer ou réafficher un salon. |
| `/slowmode` | Mode lent d'un salon, jusqu'à 6 heures. |
| `/pseudo` | Modifier ou réinitialiser le pseudo d'un membre. |

</details>

<details>
<summary><b>🤖 AutoMod & 🛡️ Sécurité</b> (4) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/automod` | Tableau de bord interactif : tout l'AutoMod se configure avec des boutons, menus et formulaires. |
| `/antiraid` | Tableau de bord : vagues d'arrivées, comptes récents et bots, suppressions en masse, alertes, whitelist, préréglages, simulation. |
| `/whitelist` | Membres et rôles de confiance, ignorés par l'AntiRaid. |
| `/lockdown` | Verrouillage d'urgence de tout le serveur, puis restauration. |

</details>

<details>
<summary><b>🎫 Communauté</b> (11)</summary>

| Commande | Description |
| --- | --- |
| `/tickets` 🔒 | Tableau de bord des tickets : catégorie, staff, transcripts, motifs, panneau, statistiques. |
| `/ticket` | Actions dans un ticket : fermer (avec confirmation), prendre en charge, transcript, ajouter, retirer, renommer. |
| `/bienvenue` 🔒 | Messages de bienvenue et de départ, rôles automatiques, vérification par bouton. |
| `/modmail` | Les membres écrivent au bot en MP, le staff répond depuis un salon privé ; transcript à la fermeture. |
| `/giveaway` 🔒 | Concours avec participation par bouton, fin automatique et nouveau tirage. |
| `/suggestion` | Idées de la communauté avec votes 👍/👎, acceptées ou refusées par le staff. |
| `/rolemenu` 🔒 | Menu de rôles que les membres s'attribuent eux-mêmes. |
| `/role` · `/derank` · `/massrole` 🔒 | Gestion des rôles, retrait complet, attribution en masse. |
| `/sondage` | Sondage natif Discord, de 2 à 10 réponses, jusqu'à 32 jours. |

</details>

<details>
<summary><b>🔊 Vocaux</b> (2) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/voice` | Déplacer, expulser, rendre muet ou vider un salon vocal. |
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
<summary><b>🧰 Outils</b> (10)</summary>

| Commande | Description |
| --- | --- |
| `/embed` 🔒 | Créer et envoyer des embeds personnalisés via un formulaire. |
| `/custom` 🔒 · `/tag` | Commandes personnalisées avec variables. |
| `/reminder` | Rappels personnels, conservés même après un redémarrage. |
| `/calcul` | Calculatrice : `(2+3)^2 / sqrt(16)`, fonctions et constantes. |
| `/timestamp` | Dates Discord affichées dans le fuseau horaire de chaque lecteur. |
| `/couleur` | Aperçu d'une couleur en HEX, RGB et HSL, ou couleur aléatoire. |
| `/invite` · `/ping` · `/uptime` | Lien d'invitation, latence, disponibilité. |

</details>

<details>
<summary><b>🎲 Fun</b> (5)</summary>

| Commande | Description |
| --- | --- |
| `/8ball` | La boule magique répond à vos questions. |
| `/pileface` | Pile ou face, avec pari optionnel. |
| `/de` | Dés en notation JDR : `d20`, `2d6`, `3d8+2`, avec coups critiques. |
| `/choisir` | Le bot choisit pour vous parmi plusieurs options. |
| `/pfc` | Pierre-feuille-ciseaux contre le bot, avec des boutons. |

</details>

<details>
<summary><b>⚙️ Configuration</b> (5) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/logs` | Tableau de bord des logs : salons, événements, création automatique des salons. |
| `/settings` | Vue d'ensemble de la configuration, options de modération. |
| `/diagnostics` | Analyse la configuration et signale les permissions manquantes. |
| `/backup` | Sauvegarde, restauration et sauvegarde automatique de la structure du serveur. |
| `/health` | État technique du bot : latence, base de données, services. |
| `/projet config` | Réglages du module projets. |

</details>

---

## 🚀 Installation

**Prérequis** : Node.js 20 ou plus récent, et une application Discord créée sur le [Developer Portal](https://discord.com/developers/applications). Aucune base de données à installer : SQLite est embarqué.

```bash
# 1. Installer les dépendances
npm install

# 2. Créer le fichier de configuration, puis le remplir
cp .env.example .env

# 3. Vérifier que tout est bien câblé (sans connexion à Discord)
npm run check

# 4. Enregistrer les slash commands
npm run deploy           # sur le serveur de test DEV_GUILD_ID (instantané)
npm run deploy:global    # sur tous les serveurs (jusqu'à 1 h de propagation)

# 5. Démarrer le bot
npm start                # ou npm run dev pour relancer à chaque modification
```

> ⚠️ Relancez `npm run deploy` après chaque mise à jour qui ajoute ou modifie des commandes.

### Variables d'environnement (`.env`)

| Variable | Obligatoire | Description |
| --- | :---: | --- |
| `DISCORD_TOKEN` | ✅ | Token du bot (Developer Portal → Bot → Reset Token). |
| `CLIENT_ID` | ✅ | Identifiant de l'application (Developer Portal → General Information). |
| `DEV_GUILD_ID` | ➖ | Serveur de test où `npm run deploy` enregistre les commandes instantanément. |
| `OWNER_IDS` | ➖ | Identifiants des propriétaires du bot, séparés par des virgules. |
| `DATABASE_PATH` | ➖ | Fichier SQLite (défaut : `./data/gadget.sqlite`). |
| `LOG_LEVEL` | ➖ | `error`, `warn`, `info` ou `debug` (défaut : `info`). |
| `NODE_ENV` | ➖ | `development` ou `production`. |

> 🔐 Ne committez jamais le fichier `.env` : il est déjà ignoré par `.gitignore`.

### Intents à activer

Dans le Developer Portal, onglet **Bot**, activez les deux intents privilégiés **Server Members Intent** et **Message Content Intent**.

| Intent | Utilisé pour |
| --- | --- |
| `Guilds` | Serveurs, salons, rôles. |
| `GuildMembers` 🔒 | Arrivées et départs, hiérarchie, AntiRaid. |
| `GuildModeration` | Bannissements : logs et détection d'abus. |
| `GuildMessages` | Logs de messages et AutoMod. |
| `MessageContent` 🔒 | Contenu des messages : AutoMod, logs d'édition. |
| `GuildVoiceStates` | Vocaux temporaires, gestion et logs vocaux. |
| `DirectMessages` | ModMail. |
| `GuildExpressions` | Logs des emojis. |

### Inviter le bot

Une fois le bot démarré, la commande `/invite` donne un lien d'invitation avec toutes les permissions nécessaires.
Placez ensuite le rôle du bot **au-dessus** des rôles qu'il doit gérer : Discord interdit d'agir sur un rôle plus haut que le sien.

---

## 🐳 Exploitation : Docker, supervision, sauvegardes

- **Docker** : `Dockerfile` (image `node:22-bookworm-slim`, utilisateur non-root, base dans le volume `/app/data`) et `docker-compose.yml` d'exemple : copiez `.env.example` en `.env`, puis `docker compose up -d --build`.
- **Supervision** : définissez `HEALTH_PORT` pour activer `GET /healthz` (200 quand le bot est connecté et que la base répond, 503 sinon) et `GET /metrics` (métriques Prometheus : serveurs, latence, mémoire, commandes). Laissez-le sur `127.0.0.1` ou un réseau privé.
- **Logs JSON** : `LOG_FORMAT=json` produit une ligne JSON par entrée (Loki, ELK, Datadog…), secrets masqués.
- **Sauvegardes** : `npm run backup:db` crée une copie cohérente de la base dans `data/backups/` (14 conservées, `DB_BACKUP_KEEP`) ; avec `DB_BACKUP_INTERVAL_HOURS=24`, le bot sauvegarde lui-même chaque jour.
- **Déploiement des commandes** : `npm run deploy -- --dry-run` affiche ce qui serait envoyé sans rien changer ; `--clear-guild` vide les commandes du serveur de test.
- **CI** : GitHub Actions lance les tests et le healthcheck sur Node 20 et 22, puis construit l'image Docker, à chaque push.

---

## 🧭 Premiers pas sur un serveur

1. **`/diagnostics`** vérifie les permissions et la position du rôle du bot.
2. **`/logs`** puis **⚡ Création automatique** crée et branche tous les salons de logs en un clic.
3. **`/automod`** : choisissez le préréglage **Équilibré**, puis synchronisez l'**AutoMod de Discord** ; ensuite **`/antiraid`** → préréglage **Équilibré** et activation.
4. **`/bienvenue`** : salon d'accueil, rôles automatiques et, si besoin, vérification par bouton.
5. **`/tickets`** : catégorie, staff, motifs, puis **Publier le panneau**.
6. **`/niveaux`** et **`/tempvoice config`** si vous voulez l'XP et les vocaux temporaires.
7. **`/projet config`** règle le module projets, puis **`/projet creer`** crée votre premier projet.

> Donnez au bot **Gérer les rôles** (rôle placé au-dessus des rôles à attribuer), **Gérer les salons**, **Déplacer des membres** et **Voir les logs du serveur** : `/invite` génère un lien avec toutes ces permissions.

---

## 🛡️ Fiabilité

Chaque interaction passe par une couche de sûreté commune, avant même d'atteindre la commande :

- **Aucune double réponse** : une réponse arrivée après un délai remplace le message « réfléchit… » au lieu de provoquer une erreur.
- **Embeds toujours valides** : les textes trop longs sont coupés proprement au lieu de faire échouer la réponse.
- **Vérifications avant exécution** : commande disponible sur un serveur uniquement, permissions du bot présentes, délai anti-spam respecté.
- **Erreurs compréhensibles** : « il me manque la permission Bannir des membres » plutôt qu'une erreur générique. Les erreurs imprévues affichent un **code de référence** retrouvable dans les logs.
- **Résistance aux pannes** : bans temporaires et giveaways repris après un redémarrage, reconnexion automatique, arrêt propre.

```bash
npm test        # 259 tests, dont la validation des 68 commandes contre les limites de Discord
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
