'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { progressBar } = require('../../utils/embeds');
const { card, field, ICONS, subtext, actionButton, deleteButton, labelButton, buttonRows, status, ButtonStyle } = require('../../utils/ui');
const { assertInvoker } = require('../../utils/buttonGuard');
const { paginate } = require('../../utils/pagination');
const { UserError } = require('../../core/errors');
const { ensureMembers, lazyRolePages, PARTIAL_NOTE } = require('./inrole');
const { LIST_TYPES, canViewRestricted, collect, buildListPage, pageCount } = require('../../utils/memberLists');

/**
 * /membres : compteur de membres (sans option, inchangé) ou listes (`liste`) : administrateurs et
 * modérateurs (réservées à « Exclure temporairement » ou « Gérer le serveur », éphémères), bots,
 * boosters, membres en vocal (salons vus par le lecteur, éphémère) et membres d'un rôle (/inrole).
 * Pages de 20 lignes, boutons cmd:membres:list:<type>:<page>:<ownerId> (permission revérifiée).
 */

/** Délai entre deux listes d'un même membre (téléchargement de la liste des membres). */
const LIST_COOLDOWN_MS = 10_000;
const LIST_CHOICES = [
  { name: 'Administrateurs (modération)', value: 'admins' },
  { name: 'Modérateurs (modération)', value: 'moderateurs' },
  { name: 'Bots', value: 'bots' },
  { name: 'Boosters', value: 'boosters' },
  { name: 'En vocal', value: 'vocal' },
  { name: 'Membres d\'un rôle', value: 'role' },
];

const fr = (n) => Number(n || 0).toLocaleString('fr-FR');
const percent = (part, total) => `${Math.round((part / Math.max(1, total)) * 100)} %`;

/** Compteurs du serveur (withCounts donne des valeurs approximatives sans télécharger toute la liste). */
async function counts(client, guild) {
  const fresh = await client.guilds.fetch({ guild: guild.id, withCounts: true, force: true }).catch(() => guild);
  const total = fresh.approximateMemberCount ?? guild.memberCount;
  const online = fresh.approximatePresenceCount ?? null;
  const cacheComplete = guild.members.cache.size >= guild.memberCount;
  const bots = cacheComplete ? guild.members.cache.filter((m) => m.user.bot).size : null;
  return { total, online, bots };
}

/** Rendu pur à partir des compteurs. */
function render(guild, { total, online, bots }, ownerId) {
  const fields = [field(ICONS.members, 'Total', `**${fr(total)}**`)];
  if (online != null) fields.push(field('🟢', 'En ligne', `**${fr(online)}** · ${percent(online, total)}`));
  fields.push(field(ICONS.boost, 'Boosts', `**${fr(guild.premiumSubscriptionCount ?? 0)}**`));
  if (bots != null) {
    fields.push(
      field(ICONS.user, 'Humains', `**${fr(total - bots)}** · ${percent(total - bots, total)}`),
      field(ICONS.bot, 'Bots', `**${fr(bots)}** · ${percent(bots, total)}`),
    );
  }
  return {
    embeds: [
      card({
        tone: 'brand',
        section: 'information',
        icon: ICONS.members,
        title: `Membres de ${guild.name}`,
        description: [
          `**${fr(total)}** membres${online != null ? `, dont **${fr(online)}** en ligne` : ''}.`,
          online != null ? `\`${progressBar(online / Math.max(1, total), 16)}\`` : null,
          subtext(online != null ? 'Barre : part des membres actuellement en ligne.' : 'Présences indisponibles pour le moment.'),
        ],
        thumbnail: guild.iconURL?.({ size: 256 }),
        fields,
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'membres', action: 'refresh', args: [ownerId], label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

function assertCanSee(interaction, type) {
  if (LIST_TYPES[type]?.restricted && !canViewRestricted(interaction.memberPermissions)) {
    throw new UserError('Cette liste est réservée à la modération : il vous faut **Exclure temporairement des membres** ou **Gérer le serveur**.');
  }
}

/** Données d'une liste (membres chargés au besoin, sauf pour le vocal). */
async function listData(interaction, client, type) {
  const guild = interaction.guild;
  const { partial } = type === 'vocal' ? { partial: false } : await ensureMembers(guild, client);
  const cfg = client.services?.config?.get?.(guild.id) ?? {};
  const data = collect(type, {
    guild,
    members: [...guild.members.cache.values()],
    viewer: interaction.member,
    trustedBots: Array.isArray(cfg.secur?.trustedBots) ? cfg.secur.trustedBots : [],
    voiceStates: [...(guild.voiceStates?.cache?.values?.() ?? [])],
  });
  return { data, partial };
}

/** Vue d'une page (carte + navigation ; 🗑️ sur les listes publiques). */
function listView(interaction, type, data, page, partial, ownerId) {
  const pages = pageCount(data.rows.length);
  const i = Math.min(Math.max(0, page), pages - 1);
  const nav = pages > 1
    ? [
      actionButton({ command: 'membres', action: 'list', args: [type, Math.max(0, i - 1), ownerId], emoji: ICONS.back, disabled: i === 0 }),
      labelButton(`${i + 1} / ${pages}`),
      actionButton({ command: 'membres', action: 'list', args: [type, Math.min(pages - 1, i + 1), ownerId], emoji: ICONS.next, disabled: i === pages - 1 }),
    ]
    : [];
  return {
    embeds: [buildListPage(type, data, i, { guildName: interaction.guild.name, partial, partialNote: PARTIAL_NOTE })],
    components: buttonRows(...nav, LIST_TYPES[type].ephemeral ? null : deleteButton(ownerId)),
  };
}

async function listCommand(interaction, client, type) {
  const role = interaction.options.getRole('role');
  if (type !== 'role' && role) throw new UserError('L\'option « role » ne sert qu\'avec la liste **Membres d\'un rôle**.');
  if (type === 'role' && !role) throw new UserError('Choisissez le rôle avec l\'option « role ».');
  if (type !== 'role' && !LIST_TYPES[type]) throw new UserError('Liste inconnue.');
  assertCanSee(interaction, type);
  const left = client.cooldowns?.hit?.(`membres-liste:${interaction.user.id}`, LIST_COOLDOWN_MS) ?? 0;
  if (left > 0) throw new UserError(`Patientez **${Math.ceil(left / 1000)} s** avant de demander une autre liste.`);
  const ephemeral = type !== 'role' && LIST_TYPES[type].ephemeral;
  // Chargement de la liste des membres : peut prendre quelques secondes sur un gros serveur.
  await interaction.deferReply({ ephemeral });
  if (type === 'role') {
    const { partial } = await ensureMembers(interaction.guild, client);
    const fullRole = interaction.guild.roles.cache.get(role.id) || role;
    const members = [...(fullRole.members?.values?.() ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
    if (!members.length) {
      return interaction.editReply({ embeds: [status.note(`Aucun membre n'a le rôle ${role} pour le moment.${partial ? `\n${subtext(PARTIAL_NOTE)}` : ''}`, 'Rôle vide')] });
    }
    return paginate(interaction, lazyRolePages(fullRole, members, { partial }));
  }
  const { data, partial } = await listData(interaction, client, type);
  return interaction.editReply(listView(interaction, type, data, 0, partial, interaction.user.id));
}

module.exports = {
  render,
  data: new SlashCommandBuilder()
    .setName('membres')
    .setDescription('Compteur de membres, ou listes : admins, modérateurs, bots, boosters, vocal, rôle.')
    .addStringOption((o) => o.setName('liste').setDescription('Liste à afficher (sans option : le compteur)').addChoices(...LIST_CHOICES))
    .addRoleOption((o) => o.setName('role').setDescription('Rôle dont lister les membres (avec la liste « Membres d\'un rôle »)')),
  async execute(interaction, client) {
    const type = interaction.options.getString('liste') ?? (interaction.options.getRole('role') ? 'role' : null);
    if (type) return listCommand(interaction, client, type);
    await interaction.deferReply();
    await interaction.editReply(render(interaction.guild, await counts(client, interaction.guild), interaction.user.id));
  },
  buttons: {
    /** cmd:membres:list:<type>:<page>:<ownerId> — page d'une liste (permission revérifiée). */
    async list(interaction, client, [type, rawPage, ownerId]) {
      assertInvoker(interaction, ownerId);
      if (!Object.hasOwn(LIST_TYPES, type ?? '')) throw new UserError('Liste inconnue.');
      assertCanSee(interaction, type);
      const page = Math.max(0, Math.min(10_000, Number.parseInt(rawPage, 10) || 0));
      await interaction.deferUpdate();
      const { data, partial } = await listData(interaction, client, type);
      await interaction.editReply(listView(interaction, type, data, page, partial, ownerId));
    },
    /** cmd:membres:refresh:<ownerId> */
    async refresh(interaction, client, [ownerId]) {
      assertInvoker(interaction, ownerId);
      await interaction.deferUpdate();
      await interaction.editReply(render(interaction.guild, await counts(client, interaction.guild), ownerId));
    },
  },
};
