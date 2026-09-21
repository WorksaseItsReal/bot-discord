# Sécurité

## Gestion des secrets

- **Aucun secret en dur.** Token, IDs et clés vivent uniquement dans `.env` (ignoré par `.gitignore`).
- `.env.example` documente les variables sans valeur réelle.
- Ne loggez jamais le token ni le contenu de `.env`.

## ⚠️ Token historique à révoquer

L'ancien fichier `index.js` contenait un **token Discord codé en dur**. Il a été supprimé,
mais il **reste dans l'historique git**. Vous devez :

1. Aller dans le [Developer Portal](https://discord.com/developers/applications) → votre app → **Bot**.
2. Cliquer **Reset Token** pour invalider l'ancien.
3. Mettre le nouveau token dans `.env` uniquement.

Tant que ce n'est pas fait, considérez l'ancien token comme compromis.

## Bonnes pratiques appliquées dans le code

- **Permissions Discord natives** : chaque commande déclare `setDefaultMemberPermissions`.
  Le bot ne contourne jamais les permissions Discord.
- **Garde-fous de hiérarchie** : impossible de sanctionner soi-même, le bot, le propriétaire,
  ou un membre de rôle supérieur/égal (`utils/permissions.js`).
- **Entrées utilisateur validées** : durées, IDs (regex), bornes des options.
- **Isolation multi-serveurs** : toutes les requêtes sont paramétrées par `guildId`.
- **Anti-crash** : erreurs capturées, `unhandledRejection` / `uncaughtException` gérés.
- **Confirmations** pour les actions destructrices (ban, kick, …), configurable par serveur.

## Signaler une vulnérabilité

Ouvrez une issue privée ou contactez un mainteneur. Ne divulguez pas publiquement de faille
avant qu'un correctif soit disponible.
