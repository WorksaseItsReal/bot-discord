'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, wide, ICONS, subtext, status, actionButton, labelButton, deleteButton, buttonRows, ButtonStyle, code } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { confirm } = require('../../utils/confirmation');
const { requirePermission } = require('../../services/ModerationService');
const { UserError } = require('../../core/errors');

/**
 * /invitations : suivi des invitations.
 *   voir [membre] · classement [page] · reinitialiser [membre] (Gérer le serveur) · reglages (Gérer le serveur)
 * Boutons persistants : cmd:invitations:page:<page>:<auteur> · cmd:invitations:member:<auteur>
 */

const PAGE_SIZE = 10;
const MAX_ACTIVE = 8;
const MAX_FAKE_DAYS = 90;
const MEDALS = ['🥇', '🥈', '🥉'];
const SNOWFLAKE = /^\d{17,20}$/;
const SECTION = { emoji: '📨', label: 'Invitations' };

const fmt = (n) => Number(n ?? 0).toLocaleString('fr-FR');
const plural = (n, word) => `${fmt(n)} ${word}${n > 1 ? 's' : ''}`;

/** Avertissement si le suivi ne peut pas fonctionner. */
function trackingNotice(client, guild) {
  const state = client.services.invites?.state(guild);
  if (state === 'noperm') return `${ICONS.warning} Il me manque la permission **Gérer le serveur** : je ne peux pas lire les invitations, les nouvelles arrivées ne sont pas attribuées.`;
  if (state === 'error') return `${ICONS.warning} La lecture des invitations a échoué : les prochaines arrivées pourraient ne pas être attribuées.`;
  return null;
}

/** Une invitation active (pur). */
function inviteLine(entry, now = Date.now()) {
  const uses = entry.maxUses ? `**${fmt(entry.uses)}**/${fmt(entry.maxUses)}` : `**${fmt(entry.uses)}**`;
  return [
    code(entry.code),
    `${uses} utilisation${entry.uses > 1 ? 's' : ''}`,
    entry.channelId ? `<#${entry.channelId}>` : null,
    entry.expiresAt && entry.expiresAt > now ? `expire ${discordTimestamp(entry.expiresAt, 'R')}` : 'permanente',
  ].filter(Boolean).join(' · ');
}

/** Carte d'un membre : réelles, départs, fausses, net et invitations actives. */
function memberView(client, guild, user, ownerId) {
  const stats = client.repositories.inviteJoins.stats(guild.id, user.id);
  const active = client.services.invites?.invitesOf(guild.id, user.id) ?? [];
  const days = client.services.invites?.fakeDays(guild.id) ?? 7;
  const notice = trackingNotice(client, guild);
  const list = active.slice(0, MAX_ACTIVE).map((e) => `› ${inviteLine(e)}`);
  if (active.length > MAX_ACTIVE) list.push(subtext(`… et ${active.length - MAX_ACTIVE} autre(s).`));
  const activeUses = active.reduce((n, e) => n + e.uses, 0);
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: ICONS.link,
        title: `Invitations · ${user.username ?? user.id}`,
        description: [
          `${user} a **${plural(stats.net, 'invitation')}** au total net.`,
          notice ? `\n${notice}` : null,
        ],
        thumbnail: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null,
        fields: [
          field(ICONS.success, 'Réelles', `**${fmt(stats.regular)}**`),
          field('📤', 'Départs', `**${fmt(stats.left)}**`),
          field(ICONS.warning, 'Fausses', `**${fmt(stats.fake)}**`),
          field(ICONS.count, 'Total net', `**${fmt(stats.net)}**`),
          field(ICONS.stats, 'Utilisations actives', `**${fmt(activeUses)}**`),
          wide(ICONS.list, `Invitations actives (${active.length})`, list.length ? list.join('\n') : '*Aucune invitation active.*'),
        ],
        footer: days > 0 ? `Fausse : compte de moins de ${days} jour(s) à l'arrivée · Net = réelles − départs` : 'Net = réelles − départs',
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'invitations', action: 'page', args: [0, ownerId], label: 'Classement', emoji: '🏆', style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

/** Une ligne du classement (pur). */
function boardLine(row, position) {
  const medal = MEDALS[position - 1] ?? `\`#${position}\``;
  return `${medal} <@${row.inviterId}> · **${fmt(row.net)}** · ${fmt(row.regular)} réelle(s), ${fmt(row.left)} départ(s), ${fmt(row.fake)} fausse(s)`;
}

/** Page du classement (0-indexée, bornée). */
function boardView(client, guild, page, ownerId) {
  const repo = client.repositories.inviteJoins;
  const total = repo.inviterCount(guild.id);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
  const rows = repo.leaderboard(guild.id, PAGE_SIZE, p * PAGE_SIZE);
  const notice = trackingNotice(client, guild);
  const nav = pages > 1
    ? [
      actionButton({ command: 'invitations', action: 'page', args: [Math.max(0, p - 1), ownerId], emoji: ICONS.back, disabled: p === 0 }),
      labelButton(`Page ${p + 1}/${pages}`),
      actionButton({ command: 'invitations', action: 'page', args: [Math.min(pages - 1, p + 1), ownerId], emoji: ICONS.next, disabled: p === pages - 1 }),
    ]
    : [];
  return {
    embeds: [
      card({
        tone: 'gold',
        section: SECTION,
        icon: '🏆',
        title: `Classement des invitations · ${guild.name}`,
        description: [
          notice ? `${notice}\n` : null,
          rows.length ? rows.map((r, i) => boardLine(r, p * PAGE_SIZE + i + 1)).join('\n') : 'Aucune invitation attribuée pour le moment.',
          '',
          subtext('Classement par total net (réelles − départs).'),
        ],
        footer: `Page ${p + 1}/${pages} · ${plural(total, 'inviteur')}`,
      }),
    ],
    components: buttonRows(
      ...nav,
      actionButton({ command: 'invitations', action: 'member', args: [ownerId], label: 'Mes invitations', emoji: ICONS.user }),
      deleteButton(ownerId),
    ),
  };
}

module.exports = {
  category: 'information',
  cooldown: 3_000,
  memberView,
  boardView,
  boardLine,
  inviteLine,
  PAGE_SIZE,
  data: new SlashCommandBuilder()
    .setName('invitations')
    .setDescription('Suivi des invitations : qui a invité qui, classement.')
    .addSubcommand((s) => s
      .setName('voir')
      .setDescription('Invitations d\'un membre : réelles, départs, fausses, invitations actives.')
      .addUserOption((o) => o.setName('membre').setDescription('Membre (vous par défaut)')))
    .addSubcommand((s) => s
      .setName('classement')
      .setDescription('Classement des membres qui ont le plus invité.')
      .addIntegerOption((o) => o.setName('page').setDescription('Page à afficher (1 par défaut)').setMinValue(1).setMaxValue(10_000)))
    .addSubcommand((s) => s
      .setName('reinitialiser')
      .setDescription('Remet à zéro le suivi du serveur ou d\'un membre (Gérer le serveur).')
      .addUserOption((o) => o.setName('membre').setDescription('Inviteur à remettre à zéro (tout le serveur par défaut)')))
    .addSubcommand((s) => s
      .setName('reglages')
      .setDescription('Âge minimal du compte pour qu\'une invitation compte comme réelle (Gérer le serveur).')
      .addIntegerOption((o) => o.setName('jours').setDescription('Âge minimal en jours (0 : aucune fausse invitation)').setRequired(true).setMinValue(0).setMaxValue(MAX_FAKE_DAYS))),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (sub === 'voir') {
      const user = interaction.options.getUser('membre') ?? interaction.user;
      // Cache encore vide (démarrage, permission rendue) : première lecture avant d'afficher.
      if (!client.services.invites?.hasSnapshot(guild.id) && client.services.invites?.state(guild) !== 'noperm') {
        await interaction.deferReply();
        await client.services.invites.refresh(guild).catch(() => null);
        await interaction.editReply(memberView(client, guild, user, interaction.user.id));
        return;
      }
      await interaction.reply(memberView(client, guild, user, interaction.user.id));
      return;
    }
    if (sub === 'classement') {
      const page = (interaction.options.getInteger('page') ?? 1) - 1;
      await interaction.reply(boardView(client, guild, page, interaction.user.id));
      return;
    }
    if (sub === 'reglages') {
      requirePermission(interaction, 'ManageGuild');
      const days = interaction.options.getInteger('jours', true);
      if (!Number.isInteger(days) || days < 0 || days > MAX_FAKE_DAYS) throw new UserError(`Choisissez un nombre de jours entre 0 et ${MAX_FAKE_DAYS}.`);
      client.services.config.update(guild.id, { invites: { fakeAccountDays: days } });
      await interaction.reply({
        embeds: [status.ok(days > 0
          ? `Une arrivée dont le compte a moins de **${plural(days, 'jour')}** comptera comme une invitation **fausse**.`
          : 'Plus aucune invitation ne sera comptée comme fausse.', 'Réglage enregistré', { footer: 'S\'applique aux prochaines arrivées' })],
        components: buttonRows(actionButton({ command: 'invitations', action: 'page', args: ['0', interaction.user.id], label: 'Classement', emoji: '🏆' })),
        ephemeral: true,
      });
      return;
    }
    // reinitialiser
    requirePermission(interaction, 'ManageGuild');
    const target = interaction.options.getUser('membre');
    const ok = await confirm(interaction, {
      description: target
        ? `Remettre à zéro les invitations de ${target} ? Son historique d'arrivées attribuées sera **définitivement effacé**.`
        : 'Remettre à zéro **tout** le suivi des invitations du serveur ? L\'historique et le classement seront **définitivement effacés**.',
      confirmLabel: 'Réinitialiser',
    });
    if (!ok) return;
    // Permission revérifiée après le délai de confirmation.
    requirePermission(interaction, 'ManageGuild');
    const n = client.repositories.inviteJoins.reset(guild.id, target?.id ?? null);
    await interaction.editReply({
      embeds: [status.ok(`${plural(n, 'arrivée')} effacée${n > 1 ? 's' : ''} ${target ? `pour ${target}` : 'sur le serveur'}.`, 'Invitations réinitialisées')],
      components: [],
    });
  },

  buttons: {
    /** cmd:invitations:page:<page>:<auteur> — classement public, feuilletable par tous. */
    async page(interaction, client, [page, ownerId]) {
      if (!/^\d{1,5}$/.test(page ?? '') || !SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.update(boardView(client, interaction.guild, Number(page), ownerId));
    },
    /** cmd:invitations:member:<auteur> — carte de la personne qui clique. */
    async member(interaction, client, [ownerId]) {
      if (!SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.update(memberView(client, interaction.guild, interaction.user, ownerId));
    },
  },
};
