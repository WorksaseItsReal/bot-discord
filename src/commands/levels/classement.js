'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, ICONS, subtext, actionButton, labelButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/**
 * /classement : classement XP du serveur, 10 membres par page.
 * Boutons persistants : cmd:classement:page:<page>:<auteur> · cmd:classement:me:<auteur>
 */

const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const SNOWFLAKE = /^\d{17,20}$/;

const fmt = (n) => Number(n ?? 0).toLocaleString('fr-FR');

/** Système désactivé : message clair (UserError, éphémère). */
function assertEnabled(client, guildId) {
  if (!client.services.config.get(guildId).levels?.enabled) {
    throw new UserError('Le système de niveaux n\'est pas activé sur ce serveur. Un administrateur peut l\'activer avec `/niveaux`.');
  }
}

/** Page (0-indexée) où figure un rang donné. Pur. */
const pageOfRank = (rank) => (rank ? Math.floor((rank - 1) / PAGE_SIZE) : 0);

/** Une ligne du classement. Pur. */
function boardLine(row, position) {
  const medal = MEDALS[position - 1] ?? `\`#${position}\``;
  return `${medal} <@${row.user_id}> · Niv. **${row.level}** · ${fmt(row.xp)} XP`;
}

/**
 * Rendu d'une page du classement.
 * @param {number} page page demandée (0-indexée, bornée)
 * @param {string} ownerId auteur (bouton 🗑️)
 */
function render(client, guild, page, ownerId, notice) {
  const repo = client.repositories.levels;
  const total = repo.count(guild.id);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
  const rows = repo.leaderboard(guild.id, PAGE_SIZE, p * PAGE_SIZE);
  const embed = card({
    tone: 'gold',
    section: 'levels',
    icon: '🏆',
    title: `Classement · ${guild.name}`,
    description: [
      notice ? `${notice}\n` : null,
      rows.length ? rows.map((r, i) => boardLine(r, p * PAGE_SIZE + i + 1)).join('\n') : 'Personne n\'a encore gagné d\'XP. Écrivez quelques messages pour ouvrir le bal !',
      '',
      subtext('📍 « Ma page » affiche la page où vous figurez.'),
    ],
    footer: `Page ${p + 1}/${pages} · ${total} membre(s) classé(s)`,
  });
  const nav = pages > 1
    ? [
      actionButton({ command: 'classement', action: 'page', args: [Math.max(0, p - 1), ownerId], emoji: ICONS.back, disabled: p === 0 }),
      labelButton(`Page ${p + 1}/${pages}`),
      actionButton({ command: 'classement', action: 'page', args: [Math.min(pages - 1, p + 1), ownerId], emoji: ICONS.next, disabled: p === pages - 1 }),
    ]
    : [];
  return {
    embeds: [embed],
    components: buttonRows(
      ...nav,
      actionButton({ command: 'classement', action: 'me', args: [ownerId], label: 'Ma page', emoji: '📍', style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'levels',
  cooldown: 3_000,
  render,
  pageOfRank,
  boardLine,
  assertEnabled,
  PAGE_SIZE,
  data: new SlashCommandBuilder()
    .setName('classement')
    .setDescription('Affiche le classement XP du serveur.')
    .addIntegerOption((o) => o.setName('page').setDescription('Page à afficher (1 par défaut)').setMinValue(1).setMaxValue(10_000)),

  async execute(interaction, client) {
    assertEnabled(client, interaction.guildId);
    const page = (interaction.options.getInteger('page') ?? 1) - 1;
    await interaction.reply(render(client, interaction.guild, page, interaction.user.id));
  },

  buttons: {
    /** cmd:classement:page:<page>:<auteur> — tout le monde peut feuilleter le classement public. */
    async page(interaction, client, [page, ownerId]) {
      if (!/^\d{1,5}$/.test(page ?? '') || !SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      assertEnabled(client, interaction.guildId);
      await interaction.update(render(client, interaction.guild, Number(page), ownerId));
    },
    /** cmd:classement:me:<auteur> — page de la personne qui clique. */
    async me(interaction, client, [ownerId]) {
      if (!SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      assertEnabled(client, interaction.guildId);
      const rank = client.repositories.levels.rank(interaction.guildId, interaction.user.id);
      if (!rank) throw new UserError('Vous n\'avez pas encore d\'XP sur ce serveur : écrivez quelques messages !');
      await interaction.update(render(client, interaction.guild, pageOfRank(rank), ownerId, `📍 Page de ${interaction.user} · **#${rank}**`));
    },
  },
};
