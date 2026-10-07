'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { card, field, ICONS, code, userLine, subtext, actionButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { paginate } = require('../../utils/pagination');
const { UserError } = require('../../core/errors');

const HEX_COLOR = /^#?[0-9a-f]{6}$/i;
const PER_PAGE = 15;
/** Délai pendant lequel la création d'un rôle peut être annulée par bouton. */
const UNDO_CREATE_MS = 15 * 60_000;

/**
 * Garde-fous anti-escalade : rôle géré/@everyone refusés, et l'auteur doit
 * être strictement au-dessus du rôle (sauf propriétaire du serveur).
 */
function assertManageableRole(interaction, role) {
  const guild = interaction.guild;
  if (role.id === guild.id) throw new UserError('Le rôle @everyone ne peut pas être géré ainsi.');
  if (role.managed) throw new UserError('Ce rôle est géré par une intégration (bot, boost…) et ne peut pas être modifié.');
  if (role.position >= guild.members.me.roles.highest.position) {
    throw new UserError('Ce rôle est au-dessus (ou égal) au mien : je ne peux pas le gérer.');
  }
  const member = interaction.member;
  if (interaction.user.id !== guild.ownerId && role.position >= member.roles.highest.position) {
    throw new UserError('Ce rôle est au-dessus (ou égal) à votre rôle le plus haut : vous ne pouvez pas le gérer.');
  }
}

/** Vérifie la permission « Gérer les rôles » de la personne qui clique. */
function assertManageRoles(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    throw new UserError('Il faut la permission **Gérer les rôles** pour utiliser ce bouton.');
  }
}

function hex(role) {
  return role.color ? code(`#${role.color.toString(16).padStart(6, '0').toUpperCase()}`) : '*Par défaut*';
}

/**
 * Carte « rôle ajouté / retiré » + bouton inverse.
 * @param {'added'|'removed'} state
 */
function membershipView(state, { member, role, moderator, ownerId }) {
  const added = state === 'added';
  return {
    embeds: [
      card({
        tone: added ? 'success' : 'neutral',
        section: 'roles',
        icon: added ? ICONS.success : '➖',
        title: added ? 'Rôle ajouté' : 'Rôle retiré',
        description: added ? `${member} a maintenant le rôle ${role}.` : `${member} n'a plus le rôle ${role}.`,
        fields: [
          field(ICONS.user, 'Membre', userLine(member.user ?? member)),
          field(ICONS.role, 'Rôle', `${role}`),
          field(ICONS.moderator, 'Par', `${moderator}`),
        ],
      }),
    ],
    components: buttonRows(
      added
        ? actionButton({ command: 'role', action: 'take', args: [member.id, role.id, ownerId], label: 'Retirer', emoji: '↩️' })
        : actionButton({ command: 'role', action: 'give', args: [member.id, role.id, ownerId], label: 'Rendre', emoji: '↩️' }),
      deleteButton(ownerId),
    ),
  };
}

/** Résout membre + rôle d'un bouton et revérifie permissions et hiérarchie. */
async function resolveButton(interaction, memberId, roleId) {
  assertManageRoles(interaction);
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) throw new UserError('Ce rôle n\'existe plus.');
  assertManageableRole(interaction, role);
  const member = await interaction.guild.members.fetch(memberId).catch(() => null);
  if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
  return { role, member };
}

module.exports = {
  category: 'roles',
  assertManageableRole,
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('Gestion des rôles.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s.setName('add').setDescription('Ajoute un rôle à un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un rôle d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un rôle.')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du rôle').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)')))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un rôle.')
        .addRoleOption((o) => o.setName('role').setDescription('Rôle').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les rôles du serveur.')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const ownerId = interaction.user.id;

    if (sub === 'list') {
      const roles = [...guild.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position).values()];
      const managed = roles.filter((r) => r.managed).length;
      const hoisted = roles.filter((r) => r.hoist).length;
      const pages = [];
      for (let i = 0; i < Math.max(roles.length, 1); i += PER_PAGE) {
        const slice = roles.slice(i, i + PER_PAGE);
        pages.push(
          card({
            tone: 'brand',
            section: 'roles',
            icon: ICONS.role,
            title: `Rôles du serveur (${roles.length})`,
            description: slice.length
              ? slice.map((r, j) => `\`${String(i + j + 1).padStart(2, '0')}\` ${r} · ${ICONS.members} ${r.members.size}${r.managed ? ` · ${ICONS.bot}` : ''}`).join('\n')
              : '*Aucun rôle en dehors de @everyone.*',
            fields: [
              field(ICONS.count, 'Total', `**${roles.length}**`),
              field(ICONS.bot, 'Gérés', `**${managed}**`),
              field('📌', 'Affichés à part', `**${hoisted}**`),
            ],
            footer: 'Membres en cache',
          }),
        );
      }
      return paginate(interaction, pages, { ephemeral: true });
    }

    if (sub === 'create') {
      const name = interaction.options.getString('nom');
      const rawColor = interaction.options.getString('couleur')?.trim();
      if (rawColor && !HEX_COLOR.test(rawColor)) {
        throw new UserError('Couleur invalide : utilisez un code hexadécimal comme `#5865F2`.');
      }
      const color = rawColor ? `#${rawColor.replace(/^#/, '')}` : undefined;
      const role = await guild.roles.create({ name, color, reason: `Créé par ${interaction.user.tag}` });
      return interaction.reply({
        embeds: [
          card({
            tone: role.color || 'success',
            section: 'roles',
            icon: ICONS.success,
            title: 'Rôle créé',
            description: [`Le rôle ${role} est prêt.`, subtext('Ajustez ses permissions dans les paramètres du serveur.')],
            fields: [
              field(ICONS.role, 'Rôle', `${role}`),
              field(ICONS.color, 'Couleur', hex(role)),
              field(ICONS.id, 'Identifiant', code(role.id)),
            ],
          }),
        ],
        components: buttonRows(
          actionButton({ command: 'role', action: 'uncreate', args: [role.id, ownerId], label: 'Annuler', emoji: '↩️', style: ButtonStyle.Danger }),
        ),
      });
    }

    const role = interaction.options.getRole('role');
    assertManageableRole(interaction, role);

    if (sub === 'delete') {
      const members = role.members?.size ?? 0;
      const name = role.name;
      const color = hex(role);
      await role.delete(`Supprimé par ${interaction.user.tag}`);
      return interaction.reply({
        embeds: [
          card({
            tone: 'danger',
            section: 'roles',
            icon: ICONS.delete,
            title: 'Rôle supprimé',
            description: `Le rôle **${name}** a été supprimé définitivement.`,
            fields: [
              field(ICONS.role, 'Nom', `**${name}**`),
              field(ICONS.color, 'Couleur', color),
              field(ICONS.members, 'Membres', `**${members}**`),
              field(ICONS.moderator, 'Par', `${interaction.user}`),
            ],
          }),
        ],
      });
    }

    const user = interaction.options.getUser('membre');
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Membre introuvable.');

    if (sub === 'add') {
      if (member.roles.cache.has(role.id)) throw new UserError(`${user} a déjà le rôle ${role}.`);
      await member.roles.add(role, `Par ${interaction.user.tag}`);
      return interaction.reply(membershipView('added', { member, role, moderator: interaction.user, ownerId }));
    }
    if (sub === 'remove') {
      if (!member.roles.cache.has(role.id)) throw new UserError(`${user} n'a pas le rôle ${role}.`);
      await member.roles.remove(role, `Par ${interaction.user.tag}`);
      return interaction.reply(membershipView('removed', { member, role, moderator: interaction.user, ownerId }));
    }
  },

  buttons: {
    /** cmd:role:take:<memberId>:<roleId>:<ownerId> — retire le rôle qui vient d'être ajouté. */
    async take(interaction, client, [memberId, roleId, ownerId]) {
      const { role, member } = await resolveButton(interaction, memberId, roleId);
      if (!member.roles.cache.has(role.id)) throw new UserError(`${member} n'a déjà plus le rôle ${role}.`);
      await member.roles.remove(role, `Annulation par ${interaction.user.tag}`);
      await interaction.update(membershipView('removed', { member, role, moderator: interaction.user, ownerId }));
    },

    /** cmd:role:give:<memberId>:<roleId>:<ownerId> — rend le rôle qui vient d'être retiré. */
    async give(interaction, client, [memberId, roleId, ownerId]) {
      const { role, member } = await resolveButton(interaction, memberId, roleId);
      if (member.roles.cache.has(role.id)) throw new UserError(`${member} a déjà le rôle ${role}.`);
      await member.roles.add(role, `Annulation par ${interaction.user.tag}`);
      await interaction.update(membershipView('added', { member, role, moderator: interaction.user, ownerId }));
    },

    /** cmd:role:uncreate:<roleId>:<ownerId> — annule une création récente (15 min). */
    async uncreate(interaction, client, [roleId, ownerId]) {
      assertManageRoles(interaction);
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) throw new UserError('Ce rôle n\'existe plus.');
      assertManageableRole(interaction, role);
      if (Date.now() - role.createdTimestamp > UNDO_CREATE_MS) {
        throw new UserError(`La création ne peut plus être annulée (délai de 15 minutes dépassé). Utilisez \`/role delete\`.`);
      }
      const name = role.name;
      await role.delete(`Création annulée par ${interaction.user.tag}`);
      await interaction.update({
        embeds: [
          card({
            tone: 'neutral',
            section: 'roles',
            icon: '↩️',
            title: 'Création annulée',
            description: `Le rôle **${name}** a été supprimé.`,
            fields: [field(ICONS.moderator, 'Par', `${interaction.user}`), field(ICONS.time, 'Quand', discordTimestamp(Date.now(), 'R'))],
          }),
        ],
        components: buttonRows(deleteButton(ownerId)),
      });
    },
  },
};
