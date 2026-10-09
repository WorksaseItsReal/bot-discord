<div align="center">

# 🕵️ Inspecteur Gadget

**Le bot Discord tout-en-un pour administrer, modérer, sécuriser et animer votre serveur.**

92 slash commands · 4 menus contextuels · plus de 200 actions · embeds soignés · multi-serveurs · 100 % en français

![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-embarqu%C3%A9-003B57?logo=sqlite&logoColor=white)
![Tests](https://img.shields.io/badge/tests-1000%2B%20verts-57F287)
![Licence](https://img.shields.io/badge/licence-MIT-lightgrey)

</div>

---

## Sommaire

- [Points forts](#-points-forts)
- [Projets : la vitrine de votre serveur](#-projets--la-vitrine-de-votre-serveur)
- [AutoMod](#-automod)
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
| 🛡️ **Sécurité** | Tableau de bord `/antiraid` (vagues d'arrivées, comptes récents, suppressions et expulsions en masse, simulation), whitelist, verrouillage d'urgence. |
| 👋 **Accueil** | Bienvenue et départ personnalisés, rôles automatiques, vérification anti-robot par bouton, suivi des invitations. |
| 📈 **Niveaux** | XP par message et en vocal, rôles de récompense, classement, tableau de bord `/niveaux`. |
| 🎫 **Communauté** | Tickets configurables avec `/tickets` (motifs, panneau, notes de satisfaction, statistiques), candidatures, ModMail avec transcript, giveaways à conditions, starboard, annonces programmées, anniversaires, suggestions, menus de rôles, sondages. |
| 🎲 **Animation** | Mini-jeux `/jeu` (morpion, puissance 4, pendu, quiz), économie virtuelle avec boutique (désactivée par défaut), absences `/afk` et alertes de mots-clés. |
| 📊 **Statistiques** | Activité du serveur sans jamais enregistrer le contenu des messages, membres inactifs et actions groupées. |
| 🔊 **Vocaux temporaires** | Panneau de contrôle dans le chat du vocal : verrou, nom, limite, expulsion, transfert, débit, région. |
| 📋 **Logs** | 9 catégories et 38 événements activables un par un, tableau de bord `/logs` et création automatique des salons. |
| 💾 **Backups** | Sauvegarde et restauration de la structure du serveur, permissions comprises. |
| 🎨 **Design soigné** | Chaque réponse est un embed cohérent, avec des boutons utiles et un bouton 🗑️ sur les réponses publiques. |
| 🧠 **Fiable** | Aucune double réponse, actions protégées contre les double clics, permissions revérifiées par le bot, boutons protégés contre la falsification, erreurs expliquées en français, plus de 1 000 tests automatiques dont des tests de bout en bout sur le vrai discord.js, CI GitHub Actions. |

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
| 🔨 Modération | Sanctions, levées de sanction, bans, kicks et timeouts faits hors du bot (avec leur auteur), tickets et leurs notes, signalements, candidatures, consultations de `/snipe`, actions groupées sur les inactifs |
| 💬 Messages | Suppressions, modifications, suppressions en masse (transcript `.txt` joint) |
| 👥 Membres | Arrivées (avec l'invitation utilisée), départs, rôles ajoutés/retirés et pseudos (avec l'auteur du changement), boosts, vérifications réussies |
| 🎭 Rôles | Créations, suppressions, modifications (permissions comprises) |
| 🗂️ Salons | Salons et fils créés, supprimés, modifiés |
| 🔊 Vocal | Connexions, déconnexions, changements de salon |
| 🛡️ Sécurité | Alertes AntiRaid, verrouillages, levées automatiques (verrou, mode lent) |
| 🤖 AutoMod | Messages filtrés, pseudos renommés et sanctions automatiques |
| 🏠 Serveur | Paramètres du serveur, emojis ajoutés/supprimés, administration de l'économie (soldes, boutique, réglages) |

> L'auteur des changements de rôles, de pseudos et des actions manuelles provient du journal d'audit :
> donnez au bot la permission **Voir les logs du serveur**.

---

## 🔨 Modération et administration

**Sanctions** — `/warn`, `/mute`, `/timeout`, `/kick`, `/ban`, `/tempban` et **`/softban`** (ban puis débannissement immédiat : le membre est expulsé et ses messages des 1 à 7 derniers jours effacés ; la sanction reste dans son casier). Chaque sanction a sa fiche (`/sanctions voir`), un historique filtrable et des notes internes. Les strikes peuvent **expirer** : `/settings moderation decroissance:<jours>` (0 = jamais) ; les plus anciens restent dans l'historique mais ne comptent plus pour les paliers.

**Levées automatiques** — `/lock duree`, `/slowmode pendant` et `/lockdown enable duree` acceptent une durée (`30m`, `2h`, `1d`) : à l'échéance, le salon est déverrouillé, le mode lent d'avant rétabli ou le lockdown levé, même après un redémarrage (log Sécurité).

**`/modstats`** (Exclure temporairement des membres) — activité de l'équipe sur 7, 30 ou 90 jours, ou d'un seul modérateur : sanctions par modérateur et par type, tendance, raisons fréquentes, signalements traités, tickets pris en charge.

**Gestion du serveur depuis Discord** — `/role modifier` (nom, couleur, affichage séparé, mentionnable) ; `/channel creer|supprimer|cloner|renommer|sujet|nsfw` (Gérer les salons ; suppression confirmée, copie sans les messages) ; `/emoji ajouter|supprimer|renommer` (Gérer les expressions, pour vous comme pour le bot ; image de 256 Ko au plus ou lien d'un emoji Discord).

> **Changement d'usage** : l'affichage d'un salon ou d'un emoji passe désormais par **`/channel info`** et **`/emoji info`**. Relancez `npm run deploy` après la mise à jour.

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

**Planifié** — `/role temporaire` donne un rôle pour une durée limitée (retiré à l'échéance, rendu si le membre revient avant la fin ; `/role temporaires` pour lister, retirer, prolonger). `/annonce programmer` publie une annonce (titre, message, couleur, image, rôle) à une date (`14h30`, `25/12 18h`, `+2h`), une fois ou chaque jour/semaine/mois ; `/annonce liste` pour envoyer tout de suite ou supprimer. `/anniversaire definir|retirer|liste` et `/anniversaire config` (salon, message, rôle porté 24 h, fuseau, heure) fêtent les anniversaires une fois par jour et par membre, sans jamais afficher l'âge sans accord.

**Candidatures, notes et conditions** — `/candidatures` (Gérer le serveur) : jusqu'à 5 formulaires (1 à 5 questions, réponse courte ou longue), un panneau public « Postuler » et les réponses en carte dans un salon du staff (rôle mentionné facultatif). Le staff (Gérer le serveur ou Gérer les rôles) accepte (rôles donnés et MP), refuse (motif en MP) ou ouvre un entretien (ticket, sinon fil privé dans le salon du panneau) ; une seule décision par candidature, même sur double clic. Une candidature en attente par membre et par formulaire, avec un délai réglable entre deux ; les membres suivent les leurs avec `/candidature statut|retirer`. À la fermeture d'un ticket, son auteur peut le **noter** de 1 à 5 ⭐ en MP (commentaire facultatif, notation désactivable) ; la vue « Statistiques » de `/tickets` affiche la note moyenne, les tickets et notes par membre du staff et les délais moyens de prise en charge et de fermeture. Les **giveaways** acceptent `niveau_min`, `invitations_min` et `anciennete_min` (jours sur le serveur), affichés sur la carte et vérifiés à l'inscription comme au tirage.

**Sécurité renforcée** — l'AntiRaid surveille aussi les **expulsions massives** (seuil « Expulsions », désactivé par défaut, 5 en préréglage Strict), faites à la main ou via le bot. `/backup restore` remet les rôles recréés dans l'ordre et peut, sur option, rétablir les permissions des salons existants. `/tickets` peut archiver les **pièces jointes** avec les transcripts (8 Mo par fichier, 24 Mo au total).

---

## 🙋 Outils des membres

Activables un par un pour le serveur avec **`/alertes config`** (Gérer le serveur) ; tous actifs par défaut.

- **`/afk [raison]`** signale une absence : le pseudo reçoit le préfixe « [AFK] » (si la hiérarchie le permet ; rétabli au retour), ceux qui vous mentionnent reçoivent une réponse courte (raison et durée, supprimée après 10 s, au plus une fois par 30 s et par salon) et votre prochain message met fin à l'absence.
- **`/alertes ajouter|retirer|liste|pause`** et **`/alertes bloquer salon|membre`** : jusqu'à 10 mots-clés (3 à 40 caractères, mot entier, majuscules et accents ignorés). Quand un autre membre en écrit un dans un salon que vous pouvez lire, vous recevez un MP (auteur, salon, extrait, lien), au plus une fois toutes les 5 minutes par salon et jamais si vous y avez écrit depuis moins de 5 minutes. Les alertes se mettent en pause d'elles-mêmes si vos MP sont fermés.
- **`/snipe supprime|modifie [salon]`** (Gérer les messages) montre le dernier message supprimé ou modifié d'un salon, gardé 10 minutes en mémoire seulement ; jamais les messages des bots, ceux filtrés par l'AutoMod ni ceux des salons ignorés par les logs. Chaque consultation est journalisée (logs Modération).

---

## 🪙 Économie et mini-jeux

**Économie** (désactivée par défaut) — une monnaie virtuelle propre au serveur, **sans valeur réelle**. Avec **`/eco`**, les membres consultent leur `solde`, réclament une récompense `quotidien` (bonus de série) et `hebdo`, utilisent `travail`, se paient entre eux avec `payer` (taxe facultative, confirmation au-delà d'un seuil), achètent des objets ou des rôles dans la `boutique` (stock facultatif, protection contre le double achat, remboursement si le rôle ne peut pas être donné), consultent `inventaire`, `classement` et `historique`, et jouent à `pile-ou-face` ou à la `machine-a-sous` (mise plafonnée, délai entre deux parties, espérance négative réglable). Les soldes ne deviennent jamais négatifs. Le tableau de bord **`/economie`** (Gérer le serveur) règle la monnaie, les gains, la taxe, les plafonds, les jeux et la boutique (25 articles), permet de donner, retirer, définir ou réinitialiser des soldes et affiche des statistiques ; tout est journalisé (logs Serveur).

> ⚠️ **Jeux d'argent** : tant que l'économie est désactivée (par défaut), pile ou face et machine à sous sont inaccessibles. Une fois l'économie activée, ces deux jeux sont **actifs** : sur un serveur qui accueille des mineurs, désactivez-les dans `/economie` › Jeux.

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
| `/channel` | `info` : informations d'un salon ; `creer`, `supprimer`, `cloner`, `renommer`, `sujet`, `nsfw` 🔒 (Gérer les salons). |
| `/avatar` · `/banniere` | Avatar ou bannière en grand, avec liens de téléchargement. |
| `/emoji` | `info` : emoji en grand, avec son identifiant ; `ajouter`, `supprimer`, `renommer` 🔒 (Gérer les expressions). |
| `/membres` | Compteur de membres et membres en ligne. |
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
<summary><b>🤖 AutoMod & 🛡️ Sécurité</b> (4) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/automod` | Tableau de bord interactif : tout l'AutoMod se configure avec des boutons, menus et formulaires. |
| `/antiraid` | Tableau de bord : vagues d'arrivées, comptes récents et bots, suppressions en masse, alertes, whitelist, préréglages, simulation. |
| `/whitelist` | Membres et rôles de confiance, ignorés par l'AntiRaid. |
| `/lockdown` | Verrouillage d'urgence de tout le serveur (durée facultative, levée automatique), puis restauration. |

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
<summary><b>🧰 Outils</b> (13)</summary>

| Commande | Description |
| --- | --- |
| `/embed` 🔒 | Créer et envoyer des embeds personnalisés via un formulaire. |
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
<summary><b>⚙️ Configuration</b> (7) 🔒</summary>

| Commande | Description |
| --- | --- |
| `/logs` | Tableau de bord des logs : salons, événements, création automatique des salons. |
| `/settings` | Vue d'ensemble, raccourcis vers les tableaux de bord ; `moderation` règle DM, confirmations, raison obligatoire, strikes, paliers et leur décroissance, rôle muet. |
| `/diagnostics` | Analyse la configuration et signale les permissions manquantes. |
| `/backup` | Sauvegarde, restauration (ordre des rôles, permissions sur option) et sauvegarde automatique de la structure du serveur. |
| `/compteurs` | Salons de statistiques (membres, bots, boosts…) mis à jour automatiquement. |
| `/health` | État technique du bot : latence, base de données, services. |
| `/projet config` | Réglages du module projets. |

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

Le bot demande 10 intents (`src/config/intents.js`). Dans le Developer Portal, onglet **Bot**, activez les deux intents privilégiés **Server Members Intent** et **Message Content Intent** ; les huit autres ne sont pas privilégiés et n'ont rien à activer. **Presence Intent** n'est pas utilisé (le compteur « En ligne » de `/compteurs` n'est donc pas proposé).

| Intent | Utilisé pour |
| --- | --- |
| `Guilds` | Serveurs, salons, rôles. |
| `GuildMembers` 🔒 | Arrivées et départs, hiérarchie, AntiRaid, contrôle des pseudos, membres inactifs. |
| `GuildModeration` | Bannissements et journal d'audit : logs des actions manuelles, AntiRaid. |
| `GuildMessages` | Logs de messages, AutoMod, XP, statistiques, AFK, alertes, snipe, réponses automatiques, sticky. |
| `MessageContent` 🔒 | Contenu des messages : AutoMod, logs d'édition, alertes de mots-clés, réponses automatiques, snipe. |
| `GuildVoiceStates` | Vocaux temporaires, gestion et logs vocaux, XP et statistiques vocales. |
| `DirectMessages` | ModMail. |
| `GuildExpressions` | Logs des emojis. |
| `GuildInvites` | Suivi des invitations (qui a invité qui). |
| `GuildMessageReactions` | Starboard. |

### Inviter le bot

Une fois le bot démarré, la commande `/invite` donne un lien d'invitation qui demande ces 23 permissions (celles que `/diagnostics` contrôle) :
Gérer le serveur · Voir les salons · Envoyer des messages · Envoyer des messages dans les fils · Intégrer des liens · Joindre des fichiers · Voir l'historique des messages · Ajouter des réactions · Utiliser des emojis externes · Gérer les messages · Gérer les salons · Gérer les rôles · **Gérer les pseudos** (AFK, AutoMod des pseudos, `/pseudo`) · Gérer les fils · Expulser des membres · Bannir des membres · Exclure temporairement des membres · Rendre muet · Mettre en sourdine · Déplacer des membres · Voir les logs du serveur · Créer des sondages · Se connecter.

Le lien ne demande **pas** ces permissions, à donner à la main au rôle du bot si vous utilisez la fonctionnalité :

| Permission | Nécessaire pour |
| --- | --- |
| Gérer les expressions | `/emoji ajouter`, `supprimer`, `renommer`. |
| Créer des fils privés | Entretiens de candidature en fil privé (quand les tickets ne sont pas configurés). |
| Mentionner @everyone, @here et tous les rôles | Annonces programmées qui mentionnent @everyone, rôle non mentionnable notifié par les signalements ou les candidatures. |

Placez ensuite le rôle du bot **au-dessus** des rôles qu'il doit gérer : Discord interdit d'agir sur un rôle plus haut que le sien (ni sur le pseudo d'un membre placé au-dessus).

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
3. **`/automod`** : choisissez le préréglage **Équilibré**, puis synchronisez l'**AutoMod de Discord** ; ensuite **`/antiraid`** → préréglage **Équilibré** et activation.
4. **`/bienvenue`** : salon d'accueil, rôles automatiques et, si besoin, vérification par bouton.
5. **`/tickets`** : catégorie, staff, motifs, puis **Publier le panneau**.
6. **`/niveaux`** et **`/tempvoice config`** si vous voulez l'XP et les vocaux temporaires.
7. **`/projet config`** règle le module projets, puis **`/projet creer`** crée votre premier projet.
8. Selon vos besoins : **`/signalements`**, **`/candidatures`**, **`/communaute`**, **`/economie`** (désactivée par défaut), **`/statistiques reglages`** et **`/alertes config`**.

> Donnez au bot **Gérer les rôles** (rôle placé au-dessus des rôles à attribuer), **Gérer les salons**, **Déplacer des membres** et **Voir les logs du serveur** : `/invite` génère un lien avec toutes ces permissions.

---

## 🛡️ Fiabilité

Chaque interaction passe par une couche de sûreté commune, avant même d'atteindre la commande :

- **Aucune double réponse** : une réponse arrivée après un délai remplace le message « réfléchit… » au lieu de provoquer une erreur.
- **Embeds toujours valides** : les textes trop longs sont coupés proprement au lieu de faire échouer la réponse.
- **Vérifications avant exécution** : commande disponible sur un serveur uniquement, permission déclarée par la commande revérifiée par le bot (un rôle autorisé dans Paramètres du serveur › Intégrations ne la contourne pas), permissions du bot présentes, délai anti-spam respecté.
- **Erreurs compréhensibles** : « il me manque la permission Bannir des membres » plutôt qu'une erreur générique. Les erreurs imprévues affichent un **code de référence** retrouvable dans les logs.
- **Double clics** : une action (levée de sanction, achat, décision de candidature, envoi d'annonce…) n'est exécutée qu'une fois, même sur des clics simultanés.
- **Résistance aux pannes** : bans temporaires, giveaways, verrous à durée, rôles temporaires et annonces programmées repris après un redémarrage, reconnexion automatique, arrêt propre et borné.

```bash
npm test        # plus de 1 000 tests, dont la validation des 96 commandes (menus contextuels compris) contre les limites de Discord
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
| `/emoji ajouter` : « Il me manque la permission Gérer les expressions » | Cette permission n'est pas dans le lien de `/invite` : donnez-la au rôle du bot. |
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
