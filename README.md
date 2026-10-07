<div align="center">

# 🕵️ Inspecteur Gadget

**Le bot Discord tout-en-un pour administrer, modérer, sécuriser et animer votre serveur.**

67 slash commands · plus de 140 actions · embeds soignés · multi-serveurs · 100 % en français

![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embarqu%C3%A9-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-90%20verts-57F287)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

</div>

---

## Sommaire

- [Points forts](#-points-forts)
- [Projets : la vitrine de votre serveur](#-projets--la-vitrine-de-votre-serveur)
- [Toutes les commandes](#-toutes-les-commandes)
- [Installation](#-installation)
- [Premiers pas sur un serveur](#-premiers-pas-sur-un-serveur)
- [Fiabilité](#%EF%B8%8F-fiabilité)
- [Architecture](#-architecture)
- [Dépannage](#-dépannage)

---

## ✨ Points forts

| | |
| --- | --- |
| 📁 **Projets** | Fiches de projet en embed avec progression, équipe, tâches et liens, mises à jour en direct. |
| 🔨 **Modération complète** | Ban, tempban, mute, timeout, warn avec strikes et escalade automatique, historique persistant. |
| 🤖 **AutoMod** | 10 filtres : spam, flood, liens, invitations, mentions, majuscules, mots interdits, répétitions, emojis, doublons. |
| 🛡️ **Sécurité** | AntiRaid (vagues d'arrivées, comptes récents, suppressions en masse), whitelist, verrouillage d'urgence. |
| 🎫 **Communauté** | Tickets avec transcript, ModMail, giveaways, suggestions avec votes, menus de rôles, sondages. |
| 📋 **Logs** | Modération, membres, messages, rôles, salons, vocaux, bans, automod, sécurité. |
| 💾 **Backups** | Sauvegarde et restauration de la structure du serveur, permissions comprises. |
| 🧠 **Fiable** | Aucune double réponse, erreurs expliquées en français, 90 tests automatiques. |

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
| `/sanctions` | Historique d'un membre : `list`, `remove`, `clear`. |
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
| `/automod` | Active et règle les 10 filtres, salons et rôles ignorés, mots interdits. |
| `/antiraid` | Vagues d'arrivées, âge minimum des comptes, anti-bot, suppressions en masse. |
| `/whitelist` | Membres et rôles de confiance, ignorés par l'AntiRaid. |
| `/lockdown` | Verrouillage d'urgence de tout le serveur, puis restauration. |

</details>

<details>
<summary><b>🎫 Communauté</b> (9)</summary>

| Commande | Description |
| --- | --- |
| `/ticket` | Tickets de support : panel à bouton, prise en charge, transcript, ajout de membres. |
| `/modmail` | Les membres écrivent au bot en MP, le staff répond depuis un salon privé. |
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
| `/tempvoice` | Salons vocaux temporaires : rejoindre un salon en crée un, supprimé quand il est vide. |

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
<summary><b>⚙️ Configuration</b> (4) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/settings` | Salons de logs par catégorie, options de modération. |
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

### Inviter le bot

Une fois le bot démarré, la commande `/invite` donne un lien d'invitation avec toutes les permissions nécessaires.
Placez ensuite le rôle du bot **au-dessus** des rôles qu'il doit gérer : Discord interdit d'agir sur un rôle plus haut que le sien.

---

## 🧭 Premiers pas sur un serveur

1. **`/diagnostics`** vérifie les permissions et la position du rôle du bot.
2. **`/settings logs`** choisit un salon pour chaque catégorie de logs.
3. **`/automod enable`** puis **`/antiraid enable`** activent la protection automatique.
4. **`/ticket setup`** puis **`/ticket panel`** installent le support par tickets.
5. **`/projet config`** règle le module projets, puis **`/projet creer`** crée votre premier projet.

---

## 🛡️ Fiabilité

Chaque interaction passe par une couche de sûreté commune, avant même d'atteindre la commande :

- **Aucune double réponse** : une réponse arrivée après un délai remplace le message « réfléchit… » au lieu de provoquer une erreur.
- **Embeds toujours valides** : les textes trop longs sont coupés proprement au lieu de faire échouer la réponse.
- **Vérifications avant exécution** : commande disponible sur un serveur uniquement, permissions du bot présentes, délai anti-spam respecté.
- **Erreurs compréhensibles** : « il me manque la permission Bannir des membres » plutôt qu'une erreur générique. Les erreurs imprévues affichent un **code de référence** retrouvable dans les logs.
- **Résistance aux pannes** : bans temporaires et giveaways repris après un redémarrage, reconnexion automatique, arrêt propre.

```bash
npm test        # 90 tests, dont la validation des 67 commandes contre les limites de Discord
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
