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
  isSafeArg,
  id: 'cmd',
  guildOnly: false,
  async execute(interaction, client) {
    const [, command, action, ...args] = interaction.customId.split(':');

    // Les customId sont contrôlés par le client : on refuse tout argument pouvant
    // détourner une route de l'API Discord (« ../members/<id> », « a/b », « %2F »…).
    if (args.some((a) => !isSafeArg(a)) || (interaction.values ?? []).some((v) => isPrototypeKey(v))) {
      throw new UserError('Ce bouton est invalide.');
    }

    if (command === '_') return commonAction(interaction, action, args);

    const cmd = client.commands.get(command);
    // hasOwn : « constructor », « toString »… ne doivent jamais être résolus.
    const handler = cmd?.buttons && Object.hasOwn(cmd.buttons, action) ? cmd.buttons[action] : null;
    if (typeof handler !== 'function') {
      throw new UserError('Ce bouton n\'est plus disponible. Relancez la commande.');
    }
    if (cmd.guildOnly !== false && !interaction.inGuild()) {
      throw new UserError('Cette action n\'est disponible que sur un serveur.');
    }
    return handler(interaction, client, args);
  },
};

/** Argument de bouton sûr : pas de séparateur de chemin ni de « .. », longueur bornée. */
/** Noms hérités d'Object.prototype (« constructor », « __proto__ »…) : jamais une clé de catalogue valide. */
function isPrototypeKey(value) {
  return typeof value === 'string' && (value === '__proto__' || Object.prototype.hasOwnProperty.call(Object.prototype, value));
}

function isSafeArg(arg) {
  return typeof arg === 'string' && arg.length <= 100 && !/[\/\\?#%]|\.\./.test(arg) && !isPrototypeKey(arg);
}

async function commonAction(interaction, action, args) {
  if (action === 'delete') {
    const [ownerId] = args;
    if (!/^\d{17,20}$/.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
    const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
    if (interaction.user.id !== ownerId && !canManage) {
      throw new UserError('Seule la personne qui a lancé la commande (ou un modérateur) peut supprimer ce message.');
    }
    await interaction.deferUpdate();
    // deleteReply passe par le webhook de l'interaction : fonctionne même sans accès
    // au salon (réponses envoyées par l'interaction). Sinon, suppression classique.
    try {
      await interaction.deleteReply();
    } catch {
      await interaction.message.delete().catch(() => {
        throw new UserError('Je ne peux pas supprimer ce message.');
      });
    }
    return;
  }
  // « noop » et actions inconnues : on acquitte silencieusement.
  await interaction.deferUpdate().catch(() => {});
}
