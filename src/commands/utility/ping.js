'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds } = require('../../utils/embeds');

/** Qualité de la latence → [emoji, libellé, couleur]. Pur. */
function quality(ms) {
  if (ms < 0) return ['⚪', 'Inconnue', 0x95a5a6];
  if (ms < 150) return ['🟢', 'Excellente', 0x57f287];
  if (ms < 300) return ['🟡', 'Correcte', 0xfee75c];
  return ['🔴', 'Élevée', 0xed4245];
}

module.exports = {
  guildOnly: false,
  quality,
  data: new SlashCommandBuilder().setName('ping').setDescription('Affiche la latence du bot et de l\'API Discord.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const started = Date.now();
    await interaction.deferReply();
    const roundtrip = Date.now() - started;
    const ws = Math.round(client.ws.ping);
    const [emoji, label, color] = quality(Math.max(roundtrip, ws));
    const embed = embeds
      .custom(color, '🏓 Pong !')
      .addFields(
        { name: '📡 Aller-retour', value: `\`${roundtrip} ms\``, inline: true },
        { name: '💓 WebSocket', value: `\`${ws < 0 ? 'N/A' : `${ws} ms`}\``, inline: true },
        { name: '📶 Qualité', value: `${emoji} ${label}`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });
  },
};
