# Roadmap — Inspecteur Gadget

Statuts : `[x]` terminé · `[~]` en cours · `[ ]` prévu.
Une fonctionnalité n'est marquée terminée que si elle fonctionne réellement.

## Phase 1 — Foundation
- [x] Architecture modulaire (core / config / database / services / utils / commands / events)
- [x] Configuration centralisée + `.env` / `.env.example`
- [x] Logger multi-niveaux
- [x] Gestion globale des erreurs (anti-crash) + `UserError`
- [x] Client Discord (intents minimaux) + conteneur de services
- [x] Command handler (chargement récursif, autocomplete)
- [x] Event handler
- [x] Base de données SQLite + migrations versionnées + repositories
- [x] Script de déploiement des slash commands (dev/prod)
- [x] Healthcheck sans connexion
- [x] README + documentation

## Phase 2 — Core
- [x] `/help` interactif (menu par catégories + autocomplete)
- [x] `/diagnostics` (analyse config serveur)
- [x] `/health` + `/botinfo` + `/ping`
- [x] `/serverinfo` `/user` `/roleinfo` `/channel` `/avatar`

## Phase 3 — Modération
- [x] `/warn` (+ strikes, escalade automatique)
- [x] `/timeout` `/untimeout`
- [x] `/kick`
- [x] `/ban` (permanent + temporaire) `/unban`
- [x] `/sanctions` (list / remove / clear) — historique persistant
- [x] `/clear`
- [x] Confirmations pour actions dangereuses, garde-fous de hiérarchie
- [ ] `/tempban` dédié, `/mute` par rôle, `/lock` `/unlock` `/lockall`
- [ ] Gestion de rôles (`/addrole` `/delrole` `/derank`)

## Phase 4 — Logs
- [x] Logs modération, arrivées/départs, messages supprimés/édités
- [ ] Logs rôles, salons, permissions, vocaux, boosts (salon par catégorie)

## Phase 5 — AutoMod
- [ ] AntiSpam, AntiFlood, AntiLink, AntiInvite, AntiMassMention, AntiCaps, BadWords, AntiRepeat, AntiEmojiSpam
- [ ] Configuration par serveur (seuils, sanctions, ignorés)

## Phase 6 — Sécurité
- [ ] AntiRaid (antibot, antiwebhook, antichannel, antirole, antiban/kick/unban…)
- [ ] Détection d'activité inhabituelle (seuils temporels)
- [ ] Whitelist (users/rôles/bots)
- [ ] Lockdown d'urgence + restauration d'état

## Phase 7 — Community
- [ ] Tickets (setup, claim, transcript, fermeture auto)
- [ ] ModMail (DM → staff)
- [ ] Giveaways (persistants, reroll)
- [ ] Suggestions (votes + stats)
- [ ] Reaction/role menus
- [x] Rappels persistants (schéma + scheduler prêts) — [ ] commandes `/reminder`

## Phase 8 — Advanced tools
- [ ] Embed builder (modals)
- [ ] Commandes personnalisées
- [ ] Backups serveur (+ autobackup)
- [ ] Vocaux temporaires
- [ ] Actions de masse (mass role)

## Fondations préparées pour plus tard (non développées)
- [ ] Dashboard web · API · IA · statistiques avancées · SaaS/abonnements · plugins
