'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, wide, subtext } = require('../../utils/ui');
const { MAX_REASON } = require('../../services/AfkService');
const { UserError } = require('../../core/errors');

/**
 * /afk [raison] : signale une absence. Le pseudo reçoit le préfixe « [AFK] » (si le bot
 * le peut), une réponse courte prévient ceux qui vous mentionnent, et votre prochain
 * message met fin à l'absence (pseudo rétabli). Réglages : /alertes config.
 */

/** Explication de l'état du pseudo (affichée sous la confirmation). */
const NICK_NOTES = {
  set: 'Préfixe « [AFK] » ajouté à votre pseudo, retiré à votre retour.',
  kept: null,
  disabled: null,
  owner: 'Pseudo inchangé : celui du propriétaire du serveur ne peut pas être modifié.',
  permission: 'Pseudo inchangé : il me manque la permission « Gérer les pseudos ».',
  hierarchy: 'Pseudo inchangé : votre rôle le plus haut est au-dessus du mien.',
  failed: 'Pseudo inchangé : Discord a refusé la modification.',
};

module.exports = {
  category: 'utility',
  cooldown: 10_000,
  data: new SlashCommandBuilder()
    .setName('afk')
    .setDescription('Signale votre absence : ceux qui vous mentionnent seront prévenus.')
    .addStringOption((o) => o.setName('raison').setDescription('Raison affichée à ceux qui vous mentionnent').setMaxLength(MAX_REASON)),

  async execute(interaction, client) {
    const afk = client.services.afk;
    if (!afk.enabled(interaction.guildId)) throw new UserError('Les absences (/afk) sont désactivées sur ce serveur.');
    const reason = afk.parseReason(interaction.guildId, interaction.options.getString('raison'));
    await interaction.deferReply();
    const member = interaction.guild.members.cache.get(interaction.user.id) ?? (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));
    if (!member) throw new UserError('Je ne vous trouve pas parmi les membres du serveur.');
    const { updated, nick } = await afk.set(member, reason);
    const note = updated ? null : NICK_NOTES[nick];
    await interaction.editReply({
      embeds: [
        card({
          tone: 'neutral',
          section: { emoji: '💤', label: 'Absences' },
          icon: '💤',
          title: updated ? 'Raison mise à jour' : 'Vous êtes AFK',
          description: [
            updated ? `${interaction.user} est toujours **AFK**.` : `${interaction.user} est maintenant **AFK**.`,
            subtext('Votre prochain message mettra fin à l\'absence.'),
            note ? subtext(note) : null,
          ],
          fields: [wide('📝', 'Raison', reason ?? '*Aucune raison donnée*')],
          timestamp: false,
        }),
      ],
    });
  },
};
