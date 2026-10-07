'use strict';

const { UserError } = require('../core/errors');
const { status, deleteButton, buttonRows, ICONS } = require('../utils/ui');
const { parseColor, parseTags, buildProjectEmbed, buildTaskListEmbed } = require('../utils/projectFormat');

/**
 * Composants persistants des projets (survivent aux redémarrages) :
 *  - project:refresh:<id>  bouton « Actualiser » d'une fiche
 *  - project:tasks:<id>    bouton « Tâches » (liste complète, éphémère)
 *  - project:edit:<id>     soumission du formulaire /projet modifier (ou bouton « Modifier »)
 */

/**
 * Propriétaire du bouton 🗑️ présent sur le message (réponse de commande),
 * ou null (fiche publiée avec channel.send : pas de bouton de suppression).
 */
function deleteOwnerOf(message) {
  for (const row of message?.components ?? []) {
    for (const c of row.components ?? []) {
      const id = c.customId ?? c.custom_id ?? c.data?.custom_id;
      if (typeof id === 'string' && id.startsWith('cmd:_:delete:')) return id.split(':')[3] || null;
    }
  }
  return null;
}

/** Ajoute 🗑️ à la dernière rangée (ou à une nouvelle rangée). */
function withDelete(view, ownerId) {
  if (!ownerId) return view;
  const rows = [...view.components];
  const last = rows[rows.length - 1];
  const lastIsActions = last && last.components.length < 5 && last.components.every((c) => c.data?.style !== 5);
  if (lastIsActions) last.addComponents(deleteButton(ownerId));
  else if (rows.length < 5) rows.push(...buttonRows(deleteButton(ownerId)));
  return { ...view, components: rows };
}

module.exports = {
  id: 'project',
  deleteOwnerOf,
  async execute(interaction, client) {
    const service = client.services.projects;
    const [, action, idStr] = interaction.customId.split(':');
    const project = service.repo.get(Number(idStr));
    if (!project || project.guildId !== interaction.guildId) {
      throw new UserError('Ce projet n\'existe plus. Il a peut-être été supprimé.');
    }

    if (action === 'refresh' && interaction.isButton()) {
      // Une réponse de commande garde son bouton 🗑️ ; une fiche publiée n'en a jamais.
      const view = withDelete(service.render(project, interaction.guild), deleteOwnerOf(interaction.message));
      await interaction.update(view);
      return;
    }

    if (action === 'tasks' && interaction.isButton()) {
      const tasks = service.repo.tasks(project.id);
      await interaction.reply({ embeds: [buildTaskListEmbed(project, tasks, { guild: interaction.guild })], ephemeral: true });
      return;
    }

    if (action === 'edit' && interaction.isModalSubmit()) {
      service.assertCanEdit(project, interaction.member);
      const get = (id) => interaction.fields.getTextInputValue(id)?.trim() ?? '';
      const colorInput = get('color');
      const color = colorInput ? parseColor(colorInput) : null;
      if (colorInput && color == null) throw new UserError('Couleur invalide. Exemple : `#5865F2` (laisser vide pour la couleur du statut).');
      const updated = service.update(project, {
        name: get('name'),
        description: get('description') || null,
        tags: parseTags(get('tags')),
        imageUrl: get('image') || null,
        color,
      });
      const { tasks, members } = service.details(updated);
      await interaction.reply({
        embeds: [
          status.ok(`Projet **${updated.name}** mis à jour.${updated.messageId ? ' La fiche publiée sera actualisée automatiquement.' : ''}`),
          buildProjectEmbed(updated, { tasks, members, guild: interaction.guild }),
        ],
        ephemeral: true,
      });
      return;
    }

    throw new UserError(`Action inconnue. ${ICONS.refresh} Relancez la commande.`);
  },
};
