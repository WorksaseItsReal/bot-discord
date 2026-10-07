'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { progressBar } = require('../../utils/embeds');
const { card, field, ICONS, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');

const fr = (n) => Number(n || 0).toLocaleString('fr-FR');
const percent = (part, total) => `${Math.round((part / Math.max(1, total)) * 100)} %`;

/** Compteurs du serveur (withCounts donne des valeurs approximatives sans télécharger toute la liste). */
async function counts(client, guild) {
  const fresh = await client.guilds.fetch({ guild: guild.id, withCounts: true, force: true }).catch(() => guild);
  const total = fresh.approximateMemberCount ?? guild.memberCount;
  const online = fresh.approximatePresenceCount ?? null;
  const cacheComplete = guild.members.cache.size >= guild.memberCount;
  const bots = cacheComplete ? guild.members.cache.filter((m) => m.user.bot).size : null;
  return { total, online, bots };
}

/** Rendu pur à partir des compteurs. */
function render(guild, { total, online, bots }, ownerId) {
  const fields = [field(ICONS.members, 'Total', `**${fr(total)}**`)];
  if (online != null) fields.push(field('🟢', 'En ligne', `**${fr(online)}** · ${percent(online, total)}`));
  fields.push(field(ICONS.boost, 'Boosts', `**${fr(guild.premiumSubscriptionCount ?? 0)}**`));
  if (bots != null) {
    fields.push(
      field(ICONS.user, 'Humains', `**${fr(total - bots)}** · ${percent(total - bots, total)}`),
      field(ICONS.bot, 'Bots', `**${fr(bots)}** · ${percent(bots, total)}`),
    );
  }
  return {
    embeds: [
      card({
        tone: 'brand',
        section: 'information',
        icon: ICONS.members,
        title: `Membres de ${guild.name}`,
        description: [
          `**${fr(total)}** membres${online != null ? `, dont **${fr(online)}** en ligne` : ''}.`,
          online != null ? `\`${progressBar(online / Math.max(1, total), 16)}\`` : null,
          subtext(online != null ? 'Barre : part des membres actuellement en ligne.' : 'Présences indisponibles pour le moment.'),
        ],
        thumbnail: guild.iconURL?.({ size: 256 }),
        fields,
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'membres', action: 'refresh', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  render,
  data: new SlashCommandBuilder().setName('membres').setDescription('Compteur de membres du serveur.'),
  async execute(interaction, client) {
    await interaction.deferReply();
    await interaction.editReply(render(interaction.guild, await counts(client, interaction.guild), interaction.user.id));
  },
  buttons: {
    /** cmd:membres:refresh:<ownerId> */
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.deferUpdate();
      await interaction.editReply(render(interaction.guild, await counts(client, interaction.guild), ownerId));
    },
  },
};
