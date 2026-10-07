'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { listOrMore } = require('../../utils/embeds');
const { card, field, wide, ICONS, userLine, status } = require('../../utils/ui');
const { assertCanModerate } = require('../../utils/permissions');
const { UserError } = require('../../core/errors');

module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('derank')
    .setDescription('Retire tous les rôles d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison')),

  async execute(interaction) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Membre introuvable.');
    assertCanModerate(interaction.member, member, interaction.guild.members.me, { action: 'dérank' });

    const roles = member.roles.cache.filter((r) => r.id !== interaction.guild.id);
    const removable = roles.filter((r) => r.editable);
    const kept = roles.filter((r) => !r.editable);
    if (!removable.size) {
      return interaction.reply({ embeds: [status.note(`${user} n'a aucun rôle que je puisse retirer.`, 'Rien à retirer')], ephemeral: true });
    }
    await member.roles.remove(removable, reason || `Derank par ${interaction.user.tag}`);

    const mentions = [...removable.sort((a, b) => b.position - a.position).values()].map((r) => `${r}`);
    await interaction.reply({
      embeds: [
        card({
          tone: 'caution',
          section: 'roles',
          icon: '📉',
          title: 'Membre dérank',
          description: `${user} a perdu **${removable.size}** rôle${removable.size > 1 ? 's' : ''}.`,
          fields: [
            field(ICONS.user, 'Membre', userLine(user)),
            field(ICONS.moderator, 'Modérateur', `${interaction.user}`),
            field(ICONS.count, 'Rôles retirés', `**${removable.size}**`),
            wide(ICONS.role, 'Rôles retirés', listOrMore(mentions, 25, ' ')),
            kept.size ? wide(ICONS.lock, 'Conservés (trop hauts ou gérés)', listOrMore([...kept.values()].map((r) => `${r}`), 15, ' ')) : null,
            wide(ICONS.reason, 'Raison', reason ?? '*Aucune raison fournie*'),
          ],
          thumbnail: member.displayAvatarURL?.({ size: 128 }) ?? null,
        }),
      ],
    });
  },
};
