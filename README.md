# 🕵️ Inspecteur Gadget — Bot Discord de gestion tout-en-un

Un **seul bot**, une **immense boîte à outils** pour administrer, modérer, sécuriser et automatiser un serveur Discord — avec une architecture propre, modulaire et extensible.

> 100 % **Slash Commands** · **discord.js v14** · **Node.js** · **SQLite** · Multi-serveurs · Aucune donnée sensible en dur.

---

## ✨ Fonctionnalités

**48 slash commands** réparties en catégories. La [ROADMAP](./ROADMAP.md) est **entièrement implémentée** (phases 1 à 8).

- 📊 **Informations** — `/help` (menu interactif), `/serverinfo`, `/user`, `/roleinfo`, `/channel`, `/avatar`, `/botinfo`
- 🔨 **Modération** — `/ban` `/tempban` `/unban` `/kick` `/warn` `/mute` `/unmute` `/timeout` `/untimeout` `/clear` `/sanctions` `/banlist` `/lock` `/unlock` `/lockall` `/unlockall` `/hide` `/unhide`
- 🧮 **Sanctions & Strikes** — historique persistant + escalade automatique configurable
- 🤖 **AutoMod** — `/automod` : anti-spam, flood, liens, invites, mentions, caps, mots interdits, répétition, emojis, doublons
- 🛡️ **Sécurité** — `/antiraid` (vagues d'arrivées, âge de compte, actions destructrices via audit log), `/whitelist`, `/lockdown`
- 🎫 **Tickets & ModMail** — `/ticket` (panel, claim, transcript…), `/modmail` (DM ↔ staff)
- 🎉 **Giveaways** — `/giveaway` (persistants, participation par bouton, fin auto, reroll)
- 💡 **Suggestions** — `/suggestion` (votes 👍/👎, approve/deny)
- 🎭 **Rôles** — `/role`, `/derank`, `/massrole`, `/rolemenu` (auto-attribution)
- 🔊 **Vocaux** — `/voice` (move/kick/mute/cleanup…), `/tempvoice` (join-to-create)
- 💾 **Backups** — `/backup` (create/list/restore/auto — structure uniquement)
- 🧰 **Outils** — `/embed` (builder), `/custom` + `/tag` (commandes personnalisées), `/reminder`
- ⚙️ **Configuration** — `/settings`, `/diagnostics`, `/health`
- 📋 **Logs** — modération, membres, messages, rôles, salons, vocaux, bans, automod, sécurité

---

## 🧱 Architecture (résumé)

Les commandes restent **fines** ; toute la logique métier vit dans des **services** réutilisables.

```
src/
├── index.js            # Point d'entrée
├── config/             # Config centralisée, intents, valeurs par défaut par serveur
├── core/               # GadgetClient (DI), handlers commandes/événements, logger, erreurs
├── database/           # SQLite (better-sqlite3), migrations, repositories
├── services/           # Config, Moderation, Strike, Logging, Scheduler
├── utils/              # Embeds, composants, pagination, confirmation, temps, permissions
├── commands/           # Slash commands par catégorie (information, moderation, ...)
└── events/             # Événements Discord (ready, interactionCreate, logs...)
scripts/                # deploy-commands, migrate, healthcheck
tests/                  # Tests unitaires (node --test)
```

Détails complets dans [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 🚀 Prérequis

- **Node.js ≥ 20** (testé sur Node 22)
- Un **compte développeur Discord** et une **application/bot** : <https://discord.com/developers/applications>
- Aucune base externe à installer : **SQLite** est embarqué (fichier local).

---

## ⚙️ Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Créer le fichier d'environnement
cp .env.example .env
#    puis éditez .env (voir la section Variables ci-dessous)

# 3. (optionnel) Vérifier que tout est bien câblé, sans connexion Discord
npm run check

# 4. Enregistrer les slash commands (sur votre serveur de test)
npm run deploy

# 5. Démarrer le bot
npm start
```

En développement, `npm run dev` relance automatiquement le bot à chaque changement.

---

## 🔐 Variables d'environnement (`.env`)

| Variable        | Obligatoire | Description                                                                 |
| --------------- | :---------: | -------------------------------------------------------------------------- |
| `DISCORD_TOKEN` |     ✅      | Token du bot (Developer Portal → Bot → Reset Token).                        |
| `CLIENT_ID`     |     ✅      | Application ID du bot (Developer Portal → General Information).             |
| `DEV_GUILD_ID`  |     ➖      | Serveur de test : `npm run deploy` y enregistre les commandes instantanément. |
| `OWNER_IDS`     |     ➖      | IDs propriétaires (séparés par des virgules) pour les commandes réservées.  |
| `DATABASE_PATH` |     ➖      | Chemin du fichier SQLite (défaut : `./data/gadget.sqlite`).                 |
| `LOG_LEVEL`     |     ➖      | `error` \| `warn` \| `info` \| `debug` (défaut : `info`).                   |
| `NODE_ENV`      |     ➖      | `development` \| `production`.                                              |

> ⚠️ **Ne committez jamais `.env`.** Il est ignoré par `.gitignore`. Les secrets ne vivent que dans l'environnement.

---

## 🧠 Intents Discord requis

Activez ces **Privileged Gateway Intents** dans le Developer Portal (Bot) :

| Intent            | Pourquoi                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `Guilds`          | Base : serveurs, salons, rôles.                                  |
| `GuildMembers` 🔒 | Arrivées/départs, hiérarchie, modération, (futur) antiraid.       |
| `GuildModeration` | Événements de bans (logs).                                       |
| `GuildMessages`   | Réception des messages (logs, futur automod).                    |
| `MessageContent` 🔒 | Contenu des messages (logs d'édition, futur automod).          |
| `GuildVoiceStates`| Gestion et logs vocaux (à venir).                                |
| `DirectMessages`  | Base pour un futur ModMail.                                      |

🔒 = intent privilégié à activer manuellement dans le portail.

---

## 🗄️ Base de données

- Moteur : **SQLite** via `better-sqlite3` (synchrone, rapide, fichier unique, sauvegarde triviale).
- **Migrations versionnées** appliquées automatiquement au démarrage (`src/database/schema.js`).
- Toute donnée est **liée à un `guildId`** → isolation multi-serveurs garantie.
- Accès uniquement via la **couche repositories** (aucune requête SQL dans les commandes).

Pour (ré)appliquer les migrations manuellement : `npm run migrate`.

---

## 🧪 Tests

```bash
npm test        # exécute la suite (node --test)
npm run check   # healthcheck : DB + chargement commandes/événements sans login
```

Couverture actuelle : parsing de durées, hiérarchie des permissions, service de configuration (fusion des défauts + isolation multi-serveurs), escalade des strikes, repository des sanctions.

---

## 🩺 Dépannage

| Symptôme                                    | Piste                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `DISCORD_TOKEN manquant`                    | Copiez `.env.example` → `.env` et renseignez le token.               |
| `TokenInvalid`                              | Le token est faux/révoqué : régénérez-le dans le Developer Portal.   |
| Les commandes n'apparaissent pas            | Lancez `npm run deploy` (avec `DEV_GUILD_ID` pour l'instantané).      |
| Le bot ne peut pas bannir/expulser          | Vérifiez la hiérarchie des rôles et lancez `/diagnostics`.           |
| Membres non détectés                        | Activez l'intent privilégié `GuildMembers`.                          |

---

## 🔒 Sécurité

Voir [SECURITY.md](./SECURITY.md). En résumé : jamais de secret en dur, `.env` non commité, entrées utilisateur validées, permissions Discord natives respectées, jamais contournées.

## 🗺️ Roadmap & 📝 Changelog

- [ROADMAP.md](./ROADMAP.md) — ce qui est fait / en cours / prévu.
- [CHANGELOG.md](./CHANGELOG.md) — historique des versions.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — comment ajouter une commande/service.

## Licence

MIT.
