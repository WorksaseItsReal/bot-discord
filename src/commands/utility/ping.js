'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, actionButton, deleteButton, buttonRows, ButtonStyle, subtext } = require('../../utils/ui');
const { progressBar } = require('../../utils/embeds');
const { assertInvoker } = require('../../utils/buttonGuard');

/** Qualité de la latence → [emoji, libellé, ton]. Pur. */
function quality(ms) {
  if (ms < 0) return ['⚪', 'Inconnue', 'neutral'];
  if (ms < 150) return ['🟢', 'Excellente', 'success'];
  if (ms < 300) return ['🟡', 'Correcte', 'warning'];
  return ['🔴', 'Élevée', 'danger'];
}

function render(client, ownerId, roundtrip) {
  const ws = Math.round(client.ws.ping);
  const worst = Math.max(roundtrip ?? 0, ws);
  const [dot, label, tone] = quality(worst);
  return {
    embeds: [
      card({
        tone,
        section: 'utility',
        icon: '🏓',
        title: 'Pong !',
        description: [
          `${dot} Connexion **${label.toLowerCase()}**`,
          `\`${progressBar(1 - Math.min(worst, 600) / 600, 16)}\``,
          subtext('Plus la barre est pleine, plus le bot est réactif.'),
        ],
        fields: [
          field(ICONS.latency, 'Aller-retour', roundtrip == null ? '*Actualisé*' : `\`${roundtrip} ms\``),
          field(ICONS.heart, 'WebSocket', ws < 0 ? '`N/A`' : `\`${ws} ms\``),
          field(ICONS.status, 'Qualité', `${dot} ${label}`),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'ping', action: 'refresh', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  guildOnly: false,
  quality,
  data: new SlashCommandBuilder().setName('ping').setDescription('Affiche la latence du bot et de l\'API Discord.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const started = Date.now();
    await interaction.deferReply();
    await interaction.editReply(render(client, interaction.user.id, Date.now() - started));
  },
  buttons: {
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      const started = Date.now();
      await interaction.deferUpdate();
      await interaction.editReply(render(client, ownerId, Date.now() - started));
    },
  },
};
