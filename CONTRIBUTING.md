# Contribuer

Merci de garder l'architecture **modulaire** et les commandes **fines**.

## Mise en place

```bash
npm install
cp .env.example .env   # renseignez au moins DISCORD_TOKEN et CLIENT_ID
npm run check          # vérifie le câblage sans se connecter
npm test               # suite de tests
```

## Ajouter une commande

1. Créez `src/commands/<catégorie>/<nom>.js` :

```js
'use strict';
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { successReply } = require('../../utils/embeds');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('exemple')
    .setDescription('Une commande d\'exemple.')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
  async execute(interaction, client) {
    // logique métier -> client.services.*
    await interaction.reply(successReply('Ça marche !'));
  },
};
```

2. La commande est chargée automatiquement (aucun registre à éditer).
3. Déployez : `npm run deploy` (avec `DEV_GUILD_ID` pour un enregistrement instantané).

## Ajouter un service

- Créez `src/services/MonService.js`, instanciez-le dans `GadgetClient.bootstrap()` et exposez-le via `this.services`.
- Ne mettez **jamais** de SQL dans une commande : passez par un repository.

## Ajouter de la persistance

- Ajoutez une migration à la fin du tableau `migrations` dans `src/database/schema.js` (nouvel `id`).
- Créez un repository dans `src/database/repositories/`.

## Style de code

- JavaScript moderne, `async/await`, fonctions courtes, noms explicites.
- Pas de logique métier dans les handlers Discord.
- Commentaires seulement quand ils apportent de la valeur.

## Avant d'ouvrir une PR

- [ ] `npm run check` passe.
- [ ] `npm test` passe (ajoutez des tests pour la logique critique).
- [ ] `ROADMAP.md` / `CHANGELOG.md` mis à jour si pertinent.
