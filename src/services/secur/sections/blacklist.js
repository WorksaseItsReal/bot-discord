'use strict';

const { card, field, wide, ICONS, actionButton, buttonRows, labelButton, ButtonStyle, code, subtext, status } = require('../../../utils/ui');
const { truncate } = require('../../../utils/embeds');
const { discordTimestamp } = require('../../../utils/time');
const { assertAdmin } = require('../../ModerationService');
const { UserError } = require('../../../core/errors');

/**
 * Sections « blacklist » et « blrank » de la coquille /secur (SEC3). Actions de boutons : bl*
 * (liste noire) et blr* (blrank). Ajouter et retirer exigent le niveau owner (propriétaire du
 * serveur ou owner de sécurité) ; liste et info sont ouvertes aux administrateurs (/secur).
 * Chaque bouton revérifie Administrateur, et le niveau owner pour un retrait.
 */

const PAGE_SIZE = 10;
const ID_RE = /^(?:<@!?)?(\d{17,20})>?$/;
const SNOWFLAKE = /^\d{17,20}$/;

function service(client) {
  const svc = client.services?.blacklist;
  if (!svc) throw new UserError('La liste noire est indisponible pour le moment. Réessayez dans un instant.');
  return svc;
}

/** Identifiant d'utilisateur saisi (identifiant ou mention). Lève une UserError sinon. Pur. */
function parseUserId(raw) {
  const m = ID_RE.exec(String(raw ?? '').trim());
  if (!m) throw new UserError('Indiquez l\'identifiant (17 à 20 chiffres) ou la mention de l\'utilisateur.');
  return m[1];
}

/** Ligne d'une entrée dans la liste. Pur. */
function entryLine(row, kind) {
  const failing = kind === 'ban' && row.enforce_failures > 0 ? ' · ⚠️ pas encore banni (nouvel essai automatique)' : '';
  const reason = row.reason ? `\n${subtext(truncate(String(row.reason).replace(/\s+/g, ' '), 120))}` : '';
  return `${ICONS.user} <@${row.user_id}> · ${code(row.user_id)} · par <@${row.author_id}> ${discordTimestamp(row.created_at, 'R')}${failing}${reason}`;
}

/**
 * Page `page` (à partir de 0) de la liste noire (kind 'ban') ou du blrank (kind 'rank'), lue en
 * base 10 entrées à la fois ; boutons cmd:secur:blpage|blrpage:<page>.
 */
function renderList(client, guild, kind, page = 0) {
  const repo = client.repositories.securityBlacklist;
  const total = repo.count(guild.id, kind);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(Number(page)) || 0), pages - 1);
  const rows = total ? repo.list(guild.id, kind, { limit: PAGE_SIZE, offset: p * PAGE_SIZE }) : [];
  const ban = kind === 'ban';
  const embed = card({
    tone: total ? (ban ? 'danger' : 'caution') : 'neutral',
    section: 'security',
    icon: ban ? ICONS.ban : '🚫',
    title: `${ban ? 'Liste noire' : 'Blrank'} · ${total}`,
    description: [
      ban ? 'Ces utilisateurs restent bannis : un débannissement est annulé aussitôt.' : 'Ces membres ne peuvent recevoir aucun rôle : un rôle donné leur est retiré.',
      '',
      rows.map((r) => entryLine(r, kind)).join('\n') || '*Aucune entrée.*',
    ],
    footer: pages > 1 ? `Page ${p + 1}/${pages}` : undefined,
  });
  const action = ban ? 'blpage' : 'blrpage';
  const components = pages > 1
    ? buttonRows(
      actionButton({ command: 'secur', action, args: [Math.max(0, p - 1)], emoji: ICONS.back, disabled: p === 0 }),
      labelButton(`Page ${p + 1}/${pages}`),
      actionButton({ command: 'secur', action, args: [Math.min(pages - 1, p + 1)], emoji: ICONS.next, disabled: p >= pages - 1 }),
    )
    : [];
  return { embeds: [embed], components };
}

/** Fiche d'un utilisateur de la liste noire (et du blrank). */
function renderInfo(client, guild, userId) {
  const repo = client.repositories.securityBlacklist;
  const row = repo.get(guild.id, userId, 'ban');
  const rank = repo.get(guild.id, userId, 'rank');
  if (!row && !rank) throw new UserError(`<@${userId}> n'est ni sur la liste noire ni dans le blrank.`);
  const main = row ?? rank;
  const embed = card({
    tone: row ? 'danger' : 'caution',
    section: 'security',
    icon: row ? ICONS.ban : '🚫',
    title: row ? 'Liste noire · fiche' : 'Blrank · fiche',
    description: row
      ? `<@${userId}> est sur la **liste noire** : il reste banni, un débannissement est annulé aussitôt.`
      : `<@${userId}> est dans le **blrank** : il ne peut recevoir aucun rôle.`,
    fields: [
      field(ICONS.user, 'Utilisateur', `<@${userId}>\n${code(userId)}`),
      field(ICONS.moderator, 'Ajouté par', `<@${main.author_id}>`),
      field(ICONS.date, 'Depuis', `${discordTimestamp(main.created_at, 'D')}\n${discordTimestamp(main.created_at, 'R')}`),
      row ? field(ICONS.ban, 'Dernier bannissement', row.last_enforced_at ? discordTimestamp(row.last_enforced_at, 'R') : '*Pas encore appliqué*') : null,
      row ? field(ICONS.refresh, 'Prochain contrôle', row.next_check_at ? discordTimestamp(row.next_check_at, 'R') : '—') : null,
      row ? field(ICONS.warning, 'Échecs', `**${row.enforce_failures}**`) : null,
      row && rank ? field('🚫', 'Blrank', 'Oui') : null,
      main.reason ? wide(ICONS.reason, 'Raison', truncate(main.reason, 1024)) : null,
    ],
  });
  const components = row ? buttonRows(actionButton({ command: 'secur', action: 'blask', args: [userId], label: 'Retirer', emoji: ICONS.unlock, style: ButtonStyle.Danger })) : [];
  return { embeds: [embed], components };
}

/** Demande de confirmation du retrait (boutons cmd:secur:blremove:<id>:<1|0> et blcancel). */
function renderConfirm(userId, unban) {
  return {
    embeds: [card({
      tone: 'warning',
      section: 'security',
      icon: ICONS.warning,
      title: 'Retirer de la liste noire ?',
      description: [
        `<@${userId}> ne sera plus rebanni automatiquement.`,
        unban ? 'Son bannissement sera **levé** : il pourra revenir avec une invitation.' : 'Il **reste banni** : vous pourrez le débannir plus tard avec `/unban`.',
      ],
    })],
    components: buttonRows(
      actionButton({ command: 'secur', action: 'blremove', args: [userId, unban ? 1 : 0], label: 'Confirmer', emoji: ICONS.success, style: ButtonStyle.Danger }),
      actionButton({ command: 'secur', action: 'blcancel', label: 'Annuler', emoji: ICONS.error }),
    ),
  };
}

/** Retrait confirmé : DELETE (verrou) puis débannissement ; un second clic ne fait rien. */
async function confirmRemoval(interaction, client, userId, unban) {
  const svc = service(client);
  svc.assertOwner(interaction);
  await interaction.deferUpdate();
  const res = await svc.remove(interaction, userId, { unban });
  const lines = [`<@${userId}> a été retiré de la liste noire : il ne sera plus rebanni automatiquement.`];
  if (res.unbanned === true) lines.push(`${ICONS.unlock} Son bannissement a été levé.`);
  else if (res.unbanned === false) lines.push(`${ICONS.warning} Débannissement non effectué : ${res.note}`);
  else lines.push(`${ICONS.ban} Il reste banni.`);
  await interaction.editReply({ embeds: [status.ok(lines.join('\n'), 'Liste noire')], components: [] });
  await svc.logAction(interaction.guild, {
    tone: 'success',
    icon: ICONS.unlock,
    title: 'Retiré de la liste noire',
    description: lines.join('\n'),
    fields: [field(ICONS.user, 'Utilisateur', `<@${userId}>\n${code(userId)}`), field(ICONS.moderator, 'Par', `<@${interaction.user.id}>`)],
  }, userId);
}

/* -------------------------------------------------------------------- */
/* Groupe « blacklist »                                                   */
/* -------------------------------------------------------------------- */

const blacklist = {
  name: 'blacklist',
  type: 'group',
  build(group) {
    return group
      .setName('blacklist')
      .setDescription('Liste noire : ces utilisateurs restent bannis, même débannis à la main.')
      .addSubcommand((s) => s.setName('ajouter').setDescription('Bannit un utilisateur (même absent) et l\'empêche de revenir, même débanni.')
        .addUserOption((o) => o.setName('membre').setDescription('Utilisateur à mettre en liste noire (membre ou identifiant)').setRequired(true))
        .addStringOption((o) => o.setName('raison').setDescription('Raison de la mise en liste noire (300 caractères au plus)').setRequired(true).setMinLength(1).setMaxLength(300)))
      .addSubcommand((s) => s.setName('retirer').setDescription('Retire un utilisateur de la liste noire (et lève son bannissement par défaut).')
        .addStringOption((o) => o.setName('utilisateur').setDescription('Identifiant ou mention de l\'utilisateur en liste noire').setRequired(true).setMaxLength(32))
        .addBooleanOption((o) => o.setName('debannir').setDescription('Lever aussi son bannissement (oui par défaut)')))
      .addSubcommand((s) => s.setName('liste').setDescription('Affiche la liste noire du serveur (10 entrées par page).'))
      .addSubcommand((s) => s.setName('info').setDescription('Fiche d\'un utilisateur de la liste noire : raison, auteur, contrôles.')
        .addStringOption((o) => o.setName('utilisateur').setDescription('Identifiant ou mention de l\'utilisateur en liste noire').setRequired(true).setMaxLength(32)));
  },
  async execute(interaction, client, [, sub]) {
    const svc = service(client);
    const guild = interaction.guild;
    if (sub === 'liste') return interaction.reply({ ...renderList(client, guild, 'ban', 0), ephemeral: true });
    if (sub === 'info') return interaction.reply({ ...renderInfo(client, guild, parseUserId(interaction.options.getString('utilisateur', true))), ephemeral: true });
    if (sub === 'retirer') {
      svc.assertOwner(interaction);
      const userId = parseUserId(interaction.options.getString('utilisateur', true));
      if (!svc.has(guild.id, userId, 'ban')) throw new UserError(`<@${userId}> n'est pas sur la liste noire.`);
      return interaction.reply({ ...renderConfirm(userId, interaction.options.getBoolean('debannir') ?? true), ephemeral: true });
    }
    if (sub === 'ajouter') {
      svc.assertOwner(interaction);
      const user = interaction.options.getUser('membre', true);
      const reason = interaction.options.getString('raison', true);
      await interaction.deferReply({ ephemeral: true });
      const res = await svc.add(interaction, user, reason);
      const description = res.banned
        ? `${user} est banni et sur la **liste noire** : un débannissement (manuel, /unban, fin de tempban, hors ligne) sera annulé.`
        : `${user} est sur la **liste noire**, mais le bannissement a échoué pour le moment (${res.error}). Nouvel essai automatique dans 5 minutes.`;
      await interaction.editReply({
        embeds: [card({
          tone: res.banned ? 'danger' : 'warning',
          section: 'security',
          icon: ICONS.ban,
          title: 'Ajouté à la liste noire',
          description,
          fields: [field(ICONS.user, 'Utilisateur', `${user}\n${code(user.id)}`), res.sanctionId ? field(ICONS.id, 'Sanction', code(`#${res.sanctionId}`)) : null, wide(ICONS.reason, 'Raison', truncate(reason, 1024))],
        })],
      });
      await svc.logAction(guild, {
        tone: 'danger',
        icon: ICONS.ban,
        title: res.banned ? 'Ajouté à la liste noire' : 'Ajouté à la liste noire (bannissement en attente)',
        description,
        fields: [field(ICONS.user, 'Utilisateur', `<@${user.id}>\n${code(user.id)}`), field(ICONS.moderator, 'Par', `<@${interaction.user.id}>`), wide(ICONS.reason, 'Raison', truncate(reason, 1024))],
      }, user.id);
      // Ban fait par le bot au nom de l'auteur : signalé à Secur / à l'AntiRaid (bans en masse).
      if (res.banned) await client.services.moderation?.reportDestructiveAction?.(guild, interaction.user, 'ban', { targetId: user.id, targetJoinedAt: res.member?.joinedTimestamp ?? null }).catch(() => {});
      return undefined;
    }
    throw new UserError('Cette sous-commande n\'est plus disponible.');
  },
  buttons: {
    /** cmd:secur:blpage:<page> — page de la liste noire. */
    async blpage(interaction, client, [page]) {
      assertAdmin(interaction);
      await interaction.update(renderList(client, interaction.guild, 'ban', page));
    },
    /** cmd:secur:blask:<id> — depuis la fiche : demande de confirmation du retrait (niveau owner). */
    async blask(interaction, client, [userId]) {
      assertAdmin(interaction);
      service(client).assertOwner(interaction);
      if (!SNOWFLAKE.test(String(userId ?? ''))) throw new UserError('Ce bouton est invalide.');
      if (!service(client).has(interaction.guild.id, userId, 'ban')) throw new UserError(`<@${userId}> n'est plus sur la liste noire.`);
      await interaction.update(renderConfirm(userId, true));
    },
    /** cmd:secur:blremove:<id>:<1|0> — retrait confirmé (niveau owner, verrou SQL). */
    async blremove(interaction, client, [userId, flag]) {
      assertAdmin(interaction);
      if (!SNOWFLAKE.test(String(userId ?? '')) || (flag !== '1' && flag !== '0')) throw new UserError('Ce bouton est invalide.');
      await confirmRemoval(interaction, client, userId, flag === '1');
    },
    /** cmd:secur:blcancel — retrait annulé. */
    async blcancel(interaction) {
      assertAdmin(interaction);
      await interaction.update({ embeds: [status.warn('Action annulée. Rien n\'a été modifié.')], components: [] });
    },
  },
};

/* -------------------------------------------------------------------- */
/* Groupe « blrank »                                                      */
/* -------------------------------------------------------------------- */

const blrank = {
  name: 'blrank',
  type: 'group',
  build(group) {
    return group
      .setName('blrank')
      .setDescription('Blrank : ces membres ne peuvent recevoir aucun rôle.')
      .addSubcommand((s) => s.setName('ajouter').setDescription('Empêche un membre de recevoir le moindre rôle (ses rôles actuels restent).')
        .addUserOption((o) => o.setName('membre').setDescription('Membre qui ne pourra plus recevoir de rôle').setRequired(true))
        .addStringOption((o) => o.setName('raison').setDescription('Raison (300 caractères au plus)').setMaxLength(300)))
      .addSubcommand((s) => s.setName('retirer').setDescription('Retire un membre du blrank : il peut de nouveau recevoir des rôles.')
        .addUserOption((o) => o.setName('membre').setDescription('Membre à retirer du blrank').setRequired(true)))
      .addSubcommand((s) => s.setName('liste').setDescription('Affiche les membres du blrank (10 par page).'));
  },
  async execute(interaction, client, [, sub]) {
    const svc = service(client);
    const guild = interaction.guild;
    if (sub === 'liste') return interaction.reply({ ...renderList(client, guild, 'rank', 0), ephemeral: true });
    if (sub === 'retirer') {
      svc.assertOwner(interaction);
      const user = interaction.options.getUser('membre', true);
      svc.removeRank(guild.id, user.id);
      await interaction.reply({ embeds: [status.ok(`${user} peut de nouveau recevoir des rôles.`, 'Blrank')], ephemeral: true });
      await svc.logAction(guild, {
        tone: 'success',
        icon: ICONS.role,
        title: 'Retiré du blrank',
        description: `<@${user.id}> peut de nouveau recevoir des rôles.`,
        fields: [field(ICONS.user, 'Membre', `<@${user.id}>\n${code(user.id)}`), field(ICONS.moderator, 'Par', `<@${interaction.user.id}>`)],
      }, user.id);
      return undefined;
    }
    if (sub === 'ajouter') {
      svc.assertOwner(interaction);
      const user = interaction.options.getUser('membre', true);
      const reason = interaction.options.getString('raison');
      await interaction.deferReply({ ephemeral: true });
      await svc.addRank(interaction, user, reason);
      const description = `${user} ne peut plus recevoir aucun rôle : rôles d'arrivée, menus, boutique, niveaux… Un rôle donné à la main lui est retiré. Ses rôles actuels sont conservés.`;
      await interaction.editReply({
        embeds: [card({
          tone: 'caution',
          section: 'security',
          icon: '🚫',
          title: 'Ajouté au blrank',
          description,
          fields: [field(ICONS.user, 'Membre', `${user}\n${code(user.id)}`), reason ? wide(ICONS.reason, 'Raison', truncate(reason, 1024)) : null],
        })],
      });
      await svc.logAction(guild, {
        tone: 'caution',
        icon: '🚫',
        title: 'Ajouté au blrank',
        description,
        fields: [field(ICONS.user, 'Membre', `<@${user.id}>\n${code(user.id)}`), field(ICONS.moderator, 'Par', `<@${interaction.user.id}>`), reason ? wide(ICONS.reason, 'Raison', truncate(reason, 1024)) : null],
      }, user.id);
      return undefined;
    }
    throw new UserError('Cette sous-commande n\'est plus disponible.');
  },
  buttons: {
    /** cmd:secur:blrpage:<page> — page du blrank. */
    async blrpage(interaction, client, [page]) {
      assertAdmin(interaction);
      await interaction.update(renderList(client, interaction.guild, 'rank', page));
    },
  },
};

module.exports = [blacklist, blrank];
module.exports.renderList = renderList;
module.exports.renderInfo = renderInfo;
module.exports.renderConfirm = renderConfirm;
module.exports.parseUserId = parseUserId;
module.exports.PAGE_SIZE = PAGE_SIZE;
