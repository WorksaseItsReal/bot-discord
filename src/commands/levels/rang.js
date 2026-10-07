'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, ICONS, subtext, actionButton, buttonRows } = require('../../utils/ui');
const { progressBar } = require('../../utils/embeds');
const { progressOf } = require('../../services/LevelService');
const { assertEnabled, pageOfRank } = require('./classement');
const { UserError } = require('../../core/errors');

const fmt = (n) => Number(n ?? 0).toLocaleString('fr-FR');

/**
 * Carte de rang d'un membre (embed, sans image générée).
 * @param {{ user: import('discord.js').User, member?: import('discord.js').GuildMember|null, row?: object|null,
 *   rank?: number|null, total?: number, cfg: object }} data
 */
function rankCard({ user, member = null, row = null, rank = null, total = 0, cfg }) {
  const xp = row?.xp ?? 0;
  const p = progressOf(xp);
  const next = (cfg.rewards ?? []).filter((r) => r.level > p.level).sort((a, b) => a.level - b.level)[0];
  const pct = Math.floor(p.ratio * 100);
  return card({
    tone: 'brand',
    section: 'levels',
    icon: '🏅',
    title: `Rang de ${member?.displayName ?? user.globalName ?? user.username}`,
    description: [
      `**Niveau ${p.level}** · ${rank ? `**#${rank}** sur ${total}` : 'pas encore classé'}`,
      `\`${progressBar(p.ratio, 18)}\` **${pct} %**`,
      subtext(`${fmt(p.current)} / ${fmt(p.needed)} XP · encore ${fmt(p.remaining)} XP avant le niveau ${p.level + 1}`),
    ],
    fields: [
      field('📈', 'Niveau', `**${p.level}**`),
      field('🏆', 'Rang', rank ? `**#${rank}** / ${total}` : '*Non classé*'),
      field(ICONS.star, 'XP totale', `**${fmt(xp)}**`),
      field(ICONS.channel, 'Messages', fmt(row?.messages)),
      field(ICONS.voice, 'Minutes vocales', fmt(row?.voice_minutes)),
      field(ICONS.gift, 'Prochaine récompense', next ? `<@&${next.roleId}>\nau niveau **${next.level}**` : '*Aucune*'),
    ],
    thumbnail: (member ?? user).displayAvatarURL?.({ size: 256 }) ?? null,
  });
}

module.exports = {
  category: 'levels',
  cooldown: 3_000,
  rankCard,
  data: new SlashCommandBuilder()
    .setName('rang')
    .setDescription('Affiche le niveau, l\'XP et le rang d\'un membre.')
    .addUserOption((o) => o.setName('membre').setDescription('Membre à afficher (vous par défaut)')),

  async execute(interaction, client) {
    assertEnabled(client, interaction.guildId);
    const user = interaction.options.getUser('membre') ?? interaction.user;
    if (user.bot) throw new UserError('Les bots ne gagnent pas d\'XP.');
    const member = user.id === interaction.user.id ? interaction.member : interaction.options.getMember('membre');
    const repo = client.repositories.levels;
    const rank = repo.rank(interaction.guildId, user.id);
    const embed = rankCard({
      user,
      member: member?.displayAvatarURL ? member : null,
      row: repo.get(interaction.guildId, user.id),
      rank,
      total: repo.count(interaction.guildId),
      cfg: client.services.config.get(interaction.guildId).levels,
    });
    await interaction.reply({
      embeds: [embed],
      components: buttonRows(
        actionButton({ command: 'classement', action: 'page', args: [pageOfRank(rank), interaction.user.id], label: 'Classement', emoji: '🏆' }),
      ),
    });
  },
};
