'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const { card, field, ICONS, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { logCard } = require('../../services/LoggingService');
const { requirePermission } = require('../../services/ModerationService');
const { roleIssue } = require('../../services/EconomyService');
const { parseEmoji } = require('../../utils/community');
const { UserError } = require('../../core/errors');
const E = require('../../utils/economy');

/**
 * /economie : tableau de bord de l'économie (éphémère, « Gérer le serveur »).
 * Vues : home · gains · rules · shop · item:<id> · confirmDelItem:<id> · manage ·
 *        member:<id> · confirmMember:<id> · confirmResetAll · stats
 * Toute opération d'administration est journalisée (logs « Serveur », événement economy).
 */

const SECTION = 'economy';
const SNOWFLAKE = /^\d{17,20}$/;
const ITEM_ID = /^\d{1,12}$/;
const OPS = Object.freeze({ give: 'Donner', take: 'Retirer', set: 'Définir' });
const OP_DONE = Object.freeze({ give: 'donnés à', take: 'retirés à', set: 'définis pour' });

const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const svcOf = (client) => client.services.economy;
const ecoOf = (client, guildId) => svcOf(client).settings(guildId);
const money = E.money;
const row = (component) => new ActionRowBuilder().addComponents(component);
const homeButton = () => actionButton({ command: 'economie', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });
const onOff = (on) => (on ? '🟢 Activé' : '🔴 Désactivé');
const plain = (text, max) => truncate(String(text ?? '').replace(/[`*_~|>]/g, '').replace(/\s+/g, ' ').trim(), max);
const itemIcon = (item) => item.emoji || (item.kind === 'role' ? ICONS.role : '📦');

const NAV = [
  { value: 'home', label: 'Accueil', emoji: '🏠', description: 'Activation, monnaie et vue d\'ensemble' },
  { value: 'gains', label: 'Gains', emoji: '💼', description: 'Récompenses quotidienne, hebdomadaire et travail' },
  { value: 'rules', label: 'Transferts et jeux', emoji: '🎲', description: 'Taxe, plafonds et mini-jeux' },
  { value: 'shop', label: 'Boutique', emoji: '🛒', description: 'Objets et rôles à vendre (25 maximum)' },
  { value: 'manage', label: 'Gestion des soldes', emoji: '🧮', description: 'Donner, retirer, définir, réinitialiser' },
  { value: 'stats', label: 'Statistiques', emoji: '📊', description: 'Masse monétaire et plus gros soldes' },
];

function navRow(current) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:economie:nav')
      .setPlaceholder('Aller à…')
      .addOptions(NAV.map((o) => ({ ...o, default: o.value === current }))),
  );
}

const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max = 100, min, required = false } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (min) t.setMinLength(min);
  if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return row(t);
};

/** Valeur saisie dans un formulaire (vide → undefined). */
function textField(interaction, id) {
  try {
    const v = interaction.fields.getTextInputValue(id)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Entier borné saisi dans un formulaire (« 1 500 » accepté). */
function amountField(interaction, id, bounds, label, { optional = false } = {}) {
  const raw = textField(interaction, id);
  if (raw === undefined) {
    if (optional) return undefined;
    throw new UserError(`${label} : ce champ est obligatoire.`);
  }
  const n = E.parseAmount(raw, bounds);
  if (n == null) throw new UserError(`${label} : entrez un nombre entier entre ${E.fmt(bounds[0])} et ${E.fmt(bounds[1])}.`);
  return n;
}

/** Texte d'une ligne (nom de monnaie, d'article) : sans retour à la ligne ni caractère de contrôle. Pur. */
function parseLabel(raw, [min, max], label) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new UserError(`${label} : de ${min} à ${max} caractères.`);
  return text;
}

/** Emoji saisi (Unicode, ou personnalisé de CE serveur). */
function parseGuildEmoji(interaction, raw, label) {
  const emoji = parseEmoji(raw);
  if (!emoji) throw new UserError(`${label} : entrez un seul emoji Unicode (🪙) ou personnalisé (\`<:nom:id>\`).`);
  if (emoji.id && !interaction.guild.emojis?.cache?.has(emoji.id)) throw new UserError(`${label} : cet emoji personnalisé n'appartient pas à ce serveur.`);
  return emoji.text;
}

/** Valeur voulue par un bouton « on/off ». */
const target = (state) => {
  if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
  return state === 'on';
};

/** Rôle vendable par le bot ET gérable par l'auteur (sauf propriétaire du serveur). */
function assertSellableRole(interaction, roleId) {
  const guild = interaction.guild;
  if (!SNOWFLAKE.test(roleId ?? '')) throw new UserError('Rôle invalide.');
  const issue = roleIssue(guild, roleId);
  if (issue) throw new UserError(`Ce rôle ne peut pas être vendu : ${issue}.`);
  const role = guild.roles.cache.get(roleId);
  if (interaction.user.id !== guild.ownerId && role.position >= (interaction.member?.roles?.highest?.position ?? 0)) {
    throw new UserError(`Le rôle ${role.name} est au-dessus (ou au niveau) de votre rôle le plus haut.`);
  }
  return role;
}

function findItem(client, guildId, rawId) {
  if (!ITEM_ID.test(rawId ?? '')) throw new UserError('Article invalide.');
  const item = svcOf(client).getItem(guildId, Number(rawId));
  if (!item) throw new UserError('Cet article n\'existe plus.');
  return item;
}

/** Journal « Serveur » (après la réponse : jamais bloquant). */
async function logAdmin(client, interaction, { icon, title, description, fields = [], tone = 'info', id }) {
  const embed = logCard({
    category: 'server',
    tone,
    icon,
    title,
    description,
    fields: [...fields, field(ICONS.moderator, 'Par', `${interaction.user}`)],
    id: id ?? interaction.user.id,
  });
  await client.services.logging?.send(interaction.guildId, 'server', embed, undefined, { event: 'economy' }).catch(() => {});
}

// ---------------------------------------------------------------- vues

function homeView(client, guild, notice) {
  const eco = ecoOf(client, guild.id);
  const stats = svcOf(client).stats(guild.id);
  return {
    embeds: [
      card({
        tone: eco.enabled ? 'success' : 'neutral',
        section: SECTION,
        icon: '🪙',
        title: 'Économie · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          eco.enabled ? '🟢 L\'économie est **active** : les membres utilisent `/eco`.' : '🔴 L\'économie est **désactivée** : `/eco` est refusé aux membres.',
          subtext(E.VIRTUAL_NOTICE),
        ],
        fields: [
          field('🪙', 'Monnaie', `${eco.currency.emoji} ${plain(eco.currency.name, 24)}`),
          field(ICONS.stats, 'Masse monétaire', money(stats.supply, eco)),
          field(ICONS.members, 'Membres avec un solde', E.fmt(stats.holders)),
          field('📅', 'Quotidien', `${money(eco.daily.amount, eco)} + ${E.fmt(eco.daily.streakBonus)} / jour de série`),
          field('💼', 'Travail', `${E.fmt(eco.work.min)}–${E.fmt(eco.work.max)} · toutes les ${eco.work.cooldownMinutes} min`),
          field('🛒', 'Boutique', `${stats.items} / ${E.MAX_ITEMS} article(s)`),
          field('🎲', 'Jeux', `Pile ou face ${eco.games.coinflip ? '🟢' : '🔴'}\nMachine à sous ${eco.games.slots ? '🟢' : '🔴'}`),
          field('🧾', 'Taxe des virements', `${eco.transfers.taxPercent} %`),
          field('🔝', 'Plafonds', `Mise ${E.fmt(eco.limits.maxBet)}\nSolde ${E.fmt(eco.limits.maxBalance)}`),
        ],
        footer: 'Choisissez une section dans le menu',
      }),
    ],
    components: [
      navRow('home'),
      ...buttonRows(
        eco.enabled
          ? actionButton({ command: 'economie', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '🔴', style: ButtonStyle.Danger })
          : actionButton({ command: 'economie', action: 'toggle', args: ['on'], label: 'Activer', emoji: '🟢', style: ButtonStyle.Success }),
        actionButton({ command: 'economie', action: 'currency', label: 'Monnaie', emoji: '🪙', style: ButtonStyle.Primary }),
        actionButton({ command: 'economie', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function gainsView(client, guild, notice) {
  const eco = ecoOf(client, guild.id);
  const maxBonus = eco.daily.streakBonus * eco.daily.streakMax;
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '💼',
        title: 'Gains',
        description: [
          notice ? `${notice}\n` : null,
          'Les membres gagnent de la monnaie chaque jour, chaque semaine et en travaillant.',
          subtext('Série quotidienne : chaque jour réclamé d\'affilée (moins de 48 h d\'écart) ajoute le bonus, jusqu\'au plafond de jours ; sinon elle repart de zéro.'),
        ],
        fields: [
          field('📅', 'Quotidien', money(eco.daily.amount, eco)),
          field('🔥', 'Bonus de série', `+${E.fmt(eco.daily.streakBonus)} / jour\n(${eco.daily.streakMax} jour(s) max · +${E.fmt(maxBonus)})`),
          field('🗓️', 'Hebdo', money(eco.weekly.amount, eco)),
          field('💼', 'Travail', `${E.fmt(eco.work.min)} à ${E.fmt(eco.work.max)}`),
          field(ICONS.duration, 'Délai de travail', `${eco.work.cooldownMinutes} min`),
          field('🔝', 'Plafond de solde', money(eco.limits.maxBalance, eco)),
        ],
        footer: 'Quotidien : toutes les 24 h · Hebdo : tous les 7 jours',
      }),
    ],
    components: [
      navRow('gains'),
      ...buttonRows(
        actionButton({ command: 'economie', action: 'daily', label: 'Quotidien et hebdo', emoji: '📅', style: ButtonStyle.Primary }),
        actionButton({ command: 'economie', action: 'work', label: 'Travail', emoji: '💼' }),
        homeButton(),
      ),
    ],
  };
}

function rulesView(client, guild, notice) {
  const eco = ecoOf(client, guild.id);
  const edge = eco.games.houseEdgePercent;
  const winChance = ((1 - edge / 100) / 2) * 100;
  const slotsRtp = E.tableReturn(E.slotsTable(edge)) * 100;
  const pctText = (n) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🎲',
        title: 'Transferts et jeux',
        description: [
          notice ? `${notice}\n` : null,
          'La taxe est prélevée sur chaque virement (et détruite). Au-delà du seuil de confirmation, l\'expéditeur doit confirmer.',
          subtext(`Jeux à espérance négative : la maison garde ${edge} % des mises en moyenne. ${E.VIRTUAL_NOTICE}`),
        ],
        fields: [
          field('🧾', 'Taxe des virements', `${eco.transfers.taxPercent} %`),
          field('✋', 'Confirmation au-delà de', eco.transfers.confirmAbove ? money(eco.transfers.confirmAbove, eco) : 'Jamais'),
          field('🔝', 'Solde maximal', money(eco.limits.maxBalance, eco)),
          field('💸', 'Mise maximale', money(eco.limits.maxBet, eco)),
          field('🏦', 'Avantage de la maison', `${edge} %`),
          field(ICONS.duration, 'Délai entre deux parties', eco.games.cooldownSeconds ? `${eco.games.cooldownSeconds} s` : 'Aucun'),
          field('🪙', 'Pile ou face', `${onOff(eco.games.coinflip)}\n${pctText(winChance)} de chances`),
          field('🎰', 'Machine à sous', `${onOff(eco.games.slots)}\nretour ${pctText(slotsRtp)}`),
        ],
        footer: 'Mises et gains restent plafonnés par le solde maximal',
      }),
    ],
    components: [
      navRow('rules'),
      ...buttonRows(
        actionButton({ command: 'economie', action: 'transfers', label: 'Transferts et plafonds', emoji: '🧾', style: ButtonStyle.Primary }),
        actionButton({ command: 'economie', action: 'games', label: 'Réglages des jeux', emoji: '🎲' }),
        eco.games.coinflip
          ? actionButton({ command: 'economie', action: 'game', args: ['coinflip', 'off'], label: 'Pile ou face ✅', emoji: '🪙' })
          : actionButton({ command: 'economie', action: 'game', args: ['coinflip', 'on'], label: 'Pile ou face ❌', emoji: '🪙' }),
        eco.games.slots
          ? actionButton({ command: 'economie', action: 'game', args: ['slots', 'off'], label: 'Machine à sous ✅', emoji: '🎰' })
          : actionButton({ command: 'economie', action: 'game', args: ['slots', 'on'], label: 'Machine à sous ❌', emoji: '🎰' }),
        homeButton(),
      ),
    ],
  };
}

function itemLine(guild, item, n, eco) {
  const kind = item.kind === 'role' ? `rôle <@&${item.role_id}>` : 'objet';
  const stock = item.stock == null ? 'stock illimité' : `stock ${E.fmt(item.stock)}`;
  const warn = item.kind === 'role' && roleIssue(guild, item.role_id) ? ` · ${ICONS.warning}` : '';
  return `**${n}.** ${itemIcon(item)} **${plain(item.name, 50)}** · ${money(item.price, eco)} · ${kind} · ${stock}${warn}`;
}

function shopView(client, guild, notice) {
  const eco = ecoOf(client, guild.id);
  const items = svcOf(client).listItems(guild.id);
  const full = items.length >= E.MAX_ITEMS;
  const components = [
    navRow('shop'),
    row(new RoleSelectMenuBuilder().setCustomId('cmd:economie:itemrole').setPlaceholder(full ? `${E.MAX_ITEMS} articles maximum` : 'Vendre un rôle : choisissez-le…').setMinValues(1).setMaxValues(1).setDisabled(full)),
  ];
  if (items.length) {
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:economie:itempick')
        .setPlaceholder('Modifier ou supprimer un article…')
        .addOptions(items.slice(0, E.MAX_ITEMS).map((item) => ({
          value: String(item.id),
          label: truncate(item.name, 100),
          description: truncate(`${E.fmt(item.price)} · ${item.kind === 'role' ? 'Rôle' : 'Objet'}${item.stock == null ? '' : ` · stock ${item.stock}`}`, 100),
          emoji: item.kind === 'role' ? ICONS.role : '📦',
        }))),
    ));
  }
  components.push(...buttonRows(
    actionButton({ command: 'economie', action: 'itemadd', label: 'Ajouter un objet', emoji: '➕', style: ButtonStyle.Primary, disabled: full }),
    homeButton(),
  ));
  const canManage = guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🛒',
        title: 'Boutique',
        description: [
          notice ? `${notice}\n` : null,
          'Vendez des **objets** virtuels (bouton « Ajouter un objet ») ou des **rôles** (menu ci-dessous). Stock facultatif.',
          canManage ? null : `${ICONS.warning} Il me manque la permission **Gérer les rôles** : les rôles ne peuvent pas être vendus.`,
          subtext('Les rôles de modération ou d\'administration, et ceux au-dessus du mien, sont refusés (vérifié à la création et à chaque achat).'),
          '',
          items.length ? truncate(items.map((it, i) => itemLine(guild, it, i + 1, eco)).join('\n'), 3000) : '*Aucun article pour l\'instant.*',
        ],
        fields: [field(ICONS.count, 'Articles', `${items.length} / ${E.MAX_ITEMS}`)],
        footer: 'Les membres achètent avec /eco boutique',
      }),
    ],
    components,
  };
}

function itemView(client, guild, rawId, notice) {
  const eco = ecoOf(client, guild.id);
  const item = findItem(client, guild.id, rawId);
  const issue = item.kind === 'role' ? roleIssue(guild, item.role_id) : null;
  const owners = item.kind === 'role' ? null : client.repositories.economy.owners(item.id);
  return {
    embeds: [
      card({
        tone: issue ? 'warning' : 'info',
        section: SECTION,
        icon: itemIcon(item),
        title: plain(item.name, 100),
        description: [
          notice ? `${notice}\n` : null,
          item.description ? plain(item.description, 300) : '*Aucune description.*',
          issue ? `\n${ICONS.warning} Ce rôle ne peut pas être vendu en l'état : ${issue}. Les achats sont refusés.` : null,
        ],
        fields: [
          field('💰', 'Prix', money(item.price, eco)),
          field(ICONS.tag, 'Type', item.kind === 'role' ? `Rôle <@&${item.role_id}>` : 'Objet'),
          field('📦', 'Stock', item.stock == null ? 'Illimité' : item.stock === 0 ? 'Épuisé' : E.fmt(item.stock)),
          owners ? field(ICONS.members, 'Détenteurs', `${E.fmt(owners.n)} membre(s) · ${E.fmt(owners.qty)} unité(s)`) : null,
          field(ICONS.date, 'Créé', discordTimestamp(item.created_at, 'R')),
        ],
        footer: `Article ${item.id}`,
      }),
    ],
    components: [
      navRow('shop'),
      ...buttonRows(
        actionButton({ command: 'economie', action: 'itemedit', args: [item.id], label: 'Modifier', emoji: '📝', style: ButtonStyle.Primary }),
        actionButton({ command: 'economie', action: 'go', args: [`confirmDelItem.${item.id}`], label: 'Supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
        actionButton({ command: 'economie', action: 'go', args: ['shop'], label: 'Retour', emoji: ICONS.back }),
      ),
    ],
  };
}

function confirmDelItemView(client, guild, rawId) {
  const item = findItem(client, guild.id, rawId);
  const owners = item.kind === 'role' ? null : client.repositories.economy.owners(item.id);
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Supprimer cet article ?',
        description: [
          `**${plain(item.name, 100)}** sera retiré de la boutique.`,
          owners?.n ? `Il disparaîtra aussi de l'inventaire de **${E.fmt(owners.n)}** membre(s).` : null,
          item.kind === 'role' ? subtext('Les rôles déjà achetés restent attribués.') : null,
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'economie', action: 'itemdelete', args: [item.id], label: 'Oui, supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'economie', action: 'go', args: [`item.${item.id}`], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

function userMenu(selected) {
  const menu = new UserSelectMenuBuilder().setCustomId('cmd:economie:member').setPlaceholder('Choisir un membre…').setMinValues(1).setMaxValues(1);
  if (selected) menu.setDefaultUsers(selected);
  return row(menu);
}

function manageView(client, guild, notice) {
  const eco = ecoOf(client, guild.id);
  const stats = svcOf(client).stats(guild.id);
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: '🧮',
        title: 'Gestion des soldes',
        description: [
          notice ? `${notice}\n` : null,
          'Choisissez un membre pour **donner**, **retirer** ou **définir** son solde, ou réinitialiser son compte.',
          subtext('Chaque opération est inscrite dans l\'historique du membre et dans les logs « Serveur ».'),
        ],
        fields: [field(ICONS.members, 'Comptes', E.fmt(stats.accounts)), field(ICONS.stats, 'Masse monétaire', money(stats.supply, eco))],
      }),
    ],
    components: [
      navRow('manage'),
      userMenu(null),
      ...buttonRows(
        actionButton({ command: 'economie', action: 'go', args: ['confirmResetAll'], label: 'Tout réinitialiser', emoji: ICONS.delete, style: ButtonStyle.Danger, disabled: !stats.accounts }),
        homeButton(),
      ),
    ],
  };
}

function memberView(client, guild, userId, notice) {
  if (!SNOWFLAKE.test(userId ?? '')) throw new UserError('Membre invalide.');
  const svc = svcOf(client);
  const eco = svc.settings(guild.id);
  const exists = client.repositories.economy.get(guild.id, userId);
  const acc = svc.account(guild.id, userId);
  const rank = svc.rank(guild.id, userId);
  const history = client.repositories.economy.history(guild.id, userId, 5);
  const when = (at) => (at ? discordTimestamp(at, 'R') : 'Jamais');
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.user,
        title: 'Compte d\'un membre',
        description: [
          notice ? `${notice}\n` : null,
          `<@${userId}> · ${money(acc.balance, eco)} · ${rank ? `#${rank}` : 'non classé'}`,
          '',
          history.length ? history.map(E.txLine).join('\n') : '*Aucune transaction.*',
        ],
        fields: [
          field('🔥', 'Série', `${E.liveStreak(acc)} jour(s)`),
          field('📅', 'Dernier quotidien', when(acc.last_daily)),
          field('💼', 'Dernier travail', when(acc.last_work)),
        ],
        footer: `Identifiant ${userId}`,
      }),
    ],
    components: [
      navRow('manage'),
      userMenu(userId),
      ...buttonRows(
        actionButton({ command: 'economie', action: 'adjust', args: ['give', userId], label: 'Donner', emoji: '➕', style: ButtonStyle.Success }),
        actionButton({ command: 'economie', action: 'adjust', args: ['take', userId], label: 'Retirer', emoji: '➖' }),
        actionButton({ command: 'economie', action: 'adjust', args: ['set', userId], label: 'Définir', emoji: '🎯', style: ButtonStyle.Primary }),
        actionButton({ command: 'economie', action: 'go', args: [`confirmMember.${userId}`], label: 'Réinitialiser', emoji: ICONS.delete, style: ButtonStyle.Danger, disabled: !exists }),
        actionButton({ command: 'economie', action: 'go', args: ['manage'], label: 'Retour', emoji: ICONS.back }),
      ),
    ],
  };
}

function confirmMemberView(client, guild, userId) {
  if (!SNOWFLAKE.test(userId ?? '')) throw new UserError('Membre invalide.');
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Réinitialiser ce membre ?',
        description: [
          `Le solde, les objets, la série et l'historique de <@${userId}> seront **définitivement effacés**.`,
          subtext('Les rôles achetés restent attribués.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'economie', action: 'reset', args: ['member', userId], label: 'Oui, réinitialiser', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'economie', action: 'go', args: [`member.${userId}`], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

function confirmResetAllView(client, guild) {
  const stats = svcOf(client).stats(guild.id);
  const eco = ecoOf(client, guild.id);
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Tout réinitialiser ?',
        description: [
          `Les **${E.fmt(stats.accounts)}** compte(s) (${money(stats.supply, eco)} au total), les inventaires et tout l'historique seront **définitivement effacés**.`,
          subtext('La boutique, les réglages et les rôles déjà achetés sont conservés.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'economie', action: 'reset', args: ['guild'], label: 'Oui, tout effacer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      actionButton({ command: 'economie', action: 'go', args: ['manage'], label: 'Annuler', emoji: ICONS.back }),
    ),
  };
}

function statsView(client, guild, notice) {
  const eco = ecoOf(client, guild.id);
  const s = svcOf(client).stats(guild.id);
  const top = client.repositories.economy.leaderboard(guild.id, 5, 0);
  const medals = ['🥇', '🥈', '🥉'];
  return {
    embeds: [
      card({
        tone: 'gold',
        section: SECTION,
        icon: ICONS.stats,
        title: 'Statistiques de l\'économie',
        description: [
          notice ? `${notice}\n` : null,
          top.length ? top.map((r, i) => `${medals[i] ?? `\`#${i + 1}\``} <@${r.user_id}> · ${money(r.balance, eco)}`).join('\n') : '*Personne n\'a encore de monnaie.*',
        ],
        fields: [
          field(ICONS.stats, 'Masse monétaire', money(s.supply, eco)),
          field(ICONS.members, 'Membres avec un solde', `${E.fmt(s.holders)} / ${E.fmt(s.accounts)}`),
          field('➗', 'Solde moyen', s.holders ? money(Math.round(s.supply / s.holders), eco) : '—'),
          field('🔝', 'Plus gros solde', money(s.richest, eco)),
          field('🔁', 'Mouvements (24 h)', E.fmt(s.recent.count)),
          field('📈', 'Création nette (24 h)', `${E.signed(s.recent.net)} ${eco.currency.emoji}`),
          field('🛒', 'Achats (24 h)', E.fmt(Math.max(0, s.recent.purchases))),
          field('📦', 'Articles en vente', `${s.items} / ${E.MAX_ITEMS}`),
        ],
        footer: 'Création nette : gains moins dépenses (taxes, achats, jeux)',
      }),
    ],
    components: [navRow('stats'), ...buttonRows(actionButton({ command: 'economie', action: 'go', args: ['stats'], label: 'Actualiser', emoji: ICONS.refresh }), homeButton())],
  };
}

/** Rend une vue (« item:<id> » depuis un menu, « item.<id> » depuis un bouton). */
function render(client, guild, view = 'home', notice) {
  const [name, arg] = String(view).split(/[:.]/);
  switch (name) {
    case 'gains':
      return gainsView(client, guild, notice);
    case 'rules':
      return rulesView(client, guild, notice);
    case 'shop':
      return shopView(client, guild, notice);
    case 'item':
      return itemView(client, guild, arg, notice);
    case 'confirmDelItem':
      return confirmDelItemView(client, guild, arg);
    case 'manage':
      return manageView(client, guild, notice);
    case 'member':
      return memberView(client, guild, arg, notice);
    case 'confirmMember':
      return confirmMemberView(client, guild, arg);
    case 'confirmResetAll':
      return confirmResetAllView(client, guild);
    case 'stats':
      return statsView(client, guild, notice);
    default:
      return homeView(client, guild, notice);
  }
}

// ---------------------------------------------------------------- formulaires

const B = E.BOUNDS;
const range = ([min, max]) => `${E.fmt(min)} à ${E.fmt(max)}`;

function currencyModal(eco) {
  return new ModalBuilder()
    .setCustomId('cmd:economie:currencysubmit')
    .setTitle('Monnaie du serveur')
    .addComponents(
      input('name', `Nom de la monnaie, au pluriel (${B.currencyName[1]} max)`, { value: eco.currency.name, max: B.currencyName[1], required: true, placeholder: 'pièces' }),
      input('emoji', 'Emoji de la monnaie', { value: eco.currency.emoji, max: 64, required: true, placeholder: '🪙' }),
    );
}

function dailyModal(eco) {
  return new ModalBuilder()
    .setCustomId('cmd:economie:dailysubmit')
    .setTitle('Récompenses quotidienne et hebdo')
    .addComponents(
      input('daily', `Montant quotidien (${range(B.dailyAmount)})`, { value: eco.daily.amount, max: 13, required: true }),
      input('bonus', 'Bonus par jour de série (0 = aucun)', { value: eco.daily.streakBonus, max: 13, required: true }),
      input('streakMax', `Jours de série comptés au maximum (0 à ${B.streakMax[1]})`, { value: eco.daily.streakMax, max: 3, required: true }),
      input('weekly', `Montant hebdomadaire (${range(B.weeklyAmount)})`, { value: eco.weekly.amount, max: 13, required: true }),
    );
}

function workModal(eco) {
  return new ModalBuilder()
    .setCustomId('cmd:economie:worksubmit')
    .setTitle('Travail')
    .addComponents(
      input('min', 'Gain minimum par travail', { value: eco.work.min, max: 13, required: true }),
      input('max', 'Gain maximum par travail', { value: eco.work.max, max: 13, required: true }),
      input('cooldown', `Délai entre deux travaux (minutes, 1 à ${B.workCooldownMinutes[1]})`, { value: eco.work.cooldownMinutes, max: 4, required: true }),
    );
}

function transfersModal(eco) {
  return new ModalBuilder()
    .setCustomId('cmd:economie:transferssubmit')
    .setTitle('Transferts et plafonds')
    .addComponents(
      input('tax', `Taxe des virements en % (0 à ${B.taxPercent[1]})`, { value: eco.transfers.taxPercent, max: 2, required: true }),
      input('confirm', 'Confirmation au-delà de (0 = jamais)', { value: eco.transfers.confirmAbove, max: 16, required: true }),
      input('maxBalance', 'Solde maximal d\'un membre', { value: eco.limits.maxBalance, max: 16, required: true }),
    );
}

function gamesModal(eco) {
  return new ModalBuilder()
    .setCustomId('cmd:economie:gamessubmit')
    .setTitle('Réglages des jeux')
    .addComponents(
      input('maxBet', 'Mise maximale', { value: eco.limits.maxBet, max: 16, required: true }),
      input('edge', `Avantage de la maison en % (${B.houseEdgePercent[0]} à ${B.houseEdgePercent[1]})`, { value: eco.games.houseEdgePercent, max: 2, required: true }),
      input('cooldown', `Délai entre deux parties (secondes, 0 à ${B.gameCooldownSeconds[1]})`, { value: eco.games.cooldownSeconds, max: 4, required: true }),
    );
}

/** Formulaire d'article : création (objet, ou rôle choisi) ou modification. */
function itemModal({ item = null, role = null } = {}) {
  const id = item ? `cmd:economie:itemupdate:${item.id}` : `cmd:economie:itemcreate:${role?.id ?? '0'}`;
  const title = item ? 'Modifier l\'article' : role ? truncate(`Vendre le rôle ${role.name}`, 45) : 'Nouvel objet';
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      input('name', `Nom de l'article (${B.itemName[1]} caractères max)`, { value: item?.name ?? (role ? truncate(role.name, B.itemName[1]) : ''), max: B.itemName[1], required: true, placeholder: 'Ticket VIP' }),
      input('price', 'Prix : nombre de pièces (1 ou plus)', { value: item?.price ?? 100, max: 16, required: true, placeholder: '100' }),
      input('description', 'Description (facultatif)', { value: item?.description, max: B.itemDescription[1], style: TextInputStyle.Paragraph, placeholder: 'Ce que l\'article apporte.' }),
      input('stock', 'Stock : nombre d\'unités (vide = illimité)', { value: item?.stock, max: 7, placeholder: 'illimité' }),
      input('emoji', 'Emoji (facultatif)', { value: item?.emoji, max: 64, placeholder: '🎟️' }),
    );
}

function adjustModal(op, userId) {
  return new ModalBuilder()
    .setCustomId(`cmd:economie:adjustsubmit:${op}:${userId}`)
    .setTitle(`${OPS[op]} de la monnaie`)
    .addComponents(input('amount', op === 'set' ? 'Nouveau solde (nombre entier)' : 'Montant (nombre entier)', { max: 16, required: true, placeholder: '500' }));
}

/** Champs d'article validés (formulaire). */
function readItemFields(interaction) {
  const name = parseLabel(textField(interaction, 'name'), B.itemName, 'Nom');
  const price = amountField(interaction, 'price', B.itemPrice, 'Prix');
  const description = textField(interaction, 'description') ?? null;
  if (description && description.length > B.itemDescription[1]) throw new UserError(`Description : ${B.itemDescription[1]} caractères maximum.`);
  const rawStock = textField(interaction, 'stock');
  const stock = rawStock === undefined || /^illimit[ée]$/i.test(rawStock) ? null : amountField(interaction, 'stock', B.itemStock, 'Stock');
  const rawEmoji = textField(interaction, 'emoji');
  const emoji = rawEmoji ? parseGuildEmoji(interaction, rawEmoji, 'Emoji') : null;
  return { name, price, description, stock, emoji };
}

const ITEM_FIELDS = (item, eco) => [
  field('💰', 'Prix', money(item.price, eco)),
  field(ICONS.tag, 'Type', item.kind === 'role' ? `Rôle <@&${item.role_id}>` : 'Objet'),
  field('📦', 'Stock', item.stock == null ? 'Illimité' : E.fmt(item.stock)),
];

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'economy',
  cooldown: 3_000,
  render,
  parseLabel,
  data: new SlashCommandBuilder()
    .setName('economie')
    .setDescription('Ouvre le tableau de bord de l\'économie : monnaie, gains, jeux, boutique et soldes.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    /** Menu de navigation. */
    async nav(interaction, client) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, interaction.values?.[0] ?? 'home'));
    },
    /** cmd:economie:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** cmd:economie:toggle:<on|off> — interrupteur général. */
    async toggle(interaction, client, [state]) {
      guard(interaction);
      const enabled = target(state);
      client.services.config.update(interaction.guildId, { economy: { enabled } });
      await interaction.update(homeView(client, interaction.guild, `${ICONS.success} Économie **${enabled ? 'activée' : 'désactivée'}**.`));
      await logAdmin(client, interaction, { icon: '🪙', title: `Économie ${enabled ? 'activée' : 'désactivée'}`, tone: enabled ? 'success' : 'warning', description: enabled ? 'Les membres peuvent utiliser `/eco`.' : '`/eco` est désormais refusé aux membres (les soldes sont conservés).' });
    },

    // ------------------------------------------------------------ réglages

    async currency(interaction, client) {
      guard(interaction);
      await interaction.showModal(currencyModal(ecoOf(client, interaction.guildId)));
    },
    async currencysubmit(interaction, client) {
      guard(interaction);
      const name = parseLabel(textField(interaction, 'name'), B.currencyName, 'Nom de la monnaie');
      const emoji = parseGuildEmoji(interaction, textField(interaction, 'emoji') ?? '', 'Emoji');
      client.services.config.update(interaction.guildId, { economy: { currency: { name, emoji } } });
      await interaction.update(homeView(client, interaction.guild, `${ICONS.success} Monnaie : ${emoji} **${plain(name, 24)}**.`));
      await logAdmin(client, interaction, { icon: '🪙', title: 'Monnaie de l\'économie modifiée', description: `${emoji} **${plain(name, 24)}**` });
    },
    async daily(interaction, client) {
      guard(interaction);
      await interaction.showModal(dailyModal(ecoOf(client, interaction.guildId)));
    },
    async dailysubmit(interaction, client) {
      guard(interaction);
      const amount = amountField(interaction, 'daily', B.dailyAmount, 'Montant quotidien');
      const streakBonus = amountField(interaction, 'bonus', B.streakBonus, 'Bonus de série');
      const streakMax = amountField(interaction, 'streakMax', B.streakMax, 'Jours de série');
      const weekly = amountField(interaction, 'weekly', B.weeklyAmount, 'Montant hebdomadaire');
      client.services.config.update(interaction.guildId, { economy: { daily: { amount, streakBonus, streakMax }, weekly: { amount: weekly } } });
      await interaction.update(gainsView(client, interaction.guild, `${ICONS.success} Récompenses enregistrées.`));
      await logAdmin(client, interaction, {
        icon: '📅',
        title: 'Récompenses de l\'économie modifiées',
        description: `Quotidien **${E.fmt(amount)}** (+${E.fmt(streakBonus)} par jour de série, ${streakMax} jour(s) max) · hebdo **${E.fmt(weekly)}**`,
      });
    },
    async work(interaction, client) {
      guard(interaction);
      await interaction.showModal(workModal(ecoOf(client, interaction.guildId)));
    },
    async worksubmit(interaction, client) {
      guard(interaction);
      const min = amountField(interaction, 'min', B.workMin, 'Gain minimum');
      const max = amountField(interaction, 'max', B.workMax, 'Gain maximum');
      if (min > max) throw new UserError('Le gain minimum doit être inférieur ou égal au gain maximum.');
      const cooldownMinutes = amountField(interaction, 'cooldown', B.workCooldownMinutes, 'Délai');
      client.services.config.update(interaction.guildId, { economy: { work: { min, max, cooldownMinutes } } });
      await interaction.update(gainsView(client, interaction.guild, `${ICONS.success} Travail : **${E.fmt(min)}** à **${E.fmt(max)}**, toutes les **${cooldownMinutes}** min.`));
      await logAdmin(client, interaction, { icon: '💼', title: 'Travail de l\'économie modifié', description: `Gain **${E.fmt(min)}** à **${E.fmt(max)}** · délai **${cooldownMinutes}** min` });
    },
    async transfers(interaction, client) {
      guard(interaction);
      await interaction.showModal(transfersModal(ecoOf(client, interaction.guildId)));
    },
    async transferssubmit(interaction, client) {
      guard(interaction);
      const taxPercent = amountField(interaction, 'tax', B.taxPercent, 'Taxe');
      const confirmAbove = amountField(interaction, 'confirm', B.confirmAbove, 'Seuil de confirmation');
      const maxBalance = amountField(interaction, 'maxBalance', B.maxBalance, 'Solde maximal');
      client.services.config.update(interaction.guildId, { economy: { transfers: { taxPercent, confirmAbove }, limits: { maxBalance } } });
      await interaction.update(rulesView(client, interaction.guild, `${ICONS.success} Transferts et plafond enregistrés.`));
      await logAdmin(client, interaction, {
        icon: '🧾',
        title: 'Transferts de l\'économie modifiés',
        description: `Taxe **${taxPercent} %** · confirmation au-delà de **${confirmAbove ? E.fmt(confirmAbove) : 'jamais'}** · solde maximal **${E.fmt(maxBalance)}**`,
      });
    },
    async games(interaction, client) {
      guard(interaction);
      await interaction.showModal(gamesModal(ecoOf(client, interaction.guildId)));
    },
    async gamessubmit(interaction, client) {
      guard(interaction);
      const maxBet = amountField(interaction, 'maxBet', B.maxBet, 'Mise maximale');
      const houseEdgePercent = amountField(interaction, 'edge', B.houseEdgePercent, 'Avantage de la maison');
      const cooldownSeconds = amountField(interaction, 'cooldown', B.gameCooldownSeconds, 'Délai entre deux parties');
      client.services.config.update(interaction.guildId, { economy: { limits: { maxBet }, games: { houseEdgePercent, cooldownSeconds } } });
      await interaction.update(rulesView(client, interaction.guild, `${ICONS.success} Réglages des jeux enregistrés.`));
      await logAdmin(client, interaction, {
        icon: '🎲',
        title: 'Jeux de l\'économie modifiés',
        description: `Mise maximale **${E.fmt(maxBet)}** · avantage de la maison **${houseEdgePercent} %** · délai **${cooldownSeconds} s**`,
      });
    },
    /** cmd:economie:game:<coinflip|slots>:<on|off> */
    async game(interaction, client, [game, state]) {
      guard(interaction);
      if (game !== 'coinflip' && game !== 'slots') throw new UserError('Ce bouton est invalide.');
      const on = target(state);
      client.services.config.update(interaction.guildId, { economy: { games: { [game]: on } } });
      const label = game === 'slots' ? 'Machine à sous' : 'Pile ou face';
      await interaction.update(rulesView(client, interaction.guild, `${ICONS.success} ${label} **${on ? 'activé' : 'désactivé'}**.`));
      await logAdmin(client, interaction, { icon: '🎲', title: `${label} ${on ? 'activé' : 'désactivé'}`, description: `Jeu de l'économie ${on ? 'ouvert' : 'fermé'} aux membres.` });
    },

    // ------------------------------------------------------------ boutique

    /** Nouvel objet : formulaire. */
    async itemadd(interaction, client) {
      guard(interaction);
      if (svcOf(client).listItems(interaction.guildId).length >= E.MAX_ITEMS) throw new UserError(`${E.MAX_ITEMS} articles maximum : supprimez-en un d'abord.`);
      await interaction.showModal(itemModal());
    },
    /** Sélecteur de rôle → formulaire de l'article (rôle vérifié avant). */
    async itemrole(interaction, client) {
      guard(interaction);
      const role = assertSellableRole(interaction, interaction.values?.[0]);
      const items = svcOf(client).listItems(interaction.guildId);
      if (items.length >= E.MAX_ITEMS) throw new UserError(`${E.MAX_ITEMS} articles maximum : supprimez-en un d'abord.`);
      if (items.some((i) => i.kind === 'role' && i.role_id === role.id)) throw new UserError('Ce rôle est déjà en vente : modifiez l\'article existant.');
      await interaction.showModal(itemModal({ role }));
    },
    /** cmd:economie:itemcreate:<roleId|0> — création (rôle revérifié : hiérarchie et permissions). */
    async itemcreate(interaction, client, [roleId]) {
      guard(interaction);
      const data = readItemFields(interaction);
      let kind = 'item';
      if (roleId && roleId !== '0') {
        assertSellableRole(interaction, roleId);
        kind = 'role';
      }
      const item = svcOf(client).addItem(interaction.guildId, { ...data, kind, roleId: kind === 'role' ? roleId : null });
      const eco = ecoOf(client, interaction.guildId);
      await interaction.update(itemView(client, interaction.guild, String(item.id), `${ICONS.success} Article ajouté à la boutique.`));
      await logAdmin(client, interaction, { icon: '🛒', title: 'Article ajouté à la boutique', tone: 'success', description: `${itemIcon(item)} **${plain(item.name, 50)}**`, fields: ITEM_FIELDS(item, eco) });
    },
    /** Menu « Modifier ou supprimer un article ». */
    async itempick(interaction, client) {
      guard(interaction);
      await interaction.update(itemView(client, interaction.guild, interaction.values?.[0]));
    },
    /** cmd:economie:itemedit:<id> — formulaire prérempli. */
    async itemedit(interaction, client, [id]) {
      guard(interaction);
      await interaction.showModal(itemModal({ item: findItem(client, interaction.guildId, id) }));
    },
    /** cmd:economie:itemupdate:<id> */
    async itemupdate(interaction, client, [id]) {
      guard(interaction);
      const current = findItem(client, interaction.guildId, id);
      const data = readItemFields(interaction);
      const item = svcOf(client).updateItem(interaction.guildId, current.id, data);
      const eco = ecoOf(client, interaction.guildId);
      await interaction.update(itemView(client, interaction.guild, String(item.id), `${ICONS.success} Article modifié.`));
      await logAdmin(client, interaction, { icon: '📝', title: 'Article de la boutique modifié', description: `${itemIcon(item)} **${plain(item.name, 50)}**${current.name !== item.name ? ` (anciennement **${plain(current.name, 50)}**)` : ''}`, fields: ITEM_FIELDS(item, eco) });
    },
    /** cmd:economie:itemdelete:<id> — après confirmation. */
    async itemdelete(interaction, client, [id]) {
      guard(interaction);
      const item = svcOf(client).deleteItem(interaction.guildId, findItem(client, interaction.guildId, id).id);
      await interaction.update(shopView(client, interaction.guild, `${ICONS.success} **${plain(item.name, 50)}** retiré de la boutique.`));
      await logAdmin(client, interaction, { icon: ICONS.delete, title: 'Article retiré de la boutique', tone: 'warning', description: `${itemIcon(item)} **${plain(item.name, 50)}**` });
    },

    // ------------------------------------------------------------ soldes

    /** Sélecteur de membre (vue « Gestion des soldes »). */
    async member(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0];
      if (!SNOWFLAKE.test(id ?? '')) throw new UserError('Membre invalide.');
      const user = interaction.users?.get?.(id) ?? interaction.guild.members?.cache?.get(id)?.user;
      if (user?.bot) throw new UserError('Les bots n\'ont pas de compte.');
      await interaction.update(memberView(client, interaction.guild, id));
    },
    /** cmd:economie:adjust:<give|take|set>:<userId> — ouvre le formulaire. */
    async adjust(interaction, client, [op, userId]) {
      guard(interaction);
      if (!OPS[op] || !SNOWFLAKE.test(userId ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.showModal(adjustModal(op, userId));
    },
    /** cmd:economie:adjustsubmit:<op>:<userId> */
    async adjustsubmit(interaction, client, [op, userId]) {
      guard(interaction);
      if (!OPS[op] || !SNOWFLAKE.test(userId ?? '')) throw new UserError('Formulaire invalide.');
      const amount = amountField(interaction, 'amount', [op === 'set' ? 0 : 1, E.HARD_MAX], 'Montant');
      const eco = ecoOf(client, interaction.guildId);
      const r = svcOf(client).adminAdjust(interaction.guildId, userId, op, amount, interaction.user.id);
      const notice = [
        `${ICONS.success} ${money(amount, eco)} ${OP_DONE[op]} <@${userId}> : ${E.fmt(r.before)} → **${E.fmt(r.after)}**.`,
        r.capped ? subtext(op === 'take' ? 'Le solde ne descend jamais sous zéro.' : 'Montant limité par le plafond de solde.') : null,
      ].filter(Boolean).join('\n');
      await interaction.update(memberView(client, interaction.guild, userId, notice));
      await logAdmin(client, interaction, {
        icon: op === 'take' ? '➖' : op === 'give' ? '➕' : '🎯',
        title: `Solde ajusté (${OPS[op].toLowerCase()})`,
        description: `<@${userId}> : ${E.fmt(r.before)} → **${E.fmt(r.after)}** ${eco.currency.emoji}`,
        fields: [field('💰', 'Montant saisi', money(amount, eco))],
        id: userId,
      });
    },
    /** cmd:economie:reset:guild · cmd:economie:reset:member:<id> — après confirmation. */
    async reset(interaction, client, [scope, userId]) {
      guard(interaction);
      if (scope === 'guild') {
        const n = svcOf(client).resetGuild(interaction.guildId);
        await interaction.update(manageView(client, interaction.guild, `${ICONS.success} ${E.fmt(n)} compte(s) réinitialisé(s).`));
        await logAdmin(client, interaction, { icon: ICONS.delete, title: 'Économie entièrement réinitialisée', tone: 'danger', description: `**${E.fmt(n)}** compte(s), les inventaires et l'historique ont été effacés.` });
        return;
      }
      if (scope !== 'member' || !SNOWFLAKE.test(userId ?? '')) throw new UserError('Ce bouton est invalide.');
      const existed = svcOf(client).resetMember(interaction.guildId, userId);
      await interaction.update(memberView(client, interaction.guild, userId, existed ? `${ICONS.success} Compte de <@${userId}> réinitialisé.` : `${ICONS.info} <@${userId}> n'avait pas de compte.`));
      if (existed) await logAdmin(client, interaction, { icon: ICONS.delete, title: 'Compte d\'économie réinitialisé', tone: 'warning', description: `Solde, objets et historique de <@${userId}> effacés.`, id: userId });
    },
  },
};
