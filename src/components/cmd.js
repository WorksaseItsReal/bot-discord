'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { UserError } = require('../core/errors');

/**
 * Routeur des boutons d'action des commandes (persistants, sans état serveur).
 *
 *   customId : cmd:<commande>:<action>:<arg1>:<arg2>…
 *   → client.commands.get(<commande>).buttons[<action>](interaction, client, args)
 *
 * Actions communes (commande « _ ») :
 *   cmd:_:delete:<ownerId>  supprime le message (auteur ou « Gérer les messages »)
 *   cmd:_:noop:<x>          étiquette désactivée (jamais cliquable)
 */
module.exports = {
  id: 'cmd',
  guildOnly: false,
  async execute(interaction, client) {
    const [, command, action, ...args] = interaction.customId.split(':');

    if (command === '_') return commonAction(interaction, action, args);

    const cmd = client.commands.get(command);
    const handler = cmd?.buttons?.[action];
    if (typeof handler !== 'function') {
      throw new UserError('Ce bouton n\'est plus disponible. Relancez la commande.');
    }
    if (cmd.guildOnly !== false && !interaction.inGuild()) {
      throw new UserError('Cette action n\'est disponible que sur un serveur.');
    }
    return handler(interaction, client, args);
  },
};

async function commonAction(interaction, action, args) {
  if (action === 'delete') {
    const [ownerId] = args;
    const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
    if (interaction.user.id !== ownerId && !canManage) {
      throw new UserError('Seule la personne qui a lancé la commande (ou un modérateur) peut supprimer ce message.');
    }
    await interaction.deferUpdate();
    await interaction.message.delete().catch(() => {
      throw new UserError('Je ne peux pas supprimer ce message.');
    });
    return;
  }
  // « noop » et actions inconnues : on acquitte silencieusement.
  await interaction.deferUpdate().catch(() => {});
}
