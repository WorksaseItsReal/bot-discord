'use strict';

const { UserError } = require('../core/errors');
const { embeds, truncate } = require('../utils/embeds');
const { parseColor, parseTags, buildProjectEmbed } = require('../utils/projectFormat');

/**
 * Composants persistants des projets (survivent aux redémarrages) :
 *  - project:refresh:<id>  bouton « Actualiser » d'une fiche
 *  - project:tasks:<id>    bouton « Tâches » (liste complète, éphémère)
 *  - project:edit:<id>     soumission du formulaire /projet modifier
 */
module.exports = {
  id: 'project',
  async execute(interaction, client) {
    const service = client.services.projects;
    const [, action, idStr] = interaction.customId.split(':');
    const project = service.repo.get(Number(idStr));
    if (!project || project.guildId !== interaction.guildId) {
      throw new UserError('Ce projet n\'existe plus.');
    }

    if (action === 'refresh' && interaction.isButton()) {
      await interaction.update(service.render(project, interaction.guild));
      return;
    }

    if (action === 'tasks' && interaction.isButton()) {
      const tasks = service.repo.tasks(project.id);
      const lines = tasks.map((t, i) => `\`${String(i + 1).padStart(2, ' ')}\` ${t.done ? '✅' : '⬜'} ${t.done ? `~~${truncate(t.title, 100)}~~` : truncate(t.title, 100)}${t.done && t.doneBy ? ` — <@${t.doneBy}>` : ''}`);
      const done = tasks.filter((t) => t.done).length;
      await interaction.reply({
        embeds: [
          embeds
            .custom(0x5865f2, `🧩 Tâches de ${project.name}`)
            .setDescription(lines.join('\n') || '*Aucune tâche.*')
            .addFields({ name: 'Avancement', value: `**${done}/${tasks.length}** terminée${done > 1 ? 's' : ''}` }),
        ],
        ephemeral: true,
      });
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
          embeds.success(`Projet **${updated.name}** mis à jour.${updated.messageId ? ' La fiche publiée sera actualisée automatiquement.' : ''}`),
          buildProjectEmbed(updated, { tasks, members, guild: interaction.guild }),
        ],
        ephemeral: true,
      });
    }
  },
};
