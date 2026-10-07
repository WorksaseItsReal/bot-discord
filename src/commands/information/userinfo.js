'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { embeds, truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { permissionLabel } = require('../../utils/permissionNames');

const KEY_PERMISSIONS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];

/** Liste de mentions qui tient dans `max` caractères sans couper une mention. */
function fitMentions(items, max = 1000) {
  const out = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const rest = items.length - i;
    if (used + items[i].length + 1 > max - 20) {
      out.push(`+${rest}`);
      break;
    }
    out.push(items[i]);
    used += items[i].length + 1;
  }
  return out.join(' ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('user')
    .setDescription('Affiche les informations d\'un utilisateur ou membre.')
    .addUserOption((o) => o.setName('cible').setDescription('L\'utilisateur à inspecter (par défaut vous-même).')),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const user = await (interaction.options.getUser('cible') || interaction.user).fetch().catch(() => interaction.options.getUser('cible') || interaction.user);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    const badges = [user.bot ? '🤖 Bot' : null, member?.premiumSince ? '💎 Booster' : null, user.id === interaction.guild.ownerId ? '👑 Propriétaire' : null].filter(Boolean);
    const embed = embeds
      .custom(member?.displayColor || user.accentColor || 0x5865f2, `👤 ${user.displayName ?? user.username}`)
      .setThumbnail((member ?? user).displayAvatarURL({ size: 256 }))
      .setDescription(`${user} · \`${user.username}\`${badges.length ? `\n${badges.join(' · ')}` : ''}`)
      .addFields(
        { name: '🆔 ID', value: `\`${user.id}\``, inline: true },
        { name: '📅 Compte créé', value: `${discordTimestamp(user.createdTimestamp, 'D')}\n${discordTimestamp(user.createdTimestamp, 'R')}`, inline: true },
      );
    const banner = user.bannerURL?.({ size: 1024 });
    if (banner) embed.setImage(banner);

    if (member) {
      const roles = member.roles.cache
        .filter((r) => r.id !== interaction.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => r.toString());
      const perms = KEY_PERMISSIONS.filter((p) => member.permissions.has(p));
      embed.addFields(
        { name: '📥 A rejoint', value: member.joinedTimestamp ? `${discordTimestamp(member.joinedTimestamp, 'D')}\n${discordTimestamp(member.joinedTimestamp, 'R')}` : 'Inconnu', inline: true },
        { name: '✏️ Surnom', value: truncate(member.nickname || '—', 1024), inline: true },
        { name: '🎨 Rôle principal', value: member.roles.highest.id === interaction.guild.id ? '—' : `${member.roles.highest}`, inline: true },
      );
      if (member.communicationDisabledUntilTimestamp > Date.now()) {
        embed.addFields({ name: '🔇 Exclu jusqu\'à', value: discordTimestamp(member.communicationDisabledUntilTimestamp, 'f'), inline: true });
      }
      embed.addFields({ name: `🎭 Rôles (${roles.length})`, value: roles.length ? fitMentions(roles) : 'Aucun' });
      if (perms.length) {
        embed.addFields({ name: '🔑 Permissions clés', value: perms.includes('Administrator') ? '**Administrateur** (toutes les permissions)' : perms.map(permissionLabel).join(', ') });
      }
    } else {
      embed.addFields({ name: 'Serveur', value: '*N\'est pas membre de ce serveur.*', inline: true });
    }
    await interaction.reply({ embeds: [embed] });
  },
};
