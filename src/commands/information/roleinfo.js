'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { discordTimestamp } = require('../../utils/time');
const { permissionLabel } = require('../../utils/permissionNames');
const { card, field, wide, ICONS, code, subtext, bullets, actionButton, buttonRows } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

const SNOWFLAKE = /^\d{17,20}$/;
const KEY_PERMISSIONS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone'];
const MAX_LISTED = 40;

/** Nombre de membres du rôle : exact si le cache est complet, sinon approximatif. */
function memberCount(role) {
  const guild = role.guild;
  const exact = guild && guild.members.cache.size >= guild.memberCount;
  return `**${role.members.size}**${exact ? '' : ' *(en cache)*'}`;
}

function render(role) {
  const guild = role.guild;
  const badges = [
    role.managed ? `${ICONS.bot} Géré par une intégration` : null,
    role.hoist ? `${ICONS.status} Affiché séparément` : null,
    role.mentionable ? '🔔 Mentionnable' : null,
  ].filter(Boolean);
  const perms = KEY_PERMISSIONS.filter((p) => role.permissions.has(p));
  const totalRoles = guild ? guild.roles.cache.size - 1 : null;

  const fields = [
    field(ICONS.id, 'Identifiant', code(role.id)),
    field(ICONS.color, 'Couleur', role.color ? code(role.hexColor.toUpperCase()) : 'Par défaut'),
    field(ICONS.members, 'Membres', memberCount(role)),
    field(ICONS.list, 'Position', `**${role.position}**${totalRoles ? ` / ${totalRoles}` : ''}`),
    field('🔔', 'Mentionnable', role.mentionable ? 'Oui' : 'Non'),
    field(ICONS.date, 'Créé', `${discordTimestamp(role.createdTimestamp, 'D')}\n${discordTimestamp(role.createdTimestamp, 'R')}`),
  ];
  if (perms.length) {
    fields.push(wide('🔑', 'Permissions clés', perms.includes('Administrator') ? '**Administrateur** · toutes les permissions' : perms.map(permissionLabel).join(' · ')));
  }

  return {
    embeds: [
      card({
        tone: role.color || 'brand',
        section: 'information',
        icon: ICONS.role,
        title: role.name,
        description: [`${role}`, badges.length ? badges.join('  ·  ') : subtext('Rôle standard.')],
        thumbnail: role.iconURL?.({ size: 256 }) ?? null,
        fields,
      }),
    ],
    components: buttonRows(actionButton({ command: 'roleinfo', action: 'members', args: [role.id], label: 'Membres', emoji: ICONS.members })),
  };
}

module.exports = {
  category: 'information',
  render,
  data: new SlashCommandBuilder()
    .setName('roleinfo')
    .setDescription('Affiche les informations d\'un rôle.')
    .addRoleOption((o) => o.setName('role').setDescription('Le rôle à inspecter').setRequired(true)),
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const picked = interaction.options.getRole('role');
    const role = interaction.guild.roles.cache.get(picked.id) ?? picked;
    await interaction.reply(render(role));
  },
  buttons: {
    /** cmd:roleinfo:members:<roleId> — liste éphémère des membres du rôle (tronquée). */
    async members(interaction, client, [roleId]) {
      if (!SNOWFLAKE.test(roleId ?? '')) throw new UserError('Ce bouton est invalide. Relancez `/roleinfo`.');
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) throw new UserError('Ce rôle n\'existe plus.');
      await interaction.deferReply({ ephemeral: true });
      if (interaction.guild.members.cache.size < interaction.guild.memberCount) {
        await interaction.guild.members.fetch({ time: 15_000 }).catch(() => null);
      }
      const members = [...role.members.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
      const shown = members.slice(0, MAX_LISTED).map((m) => `${m} · ${code(m.user.username)}`);
      const rest = members.length - shown.length;
      await interaction.editReply({
        embeds: [
          card({
            tone: role.color || 'brand',
            section: 'information',
            icon: ICONS.members,
            title: `Membres avec ${role.name}`,
            description: members.length
              ? [`${role} · **${members.length}** membre${members.length > 1 ? 's' : ''}`, '', bullets(shown), rest > 0 ? subtext(`… et ${rest} autre${rest > 1 ? 's' : ''}. Liste complète : /inrole`) : null]
              : [`Aucun membre n'a le rôle ${role}.`],
          }),
        ],
      });
    },
  },
};
