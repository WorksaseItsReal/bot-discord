# Système de design — Inspecteur Gadget

Toutes les réponses du bot partagent un seul langage visuel, défini dans
`src/utils/ui.js`. Ce document est la référence : toute commande doit s'y conformer.

## 1. Principes

1. **Tout est un embed.** Aucune réponse en texte brut. Seules exceptions imposées par Discord :
   les sondages natifs et les formulaires (modals). Un `content` n'est utilisé qu'à côté d'un embed,
   pour une mention qui doit notifier (ex : ouverture de ticket).
2. **Une information, un endroit.** La phrase clé va dans la description ; les métadonnées vont dans des champs.
3. **Chaque bouton a une utilité réelle.** Pas de bouton décoratif.
4. **Cohérence avant originalité.** Mêmes couleurs, mêmes icônes, même structure partout.

## 2. Anatomie d'une carte

```
┃ 🔨  Modération                 ← section : la catégorie (author)
┃ ⛔  Membre banni               ← titre : icône + ce qui s'est passé
┃ @Bob ne pourra plus revenir.   ← description : 1 à 3 lignes, l'essentiel
┃ 👤 Membre   🛡️ Modérateur  ⏱️ Durée     ← champs inline, alignés par 3
┃ 📝 Raison                      ← champ pleine largeur pour les textes longs
┃ Gadget • Sanction #12 · 12:04  ← pied de page de marque (automatique)
[ 🔓 Débannir ] [ 📜 Sanctions ] [ 🗑️ ]   ← boutons d'action
```

```js
const { card, field, wide, ICONS, actionButton, buttonRows } = require('../../utils/ui');

const embed = card({
  tone: 'danger',
  section: 'moderation',          // clé de catégorie (utils/categories.js) ou { emoji, label }
  icon: ICONS.ban,
  title: 'Membre banni',
  description: `${user} ne pourra plus rejoindre le serveur.`,
  fields: [
    field(ICONS.user, 'Membre', userLine(user)),
    field(ICONS.moderator, 'Modérateur', `${interaction.user}`),
    field(ICONS.duration, 'Durée', 'Définitive'),
    wide(ICONS.reason, 'Raison', reason ?? '*Aucune raison fournie*'),
  ],
  footer: `Sanction #${id}`,
});
```

- `card()` tronque tout aux limites Discord, aligne les champs inline par 3 et ajoute le pied de page.
- Un champ vide affiche `—`.

## 3. Couleurs (`TONES`) — jamais de code couleur en dur

| Ton | Usage |
| --- | --- |
| `brand` | Identité, informations générales, fiches (serveur, membre, aide). |
| `neutral` | Panneaux discrets, listes, textes mis en forme. |
| `info` | Aide, astuces, état, résultats d'outils. |
| `success` | Action réussie, levée de sanction (unban, unmute…). |
| `warning` | Avertissement, confirmation demandée, avertissement de membre (warn). |
| `caution` | Sanction intermédiaire : timeout, mute, kick, verrouillage. |
| `danger` | Erreur, bannissement, suppression, alerte de sécurité. |
| `fun` | Jeux et divertissement. |
| `celebrate` | Giveaways, gagnants, félicitations. |
| `gold` | Classements, mises en avant. |

Exception : une couleur choisie par l'utilisateur (rôle, projet, `/couleur`, `/embed`) se passe en nombre : `tone: 0xff8800`.

## 4. Icônes (`ICONS`)

Un concept = un emoji, partout. Toujours `ICONS.xxx`, jamais un emoji différent pour le même concept.
Exemples : `user 👤`, `moderator 🛡️`, `reason 📝`, `duration ⏱️`, `date 📅`, `id 🆔`, `channel 💬`, `role 🎭`,
`count 🔢`, `link 🔗`, `stats 📊`, `list 📋`, `refresh 🔄`, `delete 🗑️`. Liste complète dans `ui.js`.

## 5. Retours d'action : `status`

Pour un retour court (succès, erreur, info), utilisez les cartes compactes :

```js
status.ok('Rôle ajouté à @Bob.')                      // ✅ vert
status.fail('Ce membre est introuvable.')             // ❌ rouge (les UserError le font déjà)
status.warn('Aucune option fournie.')                 // ⚠️ ambre
status.note('Aucun rappel en cours.', 'Rappels')      // ℹ️ bleu, titre optionnel
```

Les anciens `embeds.success/error/warning/info` passent déjà par `status`.

## 6. Textes

- Phrases courtes, vouvoiement, français correct, ponctuation française.
- Mettre en **gras** la donnée clé (nom, nombre), pas la phrase entière.
- Identifiants en police fixe : `code(id)`. Utilisateurs : `userLine(user)` (mention + pseudo).
- Dates : timestamps Discord (`discordTimestamp(ms, 'D')` + `'R'` en dessous).
- Petites précisions sous un texte : `subtext('…')` (ligne grise).
- Listes : `bullets([...])`, au-delà de 10 éléments → pagination (`utils/pagination.js`).

## 7. Boutons

| Helper | Usage |
| --- | --- |
| `actionButton({ command, action, args, label, emoji, style })` | Action persistante routée vers `module.exports.buttons[action]` de la commande. |
| `linkButton(label, url, emoji)` | Ouvre une URL (avatar, message, site…). |
| `deleteButton(ownerId)` | 🗑️ supprime le message (auteur ou modérateur). |
| `buttonRows(...buttons)` | Range les boutons par 5, ignore les `null`. |

Règles :

- **Le bouton 🗑️ est ajouté automatiquement** à la première réponse publique de chaque commande.
  Si un bouton RÉÉDITE le message (actualiser, relancer…), incluez vous-même `deleteButton(ownerId)`
  dans le nouveau rendu, sinon il disparaît. Désactivation possible : `autoDelete: false` sur la commande.
- Style : `Primary` pour l'action principale, `Success`/`Danger` pour une action positive/destructive,
  `Secondary` pour le reste. Une seule action `Primary` par message.
- Libellés courts (1 à 2 mots) avec emoji : `🔄 Actualiser`, `🎲 Relancer`, `📜 Sanctions`.
- L'état utile est encodé dans `args` (ex : identifiant du membre, de l'auteur). customId ≤ 100 caractères.
- Bouton réservé à l'auteur : `assertInvoker(interaction, ownerId)` (`utils/buttonGuard.js`).
- Action sensible : revérifiez les permissions dans le handler (`interaction.memberPermissions.has(...)`).

```js
module.exports = {
  data: …,
  async execute(interaction) {
    await interaction.reply(render(interaction.user.id));
  },
  buttons: {
    // cmd:ping:refresh:<ownerId>
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.update(render(ownerId));
    },
  },
};
```

## 8. Vérifications automatiques

`tests/design.test.js` échoue si :
- un fichier crée un `EmbedBuilder` ou appelle `.setColor()` hors de `utils/ui.js` (sauf le constructeur d'embeds libres `/embed`) ;
- un `actionButton` vise une action qui n'existe pas dans `buttons` de la commande ;
- une réponse d'interaction est envoyée en texte brut.
