'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { card, field, wide, ICONS, code, userLine, subtext, actionButton, deleteButton, labelButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp, parseDuration, formatDuration } = require('../../utils/time');
const { truncate } = require('../../utils/embeds');
const { paginate } = require('../../utils/pagination');
const { UserError } = require('../../core/errors');
const { confirm } = require('../../utils/confirmation');
const { hasForbiddenPermissions } = require('./rolemenu');

const HEX_COLOR = /^#?[0-9a-f]{6}$/i;
const PER_PAGE = 15;
/** Délai pendant lequel la création d'un rôle peut être annulée par bouton. */
const UNDO_CREATE_MS = 15 * 60_000;
/** Rôles temporaires par page de /role temporaires (une rangée de boutons chacun + navigation). */
const TEMP_PER_PAGE = 4;
const MIN_TEMP_MS = 60_000;
const SNOWFLAKE = /^\d{17,20}$/;

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

/** Couleur principale d'un rôle (`colors.primaryColor`, repli sur l'ancien `color`). */
function primaryColor(role) {
  return role.colors?.primaryColor ?? role.color ?? 0;
}

function hex(role) {
  const color = primaryColor(role);
  return color ? code(`#${color.toString(16).padStart(6, '0').toUpperCase()}`) : '*Par défaut*';
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

// ---------------------------------------------------------------- rôles temporaires

/** Durée saisie (1 minute à 1 an). Lève une UserError. */
function tempDuration(raw) {
  const ms = parseDuration(raw);
  if (!ms) throw new UserError('Durée invalide : utilisez par exemple `30m`, `12h`, `7d` ou `2w` (un an maximum).');
  if (ms < MIN_TEMP_MS) throw new UserError('Durée minimale : **1 minute**.');
  return ms;
}

/** Revérifie la permission et la hiérarchie de l'auteur sur le rôle d'une ligne (rôle supprimé : rien à vérifier). */
function assertTempAccess(interaction, row) {
  assertManageRoles(interaction);
  const role = interaction.guild.roles.cache.get(row.role_id);
  if (role) assertManageableRole(interaction, role);
}

/** Ligne active du serveur, ou UserError. */
function activeTempRow(client, interaction, id) {
  const row = /^\d{1,10}$/.test(id ?? '') ? client.repositories.tempRoles.get(interaction.guildId, Number(id)) : null;
  if (!row) throw new UserError('Ce rôle temporaire est introuvable.');
  if (!row.active) throw new UserError('Ce rôle temporaire est déjà terminé.');
  return row;
}

/**
 * Carte d'un rôle temporaire (attribution, prolongation) + boutons « Retirer maintenant » / « Prolonger ».
 * `ownerId` : auteur de la commande (bouton 🗑️).
 */
function tempCardView(row, { title, tone = 'success', moderator, ownerId, durationMs = null }) {
  return {
    embeds: [
      card({
        tone,
        section: 'roles',
        icon: '⏳',
        title,
        description: `<@${row.user_id}> a le rôle <@&${row.role_id}> jusqu'à ${discordTimestamp(row.expires_at, 'f')} (${discordTimestamp(row.expires_at, 'R')}).`,
        fields: [
          field(ICONS.user, 'Membre', `<@${row.user_id}>`),
          field(ICONS.role, 'Rôle', `<@&${row.role_id}>`),
          field(ICONS.moderator, 'Par', moderator ? `${moderator}` : row.moderator_id ? `<@${row.moderator_id}>` : '—'),
          durationMs ? field(ICONS.duration, 'Durée', formatDuration(durationMs)) : null,
          field(ICONS.expires, 'Fin', discordTimestamp(row.expires_at, 'R')),
          field(ICONS.id, 'Référence', code(`#${row.id}`)),
          row.reason ? wide(ICONS.reason, 'Raison', truncate(row.reason, 1000)) : null,
        ],
        footer: 'Retrait automatique à l\'échéance, même après un redémarrage',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'role', action: 'tremove', args: [row.id, 'card', ownerId], label: 'Retirer maintenant', emoji: '➖', style: ButtonStyle.Danger }),
      actionButton({ command: 'role', action: 'textend', args: [row.id, 'card', ownerId], label: 'Prolonger', emoji: '⏩' }),
      deleteButton(ownerId),
    ),
  };
}

/** Carte « rôle temporaire retiré » (depuis la carte d'attribution). */
function tempRemovedView(row, moderator, ownerId) {
  return {
    embeds: [
      card({
        tone: 'neutral',
        section: 'roles',
        icon: '➖',
        title: 'Rôle temporaire retiré',
        description: `<@${row.user_id}> n'a plus le rôle <@&${row.role_id}>.`,
        fields: [field(ICONS.user, 'Membre', `<@${row.user_id}>`), field(ICONS.role, 'Rôle', `<@&${row.role_id}>`), field(ICONS.moderator, 'Par', `${moderator}`)],
      }),
    ],
    components: buttonRows(deleteButton(ownerId)),
  };
}

/**
 * Liste paginée des rôles temporaires en cours (éphémère).
 * @param {string} filter identifiant du membre, ou « all »
 */
function tempListView(client, guild, filter = 'all', page = 0, notice = null) {
  const userId = filter === 'all' ? null : filter;
  const repo = client.repositories.tempRoles;
  const total = repo.count(guild.id, userId);
  const pages = Math.max(1, Math.ceil(total / TEMP_PER_PAGE));
  const current = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const rows = repo.page(guild.id, { userId, limit: TEMP_PER_PAGE, offset: current * TEMP_PER_PAGE });
  const lines = rows.map((r) => {
    const gone = guild.roles.cache.has(r.role_id) ? '' : ` · ${ICONS.warning} *rôle supprimé*`;
    const head = `\`#${r.id}\` <@${r.user_id}> → <@&${r.role_id}> · fin ${discordTimestamp(r.expires_at, 'R')}${gone}`;
    return r.reason ? `${head}\n${subtext(truncate(r.reason.replace(/\n/g, ' '), 120))}` : head;
  });
  const components = rows.map((r) => new ActionRowBuilder().addComponents(
    actionButton({ command: 'role', action: 'tremove', args: [r.id, filter, current], label: `Retirer maintenant · #${r.id}`, emoji: '➖', style: ButtonStyle.Danger }),
    actionButton({ command: 'role', action: 'textend', args: [r.id, filter, current], label: `Prolonger · #${r.id}`, emoji: '⏩' }),
  ));
  components.push(...buttonRows(
    pages > 1 && actionButton({ command: 'role', action: 'tlist', args: [filter, Math.max(0, current - 1)], emoji: ICONS.back, disabled: current === 0 }),
    pages > 1 && labelButton(`Page ${current + 1} / ${pages}`, `cmd:_:noop:tlist${current}`),
    pages > 1 && actionButton({ command: 'role', action: 'tlist', args: [filter, current + 1], emoji: ICONS.next, disabled: current >= pages - 1 }),
    actionButton({ command: 'role', action: 'tlist', args: [filter, `${current}`, 'r'], label: 'Actualiser', emoji: ICONS.refresh }),
  ));
  return {
    embeds: [
      card({
        tone: 'info',
        section: 'roles',
        icon: '⏳',
        title: userId ? 'Rôles temporaires du membre' : 'Rôles temporaires en cours',
        description: [
          notice ? `${notice}\n` : null,
          userId ? `Membre : <@${userId}>\n` : null,
          lines.length ? lines.join('\n') : '*Aucun rôle temporaire en cours.*',
        ],
        fields: [field(ICONS.count, 'En cours', `**${total}**`), field('📄', 'Page', `${current + 1} / ${pages}`)],
        footer: 'Retirés automatiquement à l\'échéance · /role temporaire pour en ajouter',
      }),
    ],
    components,
  };
}

function extendModal(id, filter, extra) {
  return new ModalBuilder()
    .setCustomId(`cmd:role:textendsubmit:${id}:${filter}:${extra}`)
    .setTitle(`Prolonger le rôle temporaire #${id}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('duree').setLabel('Durée à ajouter (ex : 12h, 7d, 2w)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20).setPlaceholder('7d'),
    ));
}

/** Filtre d'un bouton de rôle temporaire : « all », « card » (carte d'attribution) ou un identifiant de membre. */
function listFilter(filter) {
  if (filter === 'all' || filter === 'card' || SNOWFLAKE.test(filter ?? '')) return filter;
  throw new UserError('Ce bouton est invalide.');
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
        .addUserOption((o) => o.setName('membre').setDescription('Membre concerné').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle concerné').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Retire un rôle d\'un membre.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre concerné').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle concerné').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée un rôle.')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du rôle').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex (ex: #5865F2)')))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un rôle.')
        .addRoleOption((o) => o.setName('role').setDescription('Rôle concerné').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les rôles du serveur.'))
    .addSubcommand((s) =>
      s.setName('temporaire').setDescription('Donne un rôle pour une durée limitée (retiré automatiquement).')
        .addUserOption((o) => o.setName('membre').setDescription('Membre concerné').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Rôle concerné').setRequired(true))
        .addStringOption((o) => o.setName('duree').setDescription('Durée : 30m, 12h, 7d, 2w… (1 an maximum)').setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName('raison').setDescription('Raison (visible dans les logs)').setMaxLength(300)))
    .addSubcommand((s) =>
      s.setName('temporaires').setDescription('Liste les rôles temporaires en cours.')
        .addUserOption((o) => o.setName('membre').setDescription('Seulement ce membre'))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const ownerId = interaction.user.id;

    if (sub === 'list') {
      const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).toSorted((a, b) => b.position - a.position);
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

    if (sub === 'temporaires') {
      assertManageRoles(interaction);
      const user = interaction.options.getUser('membre');
      return interaction.reply({ ...tempListView(client, guild, user?.id ?? 'all', 0), ephemeral: true });
    }

    if (sub === 'create') {
      const name = interaction.options.getString('nom');
      const rawColor = interaction.options.getString('couleur')?.trim();
      if (rawColor && !HEX_COLOR.test(rawColor)) {
        throw new UserError('Couleur invalide : utilisez un code hexadécimal comme `#5865F2`.');
      }
      const color = rawColor ? `#${rawColor.replace(/^#/, '')}` : undefined;
      // `color` est déprécié depuis discord.js 14.21 : `colors.primaryColor`.
      const role = await guild.roles.create({ name, colors: color ? { primaryColor: color } : undefined, reason: `Créé par ${interaction.user.tag}` });
      return interaction.reply({
        embeds: [
          card({
            tone: primaryColor(role) || 'success',
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
      if (client?.services?.config?.get(guild.id)?.moderation?.confirmDangerous) {
        const ok = await confirm(interaction, {
          description: `Supprimer définitivement le rôle ${role} (**${members}** membre${members > 1 ? 's' : ''}) ?`,
          confirmLabel: 'Supprimer',
        });
        if (!ok) return undefined;
      }
      await role.delete(`Supprimé par ${interaction.user.tag}`);
      // Après confirmation, la carte remplace la demande (éphémère).
      const respond = (payload) => (interaction.replied || interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload));
      return respond({
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

    if (sub === 'temporaire') {
      assertManageRoles(interaction);
      if (hasForbiddenPermissions(role)) {
        throw new UserError(`Le rôle ${role.name} donne des permissions de modération ou d'administration : il ne peut pas être attribué temporairement.`);
      }
      const durationMs = tempDuration(interaction.options.getString('duree'));
      const reason = interaction.options.getString('raison')?.trim() || null;
      const { id, renewed } = await client.services.tempRoles.grant({ guild, member, role, durationMs, moderator: interaction.user, reason });
      const row = client.repositories.tempRoles.get(guild.id, id);
      return interaction.reply(tempCardView(row, { title: renewed ? 'Rôle temporaire renouvelé' : 'Rôle temporaire attribué', moderator: interaction.user, ownerId, durationMs }));
    }

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
    /** cmd:role:tlist:<filtre>:<page>[:r] — page de la liste des rôles temporaires. */
    async tlist(interaction, client, [filter, page]) {
      assertManageRoles(interaction);
      const f = listFilter(filter);
      if (f === 'card') throw new UserError('Ce bouton est invalide.');
      await interaction.update(tempListView(client, interaction.guild, f, Number(page) || 0));
    },

    /** cmd:role:tremove:<id>:<filtre|card>:<page|ownerId> — retire le rôle temporaire tout de suite. */
    async tremove(interaction, client, [id, filter, extra]) {
      const f = listFilter(filter);
      if (f === 'card' && !SNOWFLAKE.test(extra ?? '')) throw new UserError('Ce bouton est invalide.');
      const row = activeTempRow(client, interaction, id);
      assertTempAccess(interaction, row);
      await interaction.deferUpdate();
      await client.services.tempRoles.removeNow(interaction.guild, row.id, interaction.user);
      if (f === 'card') {
        await interaction.editReply(tempRemovedView(row, interaction.user, extra));
        return;
      }
      await interaction.editReply(tempListView(client, interaction.guild, f, Number(extra) || 0, `${ICONS.success} Rôle <@&${row.role_id}> retiré à <@${row.user_id}>.`));
    },

    /** cmd:role:textend:<id>:<filtre|card>:<page|ownerId> — formulaire de prolongation. */
    async textend(interaction, client, [id, filter, extra]) {
      const f = listFilter(filter);
      if (f === 'card' && !SNOWFLAKE.test(extra ?? '')) throw new UserError('Ce bouton est invalide.');
      const row = activeTempRow(client, interaction, id);
      assertTempAccess(interaction, row);
      await interaction.showModal(extendModal(row.id, f, f === 'card' ? extra : Number(extra) || 0));
    },

    /** cmd:role:textendsubmit:<id>:<filtre|card>:<page|ownerId> */
    async textendsubmit(interaction, client, [id, filter, extra]) {
      const f = listFilter(filter);
      if (f === 'card' && !SNOWFLAKE.test(extra ?? '')) throw new UserError('Formulaire invalide.');
      const row = activeTempRow(client, interaction, id);
      assertTempAccess(interaction, row);
      const addMs = tempDuration(interaction.fields.getTextInputValue('duree'));
      const expiresAt = await client.services.tempRoles.extend(interaction.guild, row.id, addMs, interaction.user);
      if (f === 'card') {
        const fresh = client.repositories.tempRoles.get(interaction.guildId, row.id);
        await interaction.update(tempCardView(fresh, { title: 'Rôle temporaire prolongé', tone: 'info', ownerId: extra }));
        return;
      }
      await interaction.update(tempListView(client, interaction.guild, f, Number(extra) || 0, `${ICONS.success} Rôle <@&${row.role_id}> de <@${row.user_id}> prolongé jusqu'à ${discordTimestamp(expiresAt, 'f')}.`));
    },

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
