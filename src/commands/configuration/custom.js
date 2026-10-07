'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { paginate } = require('../../utils/pagination');
const { card, field, wide, subtext, code, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { renderTag, tagCard } = require('../utility/tag');

/** Tags par page de /custom list. */
const PER_PAGE = 8;
const VARIABLES = '{user} · {server} · {membercount}';
/** Nom de tag : lettres (toutes langues), chiffres, « _ » et « - » ; au moins une lettre ou un chiffre. */
const TAG_NAME = /^(?=.*[\p{L}\p{N}])[\p{L}\p{N}_-]{1,32}$/u;

/** Normalise et valide un nom de tag saisi (minuscules, espaces → « - »). */
function normalizeTagName(input) {
  const name = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!TAG_NAME.test(name)) {
    throw new UserError('Nom de tag invalide : 32 caractères maximum, uniquement des lettres, des chiffres, « _ » et « - ».');
  }
  return name;
}

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

module.exports = {
  category: 'configuration',
  normalizeTagName,
  data: new SlashCommandBuilder()
    .setName('custom')
    .setDescription('Gère les commandes personnalisées (tags).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName('create').setDescription('Crée/modifie un tag.')
        .addStringOption((o) => o.setName('nom').setDescription('Nom du tag (lettres, chiffres, _ et -)').setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName('contenu').setDescription('Contenu (variables: {user} {server} {membercount})').setRequired(true).setMaxLength(2000)))
    .addSubcommand((s) =>
      s.setName('delete').setDescription('Supprime un tag.').addStringOption((o) => o.setName('nom').setDescription('Nom').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les tags.')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const repo = client.repositories.customCommands;
    const guildId = interaction.guild.id;

    if (sub === 'create') {
      const name = normalizeTagName(interaction.options.getString('nom'));
      const content = interaction.options.getString('contenu');
      if (!content.trim()) throw new UserError('Le contenu du tag ne peut pas être vide.');
      if (content.length > 2000) throw new UserError('Le contenu du tag est trop long (2000 caractères max).');
      const existed = Boolean(repo.get(guildId, name));
      repo.set({ guildId, name, content, createdBy: interaction.user.id });
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
      const pages = [];
      for (let i = 0; i < list.length; i += PER_PAGE) {
        pages.push(
          card({
            tone: 'neutral',
            section: 'configuration',
            icon: ICONS.tag,
            title: 'Tags du serveur',
            description: [`**${list.length}** tag${list.length > 1 ? 's' : ''}`, subtext('Afficher un tag : /tag <nom>')],
            fields: list.slice(i, i + PER_PAGE).map((t) =>
              wide(ICONS.tag, t.name, `${t.created_by ? `${ICONS.user} <@${t.created_by}>\n` : ''}${subtext(oneLine(t.content))}`),
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
      // Aperçu identique au rendu de /tag (toujours une carte).
      await interaction.reply({
        embeds: [tagCard(tag.name, content)],
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
    },
  },
};
