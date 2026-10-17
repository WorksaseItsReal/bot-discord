'use strict';

const { SlashCommandBuilder, version: djsVersion } = require('discord.js');
const { wsLatency } = require('../../utils/latency');
const { card, field, wide, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { formatDuration, discordTimestamp } = require('../../utils/time');
const { assertInvoker } = require('../../utils/buttonGuard');
const { inviteButton } = require('../utility/invite');

const fr = (n) => Number(n || 0).toLocaleString('fr-FR');

function render(client, ownerId) {
  const mem = process.memoryUsage().rss / 1024 / 1024;
  const members = client.guilds.cache.reduce((n, g) => n + (g.memberCount || 0), 0);
  const ws = wsLatency(client);
  return {
    embeds: [
      card({
        tone: 'brand',
        section: 'information',
        icon: ICONS.bot,
        title: client.user.username,
        description: [
          'Bot de gestion tout-en-un : modération, sécurité, tickets, giveaways, **projets** et bien plus.',
          subtext(`Créé ${discordTimestamp(client.user.createdTimestamp, 'R')} · démarré ${discordTimestamp(client.startedAt ?? Date.now() - client.uptime, 'R')}`),
        ],
        thumbnail: client.user.displayAvatarURL({ size: 256 }),
        fields: [
          field(ICONS.server, 'Serveurs', `**${fr(client.guilds.cache.size)}**`),
          field(ICONS.members, 'Membres', `**${fr(members)}**`),
          field(ICONS.list, 'Commandes', `**${fr(client.commands.size)}**`),
          field(ICONS.duration, 'Disponibilité', `\`${formatDuration(client.uptime)}\``),
          field(ICONS.latency, 'Latence', ws < 0 ? '`N/A`' : `\`${ws} ms\``),
          field(ICONS.memory, 'Mémoire', `\`${mem.toFixed(1)} Mo\``),
          field(ICONS.stats, 'Exécutées', `**${fr(client.stats.commandsRun)}**`),
          field(ICONS.error, 'Erreurs', `**${fr(client.stats.errors)}**`),
          field(ICONS.rocket, 'Version', `\`v${client.config.version}\``),
          wide(ICONS.settings, 'Technique', `discord.js \`v${djsVersion}\` · Node.js \`${process.version}\``),
        ],
        footer: 'Statistiques depuis le démarrage',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'botinfo', action: 'refresh', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      inviteButton(client),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  guildOnly: false,
  render,
  data: new SlashCommandBuilder().setName('botinfo').setDescription('Affiche les informations et statistiques du bot.'),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    await interaction.reply(render(client, interaction.user.id));
  },
  buttons: {
    /** cmd:botinfo:refresh:<ownerId> — recalcule les statistiques. */
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.update(render(client, ownerId));
    },
  },
};
