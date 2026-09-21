# Roadmap — Inspecteur Gadget

Statuts : `[x]` terminé · `[~]` en cours · `[ ]` prévu.
Une fonctionnalité n'est marquée terminée que si elle fonctionne réellement.

## Phase 1 — Foundation
- [x] Architecture modulaire (core / config / database / services / utils / commands / events / components)
- [x] Configuration centralisée + `.env` / `.env.example`
- [x] Logger multi-niveaux
- [x] Gestion globale des erreurs (anti-crash) + `UserError`
- [x] Client Discord (intents minimaux) + conteneur de services
- [x] Command handler (chargement récursif, autocomplete)
- [x] Event handler (supporte modules multiples)
- [x] Routeur de composants persistants (boutons, menus, modals)
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
- [x] `/mute` `/unmute` (rôle Muted, temporaire) · `/timeout` `/untimeout`
- [x] `/kick`
- [x] `/ban` (permanent + temporaire) · `/tempban` · `/unban`
- [x] `/sanctions` (list / remove / clear) — historique persistant
- [x] `/clear`
- [x] `/lock` `/unlock` `/lockall` `/unlockall` · `/hide` `/unhide`
- [x] `/banlist`
- [x] Confirmations pour actions dangereuses, garde-fous de hiérarchie

## Phase 4 — Logs
- [x] Logs modération, arrivées/départs, messages supprimés/édités
- [x] Logs rôles, salons, vocaux, bans (avec exécuteur via audit log)

## Phase 5 — AutoMod
- [x] AntiSpam, AntiFlood, AntiLink, AntiInvite, AntiMassMention, AntiCaps, BadWords, AntiRepeat, AntiEmojiSpam, AntiDuplicate
- [x] Configuration par serveur (seuils, sanctions, salons/rôles ignorés) via `/automod`

## Phase 6 — Sécurité
- [x] AntiRaid (vague d'arrivées, âge de compte, anti-bot)
- [x] Détection d'activité destructrice (suppression salons/rôles, bans en masse via audit log)
- [x] Whitelist (users/rôles) vérifiée avant sanction
- [x] Lockdown d'urgence + restauration d'état (`/lockdown`, `/lock`)

## Phase 7 — Community
- [x] Tickets (setup, panel, claim, transcript, add/remove, rename, fermeture)
- [x] ModMail (DM → staff, reply, close)
- [x] Giveaways (persistants, participation par bouton, fin auto, reroll)
- [x] Suggestions (votes 👍/👎, approve/deny)
- [x] Role menus (self-assign, select menu persistant)
- [x] Rappels persistants (`/reminder`, survivent au redémarrage)

## Phase 8 — Advanced tools
- [x] Embed builder (`/embed` : modal + options)
- [x] Commandes personnalisées (`/custom` + `/tag`, variables)
- [x] Backups serveur (`/backup` create/list/info/delete/restore) + autobackup
- [x] Vocaux temporaires (`/tempvoice` join-to-create)
- [x] Actions de masse (`/massrole`, par lots)

## Fondations préparées pour plus tard (non développées volontairement)
- [ ] Dashboard web · API · IA · statistiques avancées · SaaS/abonnements · plugins
