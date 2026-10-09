'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { card, field, wide, ICONS, subtext, actionButton, labelButton, deleteButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { confirm } = require('../../utils/confirmation');
const { assertInvoker } = require('../../utils/buttonGuard');
const { applyRoles } = require('../../utils/memberRoles');
const { roleIssue } = require('../../services/EconomyService');
const { createLogger } = require('../../core/logger');
const { UserError } = require('../../core/errors');
const E = require('../../utils/economy');

/**
 * /eco : économie du serveur côté membres (monnaie virtuelle sans valeur réelle).
 *  solde · quotidien · hebdo · travail · payer · boutique · inventaire · classement ·
 *  pile-ou-face · machine-a-sous · historique
 *
 * Boutons persistants :
 *  cmd:eco:shop:<page>:<origine>          boutique (éphémère) : page, actualiser
 *  cmd:eco:buy:<article>:<jeton>:<page>   achat (jeton = dernier achat connu : anti-double-clic)
 *  cmd:eco:inv                            inventaire (depuis la boutique)
 *  cmd:eco:top:<page>:<auteur> · cmd:eco:topme:<auteur>   classement public
 *  cmd:eco:replay:<jeu>:<mise>:<choix>:<auteur>           rejouer (auteur seulement)
 */

const logger = createLogger('economy');
const SECTION = 'economy';
const SNOWFLAKE = /^\d{17,20}$/;
const SHOP_PAGE = 5;
const BOARD_PAGE = 10;
const HISTORY_SIZE = 15;
const MAX_PAGE = 999;
const MEDALS = ['🥇', '🥈', '🥉'];
const GAMES = Object.freeze({
  coinflip: { label: 'Pile ou face', icon: '🪙', command: 'pile-ou-face' },
  slots: { label: 'Machine à sous', icon: '🎰', command: 'machine-a-sous' },
});
const SIDES = Object.freeze({ pile: 'Pile', face: 'Face' });

const svcOf = (client) => client.services.economy;
const money = E.money;
const pct = (n) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
const clampPage = (page, pages) => Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
const nameOf = (user, member) => truncate(member?.displayName ?? user?.displayName ?? user?.globalName ?? user?.username ?? 'Membre', 64);
/** Texte libre (nom d'article…) sans mise en forme cassée. */
const plain = (text, max) => truncate(String(text ?? '').replace(/[`*_~|>]/g, '').replace(/\s+/g, ' ').trim(), max);
const itemIcon = (item) => item.emoji || (item.kind === 'role' ? ICONS.role : '📦');

// ---------------------------------------------------------------- solde

function balanceView(client, guild, user, member, viewerId, now = Date.now()) {
  const svc = svcOf(client);
  const eco = svc.settings(guild.id);
  const acc = svc.account(guild.id, user.id);
  const rank = svc.rank(guild.id, user.id);
  const self = user.id === viewerId;
  const when = (next) => (next ? discordTimestamp(next, 'R') : `${ICONS.success} Disponible`);
  const daily = E.dailyReward(eco, acc, now);
  return {
    embeds: [
      card({
        tone: 'gold',
        section: SECTION,
        icon: '💰',
        title: `Solde · ${nameOf(user, member)}`,
        description: [`${user} possède ${money(acc.balance, eco)} ${plain(eco.currency.name, 24)}.`],
        fields: [
          field('🏆', 'Rang', rank ? `#${rank}` : 'Non classé'),
          field('🔥', 'Série quotidienne', `${E.liveStreak(acc, now)} jour(s)`),
          field(ICONS.stats, 'Plafond', money(eco.limits.maxBalance, eco)),
          self ? field('📅', 'Quotidien', when(daily.ready ? null : daily.nextAt)) : null,
          self ? field('🗓️', 'Hebdo', when(E.weeklyNext(acc, now))) : null,
          self ? field('💼', 'Travail', when(E.workNext(eco, acc, now))) : null,
        ],
        footer: 'Monnaie virtuelle sans valeur réelle',
      }),
    ],
  };
}

// ---------------------------------------------------------------- gains

function gainCard({ icon, title, lines, eco, balance, capped }) {
  return card({
    tone: 'success',
    section: SECTION,
    icon,
    title,
    description: [...lines, capped ? subtext(`Gain limité par le plafond de solde (${E.fmt(eco.limits.maxBalance)}).`) : null],
    fields: [field('💰', 'Nouveau solde', money(balance, eco))],
    footer: 'Monnaie virtuelle sans valeur réelle',
  });
}

// ---------------------------------------------------------------- boutique

function shopView(client, guild, userId, page = 0, notice, { ownedRoles = [] } = {}) {
  const svc = svcOf(client);
  const eco = svc.settings(guild.id);
  const items = svc.listItems(guild.id);
  const acc = svc.account(guild.id, userId);
  const token = svc.purchaseToken(guild.id, userId);
  const member = guild.members?.cache?.get(userId);
  const owns = (roleId) => ownedRoles.includes(roleId) || Boolean(member?.roles?.cache?.has(roleId));
  const pages = Math.max(1, Math.ceil(items.length / SHOP_PAGE));
  const p = clampPage(page, pages);
  const slice = items.slice(p * SHOP_PAGE, p * SHOP_PAGE + SHOP_PAGE);
  const lines = [];
  const buyButtons = [];
  slice.forEach((item, i) => {
    const n = p * SHOP_PAGE + i + 1;
    const isRole = item.kind === 'role';
    const issue = isRole ? roleIssue(guild, item.role_id) : null;
    const owned = isRole && owns(item.role_id);
    const soldOut = item.stock === 0;
    const meta = [
      isRole ? `Rôle <@&${item.role_id}>` : 'Objet',
      item.stock == null ? 'Stock illimité' : soldOut ? '**Rupture de stock**' : `Stock : ${E.fmt(item.stock)}`,
      owned ? 'déjà obtenu' : null,
      issue ? `${ICONS.warning} indisponible` : null,
    ].filter(Boolean).join(' · ');
    lines.push(`**${n}.** ${itemIcon(item)} **${plain(item.name, 50)}** · ${money(item.price, eco)}`);
    lines.push(subtext(meta));
    if (item.description) lines.push(subtext(plain(item.description, 200)));
    const canBuy = !soldOut && !owned && !issue && acc.balance >= item.price;
    buyButtons.push(actionButton({
      command: 'eco',
      action: 'buy',
      args: [item.id, token, p],
      label: `${n}. Acheter · ${plain(item.name, 30)}`,
      emoji: '🛒',
      style: canBuy ? ButtonStyle.Success : ButtonStyle.Secondary,
      disabled: !canBuy,
    }));
  });
  const nav = pages > 1
    ? [
      actionButton({ command: 'eco', action: 'shop', args: [Math.max(0, p - 1), 'prev'], emoji: ICONS.back, disabled: p === 0 }),
      labelButton(`Page ${p + 1}/${pages}`),
      actionButton({ command: 'eco', action: 'shop', args: [Math.min(pages - 1, p + 1), 'next'], emoji: ICONS.next, disabled: p === pages - 1 }),
    ]
    : [];
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: '🛒',
        title: `Boutique · ${plain(guild.name, 80)}`,
        description: [
          notice ? `${notice}\n` : null,
          `Votre solde : ${money(acc.balance, eco)}`,
          '',
          lines.length ? lines.join('\n') : '*La boutique est vide pour l\'instant. Les administrateurs l\'alimentent avec `/economie`.*',
        ],
        footer: `${items.length} article(s) · Monnaie virtuelle sans valeur réelle`,
      }),
    ],
    components: [
      ...buttonRows(...buyButtons),
      ...buttonRows(
        ...nav,
        actionButton({ command: 'eco', action: 'shop', args: [p, 'ref'], label: 'Actualiser', emoji: ICONS.refresh }),
        actionButton({ command: 'eco', action: 'inv', label: 'Inventaire', emoji: '🎒' }),
      ),
    ],
  };
}

function inventoryView(client, guild, userId, notice) {
  const svc = svcOf(client);
  const eco = svc.settings(guild.id);
  const rows = svc.inventory(guild.id, userId);
  const lines = rows.map((r) => `${r.emoji || '📦'} **${plain(r.name, 50)}** × ${E.fmt(r.quantity)}\n${subtext(`Dernier achat ${discordTimestamp(r.acquired_at, 'R')}`)}`);
  return {
    embeds: [
      card({
        tone: 'brand',
        section: SECTION,
        icon: '🎒',
        title: 'Votre inventaire',
        description: [
          notice ? `${notice}\n` : null,
          lines.length ? truncate(lines.join('\n'), 3500) : '*Aucun objet pour l\'instant : faites un tour à la boutique !*',
          '',
          subtext('Les rôles achetés vous sont attribués directement et n\'apparaissent pas ici.'),
        ],
        fields: [field('💰', 'Solde', money(svc.account(guild.id, userId).balance, eco)), field(ICONS.count, 'Objets différents', `${rows.length}`)],
        footer: 'Monnaie virtuelle sans valeur réelle',
      }),
    ],
    components: buttonRows(actionButton({ command: 'eco', action: 'shop', args: [0, 'inv'], label: 'Boutique', emoji: '🛒', style: ButtonStyle.Primary })),
  };
}

// ---------------------------------------------------------------- classement

function boardView(client, guild, page, ownerId, notice) {
  const repo = client.repositories.economy;
  const eco = svcOf(client).settings(guild.id);
  const total = repo.countRanked(guild.id);
  const pages = Math.max(1, Math.ceil(total / BOARD_PAGE));
  const p = clampPage(page, pages);
  const rows = repo.leaderboard(guild.id, BOARD_PAGE, p * BOARD_PAGE);
  const line = (r, pos) => `${MEDALS[pos - 1] ?? `\`#${pos}\``} <@${r.user_id}> · ${money(r.balance, eco)}`;
  const nav = pages > 1
    ? [
      actionButton({ command: 'eco', action: 'top', args: [Math.max(0, p - 1), ownerId], emoji: ICONS.back, disabled: p === 0 }),
      labelButton(`Page ${p + 1}/${pages}`),
      actionButton({ command: 'eco', action: 'top', args: [Math.min(pages - 1, p + 1), ownerId], emoji: ICONS.next, disabled: p === pages - 1 }),
    ]
    : [];
  return {
    embeds: [
      card({
        tone: 'gold',
        section: SECTION,
        icon: '🏆',
        title: `Les plus riches · ${plain(guild.name, 80)}`,
        description: [
          notice ? `${notice}\n` : null,
          rows.length ? rows.map((r, i) => line(r, p * BOARD_PAGE + i + 1)).join('\n') : 'Personne n\'a encore de monnaie. Commencez par `/eco quotidien` !',
          '',
          subtext('📍 « Ma page » affiche la page où vous figurez.'),
        ],
        footer: `Page ${p + 1}/${pages} · ${total} membre(s) classé(s) · Monnaie virtuelle`,
      }),
    ],
    components: buttonRows(
      ...nav,
      actionButton({ command: 'eco', action: 'topme', args: [ownerId], label: 'Ma page', emoji: '📍', style: ButtonStyle.Primary }),
      deleteButton(ownerId),
    ),
  };
}

// ---------------------------------------------------------------- historique

function historyView(client, guild, userId) {
  const repo = client.repositories.economy;
  const eco = svcOf(client).settings(guild.id);
  const rows = repo.history(guild.id, userId, HISTORY_SIZE);
  return {
    embeds: [
      card({
        tone: 'neutral',
        section: SECTION,
        icon: ICONS.history,
        title: 'Vos dernières transactions',
        description: rows.length ? rows.map(E.txLine).join('\n') : '*Aucune transaction pour l\'instant.*',
        fields: [field('💰', 'Solde', money(svcOf(client).account(guild.id, userId).balance, eco))],
        footer: `${HISTORY_SIZE} dernières · Monnaie virtuelle sans valeur réelle`,
      }),
    ],
  };
}

// ---------------------------------------------------------------- jeux

function slotsTableText(table) {
  const triples = [...table].reverse().map((s) => `${s.emoji.repeat(3)} ${E.multText(s.tripleCents)}`);
  const pairs = [...table].reverse().map((s) => `${s.emoji}${s.emoji} ${E.multText(s.pairCents)}`);
  return `${triples.join(' · ')}\n${subtext(`Paires : ${pairs.join(' · ')}`)}`;
}

function gameView(eco, game, r, user, choice) {
  const meta = GAMES[game];
  const result = r.delta > 0
    ? `${ICONS.success} Gagné : **${E.signed(r.delta)}** ${eco.currency.emoji}`
    : r.delta < 0 ? `${ICONS.error} Perdu : **${E.signed(r.delta)}** ${eco.currency.emoji}` : `${ICONS.info} Mise récupérée : **±0** ${eco.currency.emoji}`;
  let headline;
  if (game === 'coinflip') headline = `La pièce tourne… et tombe sur **${SIDES[r.side].toUpperCase()}** !`;
  else {
    const what = r.kind === 'triple' ? `Trois ${r.symbol} : ${E.multText(r.cents)} la mise !` : r.kind === 'pair' ? `Deux ${r.symbol} : ${E.multText(r.cents)} la mise.` : 'Aucune combinaison cette fois…';
    headline = `**[ ${r.reels.join(' | ')} ]**\n${what}`;
  }
  const odds = game === 'coinflip'
    ? `Chances de gain : ${pct(r.winChance * 100)} pour un gain du double de la mise.`
    : `Retour moyen : ${pct(E.tableReturn(r.table) * 100)} des mises.`;
  return {
    embeds: [
      card({
        tone: r.delta > 0 ? 'celebrate' : 'fun',
        section: SECTION,
        icon: meta.icon,
        title: meta.label,
        description: [
          headline,
          result,
          r.capped ? subtext('Gain limité par le plafond de solde.') : null,
          '',
          subtext(`${odds} Jeu à espérance négative : en moyenne, la maison gagne (avantage : ${r.edge} %).`),
          subtext(E.VIRTUAL_NOTICE),
        ],
        fields: [
          game === 'coinflip' ? field('🎯', 'Votre choix', SIDES[choice]) : null,
          field('💸', 'Mise', money(r.bet, eco)),
          field('💰', 'Solde', money(r.balance, eco)),
          game === 'slots' ? wide('📜', 'Table des gains', slotsTableText(r.table)) : null,
        ],
        footer: `${nameOf(user)} · Monnaie virtuelle sans valeur réelle`,
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'eco', action: 'replay', args: [game, r.bet, choice ?? 'pile', user.id], label: 'Rejouer', emoji: meta.icon, style: ButtonStyle.Primary }),
      deleteButton(user.id),
    ),
  };
}

// ---------------------------------------------------------------- virements

function transferCard(eco, from, to, r) {
  return card({
    tone: 'success',
    section: SECTION,
    icon: '💸',
    title: 'Virement effectué',
    description: [`${from} a envoyé ${money(r.amount, eco)} à ${to}.`],
    fields: [
      field('📥', 'Reçu', money(r.received, eco)),
      field('🧾', 'Taxe', r.tax ? `${money(r.tax, eco)} (${eco.transfers.taxPercent} %)` : 'Aucune'),
      field('💰', 'Solde de l\'expéditeur', money(r.fromBalance, eco)),
    ],
    footer: 'Monnaie virtuelle sans valeur réelle',
  });
}

/** Membre (GuildMember) de la personne qui clique. */
async function selfMember(interaction) {
  if (interaction.member?.roles?.cache) return interaction.member;
  return interaction.guild.members.fetch(interaction.user.id);
}

// ---------------------------------------------------------------- commande

module.exports = {
  category: 'economy',
  cooldown: 1_000,
  balanceView,
  shopView,
  inventoryView,
  boardView,
  historyView,
  gameView,
  data: new SlashCommandBuilder()
    .setName('eco')
    .setDescription('Économie du serveur : solde, gains, boutique, mini-jeux et classement.')
    .addSubcommand((s) => s.setName('solde').setDescription('Affiche votre solde ou celui d\'un membre.')
      .addUserOption((o) => o.setName('membre').setDescription('Membre à consulter (vous par défaut)')))
    .addSubcommand((s) => s.setName('quotidien').setDescription('Récupère votre récompense quotidienne (bonus de série).'))
    .addSubcommand((s) => s.setName('hebdo').setDescription('Récupère votre récompense hebdomadaire.'))
    .addSubcommand((s) => s.setName('travail').setDescription('Travaille pour gagner un peu de monnaie.'))
    .addSubcommand((s) => s.setName('payer').setDescription('Envoie de la monnaie à un membre.')
      .addUserOption((o) => o.setName('membre').setDescription('Destinataire').setRequired(true))
      .addIntegerOption((o) => o.setName('montant').setDescription('Montant à envoyer').setRequired(true).setMinValue(1).setMaxValue(E.HARD_MAX)))
    .addSubcommand((s) => s.setName('boutique').setDescription('Ouvre la boutique du serveur.')
      .addIntegerOption((o) => o.setName('page').setDescription('Page à afficher (1 par défaut)').setMinValue(1).setMaxValue(MAX_PAGE)))
    .addSubcommand((s) => s.setName('inventaire').setDescription('Affiche vos objets achetés.'))
    .addSubcommand((s) => s.setName('classement').setDescription('Classement des membres les plus riches.')
      .addIntegerOption((o) => o.setName('page').setDescription('Page à afficher (1 par défaut)').setMinValue(1).setMaxValue(10_000)))
    .addSubcommand((s) => s.setName('pile-ou-face').setDescription('Pariez sur pile ou face (monnaie virtuelle, espérance négative).')
      .addIntegerOption((o) => o.setName('mise').setDescription('Montant misé').setRequired(true).setMinValue(1).setMaxValue(E.HARD_MAX))
      .addStringOption((o) => o.setName('choix').setDescription('Pile ou face (pile par défaut)').addChoices({ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' })))
    .addSubcommand((s) => s.setName('machine-a-sous').setDescription('Tentez la machine à sous (monnaie virtuelle, espérance négative).')
      .addIntegerOption((o) => o.setName('mise').setDescription('Montant misé').setRequired(true).setMinValue(1).setMaxValue(E.HARD_MAX)))
    .addSubcommand((s) => s.setName('historique').setDescription('Affiche vos dernières transactions.')),

  async execute(interaction, client) {
    const svc = svcOf(client);
    const guild = interaction.guild;
    const eco = svc.assertEnabled(interaction.guildId);
    const user = interaction.user;
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case 'solde': {
        const target = interaction.options.getUser('membre') ?? user;
        if (target.bot) throw new UserError('Les bots n\'ont pas de compte.');
        const member = target.id === user.id ? interaction.member : interaction.options.getMember('membre');
        await interaction.reply(balanceView(client, guild, target, member, user.id));
        return;
      }
      case 'quotidien': {
        const r = svc.claimDaily(guild.id, user.id);
        const bonus = r.bonus ? ` dont **${E.fmt(r.bonus)}** de bonus de série` : '';
        await interaction.reply({
          embeds: [gainCard({
            icon: '📅',
            title: 'Récompense quotidienne',
            lines: [
              `${user} reçoit ${money(r.credited, eco)}${bonus}.`,
              `🔥 Série : **${r.streak}** jour(s) d'affilée.`,
              subtext(`Revenez ${discordTimestamp(Date.now() + E.DAY_MS, 'R')} ; sans réclamation pendant 48 h, la série repart de zéro.`),
            ],
            eco,
            balance: r.balance,
            capped: r.capped,
          })],
        });
        return;
      }
      case 'hebdo': {
        const r = svc.claimWeekly(guild.id, user.id);
        await interaction.reply({
          embeds: [gainCard({
            icon: '🗓️',
            title: 'Récompense hebdomadaire',
            lines: [`${user} reçoit ${money(r.credited, eco)}.`, subtext(`Prochaine récompense ${discordTimestamp(Date.now() + E.WEEK_MS, 'R')}.`)],
            eco,
            balance: r.balance,
            capped: r.capped,
          })],
        });
        return;
      }
      case 'travail': {
        const r = svc.work(guild.id, user.id);
        await interaction.reply({
          embeds: [gainCard({
            icon: '💼',
            title: 'Travail',
            lines: [r.template.replace('{montant}', money(r.credited, eco)), subtext(`Prochain travail ${discordTimestamp(r.nextAt, 'R')}.`)],
            eco,
            balance: r.balance,
            capped: r.capped,
          })],
        });
        return;
      }
      case 'payer': {
        const to = interaction.options.getUser('membre', true);
        const amount = interaction.options.getInteger('montant', true);
        if (to.bot) throw new UserError('Vous ne pouvez pas payer un bot.');
        if (to.id === user.id) throw new UserError('Vous ne pouvez pas vous payer vous-même.');
        if (!interaction.options.getMember('membre')) throw new UserError('Ce membre n\'est pas sur le serveur.');
        const { tax, received } = svc.checkTransfer(guild.id, user.id, to.id, amount);
        const threshold = eco.transfers.confirmAbove;
        if (threshold > 0 && amount > threshold) {
          const ok = await confirm(interaction, {
            description: [
              `Envoyer ${money(amount, eco)} à ${to} ?`,
              tax ? `Taxe de **${eco.transfers.taxPercent} %** : ${to} recevra ${money(received, eco)}.` : null,
            ].filter(Boolean).join('\n'),
            confirmLabel: 'Payer',
          });
          if (!ok) return;
          // Solde relu dans la transaction : il a pu changer pendant la confirmation.
          const r = svc.transfer(guild.id, user.id, to.id, amount);
          await interaction.editReply({ embeds: [transferCard(eco, user, to, r)], components: [] });
          await interaction.followUp({ embeds: [transferCard(eco, user, to, r)] }).catch((e) => logger.debug('Annonce du virement :', e?.message));
          return;
        }
        const r = svc.transfer(guild.id, user.id, to.id, amount);
        await interaction.reply({ embeds: [transferCard(eco, user, to, r)] });
        return;
      }
      case 'boutique': {
        const page = (interaction.options.getInteger('page') ?? 1) - 1;
        await interaction.reply({ ...shopView(client, guild, user.id, page), ephemeral: true });
        return;
      }
      case 'inventaire':
        await interaction.reply({ ...inventoryView(client, guild, user.id), ephemeral: true });
        return;
      case 'classement': {
        const page = (interaction.options.getInteger('page') ?? 1) - 1;
        await interaction.reply(boardView(client, guild, page, user.id));
        return;
      }
      case 'pile-ou-face':
      case 'machine-a-sous': {
        const game = sub === 'machine-a-sous' ? 'slots' : 'coinflip';
        const bet = interaction.options.getInteger('mise', true);
        const choice = interaction.options.getString('choix') === 'face' ? 'face' : 'pile';
        const r = svc.play(guild.id, user.id, game, bet, { choice });
        await interaction.reply(gameView(eco, game, r, user, choice));
        return;
      }
      case 'historique':
        await interaction.reply({ ...historyView(client, guild, user.id), ephemeral: true });
        return;
      default:
        throw new UserError('Sous-commande inconnue.');
    }
  },

  buttons: {
    /** cmd:eco:shop:<page>:<origine> — page de la boutique (pour la personne qui clique). */
    async shop(interaction, client, [page]) {
      svcOf(client).assertEnabled(interaction.guildId);
      if (!/^\d{1,3}$/.test(page ?? '')) throw new UserError('Ce bouton est invalide.');
      await interaction.update(shopView(client, interaction.guild, interaction.user.id, Number(page)));
    },
    /** cmd:eco:inv — inventaire de la personne qui clique. */
    async inv(interaction, client) {
      svcOf(client).assertEnabled(interaction.guildId);
      await interaction.update(inventoryView(client, interaction.guild, interaction.user.id));
    },
    /**
     * cmd:eco:buy:<article>:<jeton>:<page> — achat. Le jeton (dernier achat connu à
     * l'affichage) rend un double clic inoffensif : le second clic est refusé.
     */
    async buy(interaction, client, [rawId, rawToken, rawPage]) {
      const svc = svcOf(client);
      const eco = svc.assertEnabled(interaction.guildId);
      if (!/^\d{1,12}$/.test(rawId ?? '') || !/^\d{1,16}$/.test(rawToken ?? '') || !/^\d{1,3}$/.test(rawPage ?? '')) throw new UserError('Ce bouton est invalide.');
      const guild = interaction.guild;
      const userId = interaction.user.id;
      const page = Number(rawPage);
      const item = svc.getItem(guild.id, Number(rawId));
      if (!item) throw new UserError('Cet article n\'existe plus : actualisez la boutique.');
      const token = Number(rawToken);
      if (item.kind !== 'role') {
        const r = svc.buy(guild.id, userId, item.id, token);
        await interaction.update(shopView(client, guild, userId, page, `${ICONS.success} **${plain(item.name, 50)}** acheté pour ${money(item.price, eco)}. Il vous attend dans votre inventaire (solde : ${money(r.balance, eco)}).`));
        return;
      }
      // Rôle : revérifié à l'achat (hiérarchie, permissions sensibles), débit, puis attribution
      // (remboursée si Discord la refuse).
      const issue = roleIssue(guild, item.role_id);
      if (issue) throw new UserError(`Ce rôle n'est plus disponible : ${issue}. Prévenez un administrateur.`);
      // Appels Discord à venir (membre, attribution) : acquitter d'abord.
      await interaction.deferUpdate();
      const member = await selfMember(interaction);
      if (member.roles.cache.has(item.role_id)) throw new UserError('Vous avez déjà ce rôle.');
      const r = svc.buy(guild.id, userId, item.id, token);
      const { failed } = await applyRoles(member, { add: [item.role_id] }, `Achat en boutique : ${plain(item.name, 50)}`, (id, e) =>
        logger.warn(`Rôle acheté ${id} non attribué (serveur ${guild.id}, membre ${userId}) :`, e?.message ?? e));
      if (failed.length) {
        const refund = svc.refund(guild.id, userId, item);
        await interaction.editReply(shopView(client, guild, userId, page, `${ICONS.warning} Je n'ai pas pu vous donner <@&${item.role_id}> : vous avez été remboursé (solde : ${money(refund.balance, eco)}).`));
        return;
      }
      await interaction.editReply(shopView(client, guild, userId, page, `${ICONS.success} Rôle <@&${item.role_id}> obtenu pour ${money(item.price, eco)} (solde : ${money(r.balance, eco)}).`, { ownedRoles: [item.role_id] }));
    },
    /** cmd:eco:top:<page>:<auteur> — classement public, feuilletable par tous. */
    async top(interaction, client, [page, ownerId]) {
      if (!/^\d{1,5}$/.test(page ?? '') || !SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      svcOf(client).assertEnabled(interaction.guildId);
      await interaction.update(boardView(client, interaction.guild, Number(page), ownerId));
    },
    /** cmd:eco:topme:<auteur> — page de la personne qui clique. */
    async topme(interaction, client, [ownerId]) {
      if (!SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      svcOf(client).assertEnabled(interaction.guildId);
      const rank = svcOf(client).rank(interaction.guildId, interaction.user.id);
      if (!rank) throw new UserError('Vous n\'avez pas encore de monnaie sur ce serveur : essayez `/eco quotidien` !');
      await interaction.update(boardView(client, interaction.guild, Math.floor((rank - 1) / BOARD_PAGE), ownerId, `📍 Page de ${interaction.user} · **#${rank}**`));
    },
    /** cmd:eco:replay:<jeu>:<mise>:<choix>:<auteur> — même jeu, même mise (auteur seulement). */
    async replay(interaction, client, [game, rawBet, choice, ownerId]) {
      if (!GAMES[game] || !/^\d{1,13}$/.test(rawBet ?? '') || !SIDES[choice] || !SNOWFLAKE.test(ownerId ?? '')) throw new UserError('Ce bouton est invalide.');
      assertInvoker(interaction, ownerId, `Lancez votre propre partie avec \`/eco ${GAMES[game].command}\`.`);
      const svc = svcOf(client);
      const eco = svc.assertEnabled(interaction.guildId);
      const r = svc.play(interaction.guildId, interaction.user.id, game, Number(rawBet), { choice });
      await interaction.update(gameView(eco, game, r, interaction.user, choice));
    },
  },
};
