'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { row, selectMenu } = require('../../utils/components');
const { card, field, ICONS, subtext, linkButton, buttonRows } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/**
 * Permissions qu'un rôle auto-attribuable ne doit jamais conférer.
 * Source unique, partagée avec le gestionnaire du menu (components/rolemenu.js).
 */
const FORBIDDEN_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ViewAuditLog,
]);

/** Le rôle confère-t-il une permission de modération / d'administration ? */
function hasForbiddenPermissions(role) {
  return role.permissions.any(FORBIDDEN_PERMISSIONS);
}

/**
 * Carte publique du menu de rôles. Pure.
 * @param {{ title: string, intro?: string|null, roles: Array<{ roleId: string, label: string, description?: string|null, emoji?: string|null }> }} data
 */
function panelCard({ title, intro, roles }) {
  const lines = roles.map((r) => {
    const head = `${r.emoji ?? ICONS.role} <@&${r.roleId}>`;
    return r.description ? `${head}\n${subtext(truncate(r.description, 100))}` : head;
  });
  return card({
    tone: 'brand',
    section: 'roles',
    icon: ICONS.role,
    title: truncate(title, 200),
    description: [
      intro ? truncate(intro, 1000) : 'Choisissez vos rôles dans le menu ci-dessous.',
      '',
      ...lines,
      '',
      subtext('Sélectionnez un rôle pour l\'obtenir · resélectionnez-le pour le retirer.'),
    ],
    footer: `${roles.length} rôle${roles.length > 1 ? 's' : ''} disponible${roles.length > 1 ? 's' : ''}`,
    timestamp: false,
  });
}

/**
 * Crée un menu de rôles auto-attribuables (select menu persistant `rolemenu:<id>`).
 */
module.exports = {
  category: 'roles',
  panelCard,
  FORBIDDEN_PERMISSIONS,
  hasForbiddenPermissions,
  data: new SlashCommandBuilder()
    .setName('rolemenu')
    .setDescription('Crée un menu de rôles auto-attribuables.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption((o) => o.setName('titre').setDescription('Titre du menu').setRequired(true).setMaxLength(200))
    .addRoleOption((o) => o.setName('role1').setDescription('Rôle 1').setRequired(true))
    .addRoleOption((o) => o.setName('role2').setDescription('Rôle 2'))
    .addRoleOption((o) => o.setName('role3').setDescription('Rôle 3'))
    .addRoleOption((o) => o.setName('role4').setDescription('Rôle 4'))
    .addRoleOption((o) => o.setName('role5').setDescription('Rôle 5'))
    .addStringOption((o) => o.setName('description').setDescription('Texte d\'introduction du panneau').setMaxLength(1000))
    .addStringOption((o) =>
      o.setName('details').setDescription('Description de chaque rôle, dans l\'ordre, séparées par | (ex : Annonces|Événements)').setMaxLength(600)),

  async execute(interaction, client) {
    const title = interaction.options.getString('titre');
    const intro = interaction.options.getString('description');
    const details = (interaction.options.getString('details') ?? '').split('|').map((d) => d.trim());
    const guild = interaction.guild;
    const me = guild.members.me;
    const isOwner = interaction.user.id === guild.ownerId;
    const roles = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = interaction.options.getRole(`role${i}`);
      if (!r || roles.some((x) => x.roleId === r.id)) continue;
      if (r.id === guild.id) throw new UserError('Le rôle @everyone ne peut pas faire partie d\'un menu de rôles.');
      if (r.managed) throw new UserError(`Le rôle ${r.name} est géré par une intégration et ne peut pas être auto-attribué.`);
      if (hasForbiddenPermissions(r)) {
        throw new UserError(`Le rôle ${r.name} possède des permissions de modération ou d'administration : il ne peut pas être auto-attribuable.`);
      }
      if (r.position >= me.roles.highest.position) throw new UserError(`Le rôle ${r.name} est trop haut pour que je puisse l'attribuer.`);
      if (!isOwner && r.position >= interaction.member.roles.highest.position) {
        throw new UserError(`Le rôle ${r.name} est au-dessus (ou égal) à votre rôle le plus haut.`);
      }
      roles.push({ roleId: r.id, label: r.name, description: details[i - 1] || null, emoji: r.unicodeEmoji || null });
    }

    // Construction (et donc validation) du menu AVANT d'écrire en base, pour
    // ne jamais laisser de ligne orpheline si un validateur lève.
    const menu = selectMenu({
      id: 'rolemenu:pending',
      placeholder: 'Choisissez vos rôles…',
      min: 0,
      max: roles.length,
      options: roles.map((r) => ({ label: r.label, value: r.roleId, description: r.description, emoji: r.emoji ?? ICONS.role })),
    });
    const embed = panelCard({ title, intro, roles });

    const id = client.repositories.roleMenus.create({
      guildId: guild.id,
      channelId: interaction.channel.id,
      data: { title, intro, roles },
    });
    menu.setCustomId(`rolemenu:${id}`);

    let message;
    try {
      message = await interaction.channel.send({ embeds: [embed], components: [row(menu)] });
    } catch (err) {
      client.repositories.roleMenus.delete(id);
      throw err;
    }
    client.repositories.roleMenus.setMessage(id, message.id);
    await interaction.reply({
      embeds: [
        card({
          tone: 'success',
          section: 'roles',
          icon: ICONS.success,
          title: 'Menu de rôles publié',
          description: `Le menu **${truncate(title, 200)}** est en ligne dans ${interaction.channel}.`,
          fields: [field(ICONS.role, 'Rôles', roles.map((r) => `<@&${r.roleId}>`).join(' ')), field(ICONS.id, 'Menu', `#${id}`)],
        }),
      ],
      components: message?.url ? buttonRows(linkButton('Voir le menu', message.url, ICONS.link)) : [],
      ephemeral: true,
    });
  },
};
