'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, ICONS, userLine, subtext } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { moduleConfig, SECUR_BOUNDS } = require('../../utils/secur');

const BULK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Taille à partir de laquelle une purge compte pour le module Secur messagePurge (même calcul
 * que son classify, src/services/secur/modules/messages.js : 20 par défaut, borné). Pur.
 */
function purgeMinimum(cfg) {
  const raw = Number(moduleConfig(cfg, 'messagePurge').minMessages);
  const [min, max] = SECUR_BOUNDS.minMessages;
  return Math.min(max, Math.max(min, Number.isInteger(raw) ? raw : 20));
}

module.exports = {
  category: 'moderation',
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Supprime en masse des messages récents du salon.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) =>
      o.setName('nombre').setDescription('Nombre de messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100),
    )
    .addUserOption((o) => o.setName('membre').setDescription('Ne supprimer que les messages de ce membre')),

  purgeMinimum,

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const amount = interaction.options.getInteger('nombre');
    const target = interaction.options.getUser('membre');
    // Salon non résolu (non mis en cache, contexte inattendu) : refus explicite plutôt qu'un crash.
    if (!interaction.channel?.messages?.fetch) throw new UserError('Impossible d\'accéder à ce salon. Réessayez dans un salon textuel du serveur.');
    await interaction.deferReply({ ephemeral: true });

    let messages = await interaction.channel.messages.fetch({ limit: 100 });
    // Discord ne peut supprimer en masse que les messages de moins de 14 jours
    const cutoff = Date.now() - BULK_MAX_AGE_MS;
    messages = messages.filter((m) => m.createdTimestamp > cutoff);
    if (target) messages = messages.filter((m) => m.author.id === target.id);
    const toDelete = [...messages.values()].slice(0, amount);
    if (!toDelete.length) throw new UserError('Aucun message supprimable trouvé (les messages de plus de 14 jours ne peuvent pas être supprimés en masse).');

    // Purge signée du bot dans le journal d'audit (73) : sans pré-contrôle, elle échapperait au
    // module Secur messagePurge. Comptée au nom de l'auteur, comme une purge faite à la main.
    const min = purgeMinimum(client.services.config.get(interaction.guildId));
    if (toDelete.length >= min) client.services.secur?.assertAllowed?.(interaction, 'messagePurge');

    const deleted = await interaction.channel.bulkDelete(toDelete, true);
    const n = deleted.size;
    await interaction.editReply({
      embeds: [
        card({
          tone: 'success',
          section: 'moderation',
          icon: ICONS.delete,
          title: 'Salon nettoyé',
          description: [
            `**${n}** message${n > 1 ? 's' : ''} supprimé${n > 1 ? 's' : ''} dans ${interaction.channel}.`,
            n < amount ? subtext(`${amount} demandés : seuls les messages de moins de 14 jours peuvent être supprimés en masse.`) : null,
          ],
          fields: [
            field(ICONS.count, 'Supprimés', `**${n}** / ${amount}`),
            field(ICONS.channel, 'Salon', `${interaction.channel}`),
            field(ICONS.user, 'Filtre', target ? userLine(target) : 'Tous les membres'),
          ],
        }),
      ],
    });
    if (n >= min) await client.services.moderation?.reportDestructiveAction?.(interaction.guild, interaction.user, 'messagePurge');
  },
};
