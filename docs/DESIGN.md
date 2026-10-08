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

- `card()` tronque chaque élément à sa limite Discord (titre 256, description 4096, 25 champs,
  nom 256 / valeur 1024, pied de page 2048), aligne les champs inline par 3 et ajoute le pied de page.
- `card()` ne garantit **pas** le total de 6000 caractères d'un message. Ce total n'est assuré
  automatiquement que pour les **réponses d'interaction** (`reply`, `editReply`, `followUp`, `update`),
  qui passent par `sanitizeEmbeds` (`core/interactionSafety.js`). Un envoi direct (`channel.send`,
  `message.edit`, webhook) n'est pas protégé : passez ses embeds par `fitEmbeds(embeds)` (`ui.js`), qui
  réduit les derniers champs puis les descriptions jusqu'à passer sous la limite. Pour un contenu saisi
  par l'utilisateur (ex : `/embed`), refusez plutôt avec un message précis que de tronquer en silence.
- Un champ vide affiche `—`. Espaceur de grille : `blank()` (champ invisible, ajouté automatiquement
  par l'alignement par 3).

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
status.wait('Confirmé, exécution en cours…')          // ⏳ neutre : action longue en cours (message par défaut : « Traitement en cours… »)
```

Chaque helper accepte `(message, title?, extra?)` ; `extra` est passé à `card()` (ex : `{ footer }`).

`utils/embeds.js` ne fournit plus de cartes de statut : il n'en reste que `errorReply(description, { title, footer })`,
une réponse d'erreur éphémère toute prête (`{ embeds: [status.fail(…)], ephemeral: true }`), utilisée par le routeur
d'interactions. Le reste de ce module, ce sont des briques (`truncate`, `progressBar`, `listOrMore`, `LIMITS`,
`sanitizeEmbeds`, marque du pied de page) : pour une carte, passez toujours par `ui.js`.

## 6. Textes

- Phrases courtes, vouvoiement, français correct, ponctuation française.
- Mettre en **gras** la donnée clé (nom, nombre), pas la phrase entière.
- Identifiants en police fixe : `code(id)`. Utilisateurs : `userLine(user)` (mention + pseudo).
- Dates : timestamps Discord (`discordTimestamp(ms, 'D')` + `'R'` en dessous).
- Petites précisions sous un texte : `subtext('…')` (ligne grise).
- Paires « libellé · valeur » dans une description : `kv([['Seuil', '10'], ['Fenêtre', '10 s']])`
  (libellé en gras, valeur vide → `—`, entrées `null`/`false` ignorées).
- Listes : `bullets([...])`, au-delà de 10 éléments → pagination (`utils/pagination.js`).

## 7. Boutons

| Helper | Usage |
| --- | --- |
| `actionButton({ command, action, args, label, emoji, style })` | Action persistante routée vers `module.exports.buttons[action]` de la commande. |
| `linkButton(label, url, emoji)` | Ouvre une URL (avatar, message, site…). |
| `deleteButton(ownerId)` | 🗑️ supprime le message (auteur ou modérateur). |
| `labelButton(label)` | Étiquette grise désactivée, jamais cliquable (ex : « Page 2/5 ») ; customId `cmd:_:noop:…`. |
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

`tests/design.test.js` analyse le **texte** des sources de `src/` (pas leur exécution) et échoue si :
- un fichier contient `new EmbedBuilder(` ou `.setColor(` hors de `utils/ui.js` et du constructeur
  d'embeds libres (`commands/utility/embed.js`, `components/embedbuilder.js`) ;
- un appel `.reply(`, `.editReply(`, `.followUp(` ou `.update(` a pour premier argument une chaîne
  littérale (texte brut). Un texte passé par variable n'est pas détecté ici ; la couche
  `core/interactionSafety.js` le convertit de toute façon en carte à l'exécution ;
- une route `cmd:<commande>:<action>` **écrite en dur** ne correspond à aucun handler
  `buttons[action]` de la commande. Sont contrôlés : les appels `actionButton({ command: '…', action: '…' })`,
  même écrits sur plusieurs lignes, et les customId littéraux (`'cmd:x:y'`, `` `cmd:x:y:${arg}` ``) de boutons,
  menus et modals. Un segment calculé (`` `cmd:x:${action}` ``, `action` passé par variable) est ignoré :
  ces routes-là se vérifient par les tests propres à la commande.

Il vérifie aussi `card()` (couleur, alignement par 3, troncature par élément) et la limite de
100 caractères du customId d'`actionButton`. Les limites d'ensemble d'une réponse (6000 caractères,
5 rangées, customId uniques) sont contrôlées dans les tests de rendu de chaque commande.
