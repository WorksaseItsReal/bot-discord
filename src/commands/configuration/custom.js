'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { paginate } = require('../../utils/pagination');
const { card, field, wide, subtext, code, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { renderTag } = require('../utility/tag');

/** Tags par page de /custom list. */
const PER_PAGE = 8;
const VARIABLES = '{user} · {server} · {membercount}';

/** Les boutons revérifient la permission par défaut de la commande. */
function assertManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('Il faut la permission **Gérer le serveur** pour gérer les tags.');
  }
}

/** Contenu affiché dans un bloc de code (sans casser la clôture). */
function codeBlock(text, max = 1000) {
  return `\`\`\`\n${truncate(String(text).replace(/```/g, 'ˋˋˋ'), max - 8)}\n\`\`\``;
}

/** Aperçu d'une ligne (liste). */
function oneLine(text, max = 90) {
  return truncate(String(text).replace(/\s+/g, ' ').trim(), max);
}

function formatLabel(isEmbed) {
  return isEmbed ? `${ICONS.image} Embed` : `${ICONS.reason} Texte`;
}

module.exports = {
  category: 'configuration',
  data: new SlashCommandBuilder()
    .setName('custom')
    .setDescription('Gère les commandes personnalisées (tags).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée/modifie un tag.')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du tag').setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName('contenu').setDescription('Contenu (variables: {user} {server} {membercount})').setRequired(true).setMaxLength(2000))
        .addBooleanOption((o) => o.setName('embed').setDescription('Afficher en embed ?')))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un tag.').addStringOption((o) => o.setName('nom').setDescription('Nom').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les tags.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.customCommands;
    const guildId = interaction.guild.id;

    if (sub === 'create') {
      const name = interaction.options.getString('nom').toLowerCase().replace(/\s+/g, '-').slice(0, 32);
      const content = interaction.options.getString('contenu');
      if (!name.replace(/-/g, '')) throw new UserError('Nom de tag invalide.');
      if (name.includes(':')) throw new UserError('Le nom d\'un tag ne peut pas contenir « : ».');
      if (!content.trim()) throw new UserError('Le contenu du tag ne peut pas être vide.');
      if (content.length > 2000) throw new UserError('Le contenu du tag est trop long (2000 caractères max).');
      const existed = Boolean(repo.get(guildId, name));
      const isEmbed = interaction.options.getBoolean('embed') ? 1 : 0;
      repo.set({ guildId, name, content, isEmbed, createdBy: interaction.user.id });
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'configuration',
            icon: ICONS.success,
            title: existed ? 'Tag mis à jour' : 'Tag créé',
            description: [`Utilisez **/tag ${name}** pour l'afficher.`, subtext(`Variables disponibles : ${VARIABLES}`)],
            fields: [
              field(ICONS.tag, 'Nom', code(name)),
              field(ICONS.status, 'Format', formatLabel(isEmbed)),
              field(ICONS.count, 'Longueur', `${content.length} car.`),
              wide(ICONS.reason, 'Contenu', codeBlock(content)),
            ],
          }),
        ],
        components: buttonRows(actionButton({ command: 'custom', action: 'test', args: [name], label: 'Tester', emoji: ICONS.next, style: ButtonStyle.Primary })),
        ephemeral: true,
      });
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('nom').toLowerCase();
      if (!repo.delete(guildId, name)) throw new UserError(`Tag introuvable : ${code(truncate(name, 32))}. Voir \`/custom list\`.`);
      return interaction.reply({
        embeds: [
          card({
            tone: 'danger',
            section: 'configuration',
            icon: ICONS.delete,
            title: 'Tag supprimé',
            description: `${code(name)} n'est plus disponible via \`/tag\`.`,
          }),
        ],
        ephemeral: true,
      });
    }

    if (sub === 'list') {
      const list = repo.list(guildId);
      if (!list.length) {
        return interaction.reply({
          embeds: [card({ tone: 'info', section: 'configuration', icon: ICONS.tag, title: 'Aucun tag', description: ['Créez-en un avec `/custom create`.', subtext(`Variables : ${VARIABLES}`)] })],
          ephemeral: true,
        });
      }
      const embedCount = list.filter((t) => t.is_embed).length;
      const pages = [];
      for (let i = 0; i < list.length; i += PER_PAGE) {
        pages.push(
          card({
            tone: 'neutral',
            section: 'configuration',
            icon: ICONS.tag,
            title: 'Tags du serveur',
            description: [`**${list.length}** tag${list.length > 1 ? 's' : ''} · ${embedCount} en embed`, subtext('Afficher un tag : /tag <nom>')],
            fields: list.slice(i, i + PER_PAGE).map((t) =>
              wide(ICONS.tag, t.name, `${formatLabel(t.is_embed)}${t.created_by ? ` · ${ICONS.user} <@${t.created_by}>` : ''}\n${subtext(oneLine(t.content))}`),
            ),
            footer: `Variables : ${VARIABLES}`,
          }),
        );
      }
      return paginate(interaction, pages, { ephemeral: true });
    }
    throw new UserError('Sous-commande inconnue.');
  },

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase();
    const list = client.repositories.customCommands.list(interaction.guild.id);
    await interaction.respond(list.filter((c) => c.name.includes(focused)).slice(0, 25).map((c) => ({ name: c.name, value: c.name })));
  },

  buttons: {
    /** cmd:custom:test:<nom> — aperçu éphémère du rendu de /tag. */
    async test(interaction, client, [name]) {
      assertManageGuild(interaction);
      const tag = client.repositories.customCommands.get(interaction.guildId, name);
      if (!tag) throw new UserError(`Le tag ${code(truncate(name ?? '?', 32))} n'existe plus.`);
      const content = renderTag(tag.content, { user: interaction.user, guild: interaction.guild });
      await interaction.reply({
        embeds: [
          card({
            tone: 'neutral',
            section: { emoji: ICONS.next, label: `Aperçu · /tag ${tag.name}` },
            title: tag.is_embed ? tag.name : undefined,
            description: [
              truncate(content, 3900) || '​',
              '',
              subtext(tag.is_embed ? 'Rendu en embed, comme avec /tag.' : 'Envoyé en texte simple par /tag (aperçu en carte ici).'),
            ],
          }),
        ],
        ephemeral: true,
      });
    },
  },
};
