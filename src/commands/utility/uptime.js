'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { formatDuration, discordTimestamp } = require('../../utils/time');
const { card, field, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');

function render(client, ownerId) {
  const startedAt = client.startedAt ?? Date.now() - client.uptime;
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'utility',
        icon: ICONS.duration,
        title: 'Disponibilité',
        description: [`En ligne depuis **${formatDuration(client.uptime)}**.`, subtext(`Démarré ${discordTimestamp(startedAt, 'R')}.`)],
        fields: [
          field(ICONS.rocket, 'Démarrage', discordTimestamp(startedAt, 'f')),
          field(ICONS.stats, 'Commandes', `**${Number(client.stats.commandsRun).toLocaleString('fr-FR')}**`),
          field(ICONS.error, 'Erreurs', `**${Number(client.stats.errors).toLocaleString('fr-FR')}**`),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'uptime', action: 'refresh', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  guildOnly: false,
  render,
  data: new SlashCommandBuilder().setName('uptime').setDescription('Depuis combien de temps le bot est en ligne.'),
  async execute(interaction, client) {
    await interaction.reply(render(client, interaction.user.id));
  },
  buttons: {
    /** cmd:uptime:refresh:<ownerId> */
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.update(render(client, ownerId));
    },
  },
};
