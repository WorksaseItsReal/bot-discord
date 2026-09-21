# Architecture — Inspecteur Gadget

## Principes

1. **Commandes fines, services épais.** Une commande valide les entrées, appelle un service, formate une réponse. La logique métier vit dans `src/services`.
2. **Injection de dépendances.** `GadgetClient` construit la base, les repositories et les services une seule fois, puis les expose via `client.services` / `client.repositories`.
3. **Isolation multi-serveurs.** Toute donnée est indexée par `guildId`. Aucun état global spécifique à un serveur.
4. **Persistance d'abord.** Tout ce qui doit survivre à un redémarrage (sanctions, bans temporaires, rappels, config, strikes) vit en base et est réconcilié par le `SchedulerService`.
5. **Extensibilité.** Ajouter une commande = déposer un fichier dans `src/commands/<catégorie>/`. Ajouter un événement = un fichier dans `src/events/`. Aucun registre central à éditer.

## Flux d'une interaction

```
Discord → events/interactionCreate.js
        → client.commands.get(name).execute(interaction, client)
            → services.* (logique métier)
                → repositories.* (SQLite)
        → réponse (embeds/composants centralisés)
        ⤷ toute erreur est capturée : UserError → message propre, sinon log + message générique
```

## Couches

| Couche         | Rôle                                                                 | Exemples |
| -------------- | ------------------------------------------------------------------- | -------- |
| `config/`      | Configuration process (env) + defaults par serveur + intents        | `index.js`, `defaults.js`, `intents.js` |
| `core/`        | Bootstrap, handlers, logger, gestion d'erreurs                      | `GadgetClient`, `CommandHandler`, `EventHandler` |
| `database/`    | Connexion SQLite, migrations, repositories                          | `DatabaseManager`, `SanctionRepository` |
| `services/`    | Logique métier réutilisable                                         | `ModerationService`, `StrikeService`, `SchedulerService` |
| `utils/`       | Helpers UI et purs (testables)                                      | `embeds`, `components`, `time`, `permissions` |
| `commands/`    | Slash commands par catégorie                                        | `moderation/ban.js` |
| `events/`      | Écouteurs d'événements Discord                                      | `interactionCreate.js` |

## Base de données

- **Moteur** : `better-sqlite3` (synchrone → code simple, pas de callback hell, transactions faciles).
- **Migrations** : tableau ordonné dans `schema.js`, appliquées via la table `_migrations`. Idempotent.
- **Tables** : `guild_config`, `sanctions`, `strikes`, `reminders` (+ `_migrations`). Index sur les accès fréquents (`guild_id, user_id`, expirations).
- **Accès** : uniquement via les repositories. Requêtes préparées, paramétrées par `guildId`.

## Gestion des erreurs

- `UserError` : erreur attendue et sûre à montrer (permission, hiérarchie, cible invalide…). Affichée telle quelle.
- Toute autre erreur : loggée avec stack, réponse générique à l'utilisateur, **jamais** de crash (handlers `unhandledRejection` / `uncaughtException`).

## Composants & thème

Un seul endroit définit couleurs et styles (`utils/embeds.js`) et la fabrication de boutons/menus/rows (`utils/components.js`). Confirmation (`confirmation.js`) et pagination (`pagination.js`) sont des helpers réutilisables pour éviter la duplication.

## Scheduler

Boucle périodique (30 s) qui :
- lève les **bans temporaires** expirés (débannissement auto) ;
- délivre les **rappels** arrivés à échéance.
Tolérant aux redémarrages : l'état vient toujours de la base.

## Ajouter une fonctionnalité — checklist

1. Besoin d'état ? → table + repository (`database/`), migration incrémentale.
2. Logique métier ? → service (`services/`), branché dans `GadgetClient.bootstrap()`.
3. Interface ? → commande (`commands/<catégorie>/`) fine qui appelle le service.
4. Réactions à des événements ? → fichier dans `events/`.
5. Tests de la logique pure/critique → `tests/`.
6. `npm run check` puis `npm test`.
