'use strict';

const { card, field, ICONS, status, subtext } = require('../utils/ui');
const { resetSelectMenu } = require('../utils/components');
const { hasForbiddenPermissions } = require('../commands/roles/rolemenu');

/**
 * Gestionnaire du select menu de rôles auto-attribuables.
 * customId: `rolemenu:<id>`
 *
 * Le menu est partagé par tous les membres (aucune présélection possible) :
 * chaque rôle SÉLECTIONNÉ est basculé (ajouté s'il manque, retiré sinon).
 * Les rôles non sélectionnés ne sont jamais touchés, et seuls les rôles de CE
 * menu peuvent être modifiés. Après traitement, le menu public est remis à zéro :
 * sinon le client renverrait la sélection précédente au clic suivant (et
 * inverserait des rôles que le membre n'a pas touchés).
 */
module.exports = {
  id: 'rolemenu',
  /** @param {import('discord.js').StringSelectMenuInteraction} interaction */
  async execute(interaction, client) {
    if (!interaction.isStringSelectMenu()) return;
    try {
      await handle(interaction, client);
    } finally {
      await resetSelectMenu(interaction);
    }
  },
};

/** @param {import('discord.js').StringSelectMenuInteraction} interaction */
async function handle(interaction, client) {
  await interaction.deferReply({ ephemeral: true });

  const record = client.repositories.roleMenus.getByMessage(interaction.message.id);
  if (!record || record.guild_id !== interaction.guildId) {
    await interaction.reply({ embeds: [status.warn('Ce menu de rôles n\'existe plus. Demandez au staff d\'en publier un nouveau.', 'Menu expiré')], ephemeral: true });
    return;
  }

  const menuRoles = new Set((record.data?.roles ?? []).map((r) => r.roleId));
  const me = interaction.guild.members.me;
  const added = [];
  const removed = [];
  const failed = [];

  for (const roleId of new Set(interaction.values)) {
    if (!menuRoles.has(roleId)) continue;
    const role = interaction.guild.roles.cache.get(roleId);
    // Rôle supprimé, devenu sensible ou passé au-dessus du bot depuis la création du menu.
    if (!role || role.managed || hasForbiddenPermissions(role) || role.position >= me.roles.highest.position) {
      failed.push(roleId);
      continue;
    }
    const has = interaction.member.roles.cache.has(roleId);
    try {
      if (has) {
        await interaction.member.roles.remove(roleId, 'Menu de rôles');
        removed.push(roleId);
      } else {
        await interaction.member.roles.add(roleId, 'Menu de rôles');
        added.push(roleId);
      }
    } catch {
      failed.push(roleId);
    }
  }

  const mentions = (ids) => ids.map((r) => `<@&${r}>`).join(' ');
  if (!added.length && !removed.length && !failed.length) {
    await interaction.reply({ embeds: [status.note('Aucun changement : sélectionnez un rôle pour l\'obtenir ou le retirer.', 'Vos rôles')], ephemeral: true });
    return;
  }
  const tone = failed.length && !added.length && !removed.length ? 'danger' : failed.length ? 'warning' : 'success';
  await interaction.reply({
    embeds: [
      card({
        tone,
        section: 'roles',
        icon: tone === 'success' ? ICONS.success : tone === 'danger' ? ICONS.error : ICONS.warning,
        title: tone === 'danger' ? 'Aucun rôle modifié' : 'Vos rôles ont été mis à jour',
        description: tone === 'danger' ? 'Je n\'ai pu modifier aucun des rôles choisis.' : subtext('Resélectionnez un rôle pour annuler.'),
        fields: [
          added.length ? field('➕', 'Ajoutés', mentions(added), false) : null,
          removed.length ? field('➖', 'Retirés', mentions(removed), false) : null,
          failed.length ? field(ICONS.error, 'Impossibles à modifier', `${mentions(failed)}\n${subtext('Prévenez le staff : rôle supprimé, trop haut ou devenu sensible.')}`, false) : null,
        ],
        timestamp: false,
      }),
    ],
    ephemeral: true,
  });
}
