'use strict';

const { card, wide, ICONS } = require('../../../utils/ui');
const { truncate } = require('../../../utils/embeds');
const { UserError } = require('../../../core/errors');
const { assertAdmin } = require('../../ModerationService');
const S = require('../../../utils/secur');
const V = require('../../../utils/securViews');

/**
 * Groupes « owner » et « confiance » de /secur (SEC2), plus les menus du panneau
 * cmd:secur:owners et cmd:secur:trust.
 *  - owners : nommés par le propriétaire du serveur seul (canManageOwners), humains PRÉSENTS,
 *    25 au plus. Exemptés en mode max, ils modifient Secur et approuvent les accès en attente.
 *  - bots de confiance : niveau owner, bots PRÉSENTS, 25 au plus. Exemptés en on ET en max ;
 *    un bot de confiance compromis n'est plus surveillé (avertissement explicite).
 */

const OWNERS_ONLY = 'Seul le propriétaire du serveur nomme ou retire les owners de sécurité.';

/** Options des niveaux de sécurité. */
function levelOpts(client) {
  return client.services?.secur?.levelOpts?.() ?? {
    botOwnerIds: client.config?.ownerIds ?? [],
    trustBotOwners: Boolean(client.config?.securTrustBotOwners),
    botId: client.user?.id ?? null,
  };
}

function assertManageOwners(client, interaction) {
  assertAdmin(interaction);
  if (!S.canManageOwners(interaction.guild, interaction.user.id, levelOpts(client))) throw new UserError(OWNERS_ONLY);
}

function assertOwnerLevel(client, interaction) {
  assertAdmin(interaction);
  S.assertOwnerLevel(interaction.guild, interaction.user.id, client.services.config.get(interaction.guildId), levelOpts(client));
}

/** Journal (SEC1) APRÈS la réponse. Best-effort. */
async function journalOf(client, interaction, key, before, after) {
  try {
    await client.services.secur?.journal?.(interaction.guild, { actorId: interaction.user.id, actor: interaction.user, source: '/secur', before: { secur: { [key]: before } }, after: { secur: { [key]: after } } });
  } catch {
    /* journal best-effort */
  }
}

/** Carte d'une liste (owners ou bots de confiance). Pure. */
function listCard({ kind, ids, notice = null }) {
  const owners = kind === 'owners';
  const max = owners ? S.SECUR_BOUNDS.owners : S.SECUR_BOUNDS.trustedBots;
  return card({
    tone: 'info',
    section: 'security',
    icon: owners ? ICONS.owner : ICONS.bot,
    title: owners ? 'Owners de sécurité' : 'Bots de confiance',
    description: [
      notice ? `${notice}\n` : null,
      owners
        ? 'Exemptés en mode max, ils modifient Secur et approuvent les accès de whitelist. Seul le propriétaire du serveur les nomme.'
        : `Exemptés en on **et** en max (tickets, rôles, autre anti-nuke).\n${ICONS.warning} Un bot de confiance compromis n'est plus surveillé.`,
    ],
    fields: [wide(owners ? ICONS.owner : ICONS.bot, `${owners ? 'Owners' : 'Bots'} (${ids.length}/${max})`, ids.length ? truncate(ids.map((id) => `<@${id}>`).join(', '), 1000) : '*Aucun*')],
    footer: owners ? '/secur owner ajouter · retirer · liste' : '/secur confiance ajouter · retirer · liste',
  });
}

/** Membre présent (données résolues de l'option, sinon cache). */
function presentMember(interaction, name) {
  const user = interaction.options.getUser(name, true);
  const member = interaction.options.getMember?.(name) ?? interaction.guild.members?.cache?.get?.(user.id) ?? null;
  return { user, member: member && typeof member === 'object' ? member : null };
}

/**
 * Valide une sélection d'utilisateurs (menu du panneau) : présents, humains (owners) ou bots
 * (confiance), 25 au plus. Lève une UserError.
 */
function validateSelection(interaction, ids, { bots }) {
  const max = bots ? S.SECUR_BOUNDS.trustedBots : S.SECUR_BOUNDS.owners;
  if (ids.length > max) throw new UserError(`${max} au plus.`);
  for (const id of ids) {
    const user = interaction.users?.get?.(id) ?? interaction.guild.members?.cache?.get?.(id)?.user ?? null;
    const present = interaction.members?.get?.(id) ?? interaction.guild.members?.cache?.get?.(id) ?? null;
    if (!user || !present) throw new UserError(`<@${id}> n'est pas sur le serveur.`);
    if (bots && !user.bot) throw new UserError(`<@${id}> n'est pas un bot : seuls des bots peuvent être « de confiance » (les humains passent par les owners).`);
    if (!bots && user.bot) throw new UserError(`<@${id}> est un bot : utilisez les bots de confiance.`);
    if (id === interaction.client?.user?.id) throw new UserError('Inutile : je suis déjà exempté.');
  }
}

/** Ajout / retrait par sous-commande. */
async function editList(interaction, client, { kind, sub, option }) {
  const owners = kind === 'owners';
  const key = owners ? 'owners' : 'trustedBots';
  const max = owners ? S.SECUR_BOUNDS.owners : S.SECUR_BOUNDS.trustedBots;
  const guildId = interaction.guildId;
  const before = [...(client.services.config.get(guildId).secur?.[key] ?? [])];
  if (sub === 'liste') {
    await interaction.reply({ embeds: [listCard({ kind, ids: before })], ephemeral: true });
    return;
  }
  if (owners) assertManageOwners(client, interaction);
  else assertOwnerLevel(client, interaction);
  const { user, member } = presentMember(interaction, option);
  let after = before;
  let notice;
  if (sub === 'ajouter') {
    if (!member) throw new UserError(`${user} n'est pas sur le serveur.`);
    if (owners && user.bot) throw new UserError(`${user} est un bot : ajoutez-le plutôt aux bots de confiance (/secur confiance ajouter).`);
    if (!owners && !user.bot) throw new UserError(`${user} n'est pas un bot : un humain de confiance devient owner (/secur owner ajouter).`);
    if (user.id === client.user?.id) throw new UserError('Inutile : je suis déjà exempté.');
    if (owners && user.id === interaction.guild.ownerId) throw new UserError('Le propriétaire du serveur a déjà tous les droits de Secur.');
    if (before.includes(user.id)) notice = `${ICONS.info} ${user} y est déjà.`;
    else {
      if (before.length >= max) throw new UserError(`${max} ${owners ? 'owners' : 'bots de confiance'} au plus : retirez-en d'abord un.`);
      after = [...before, user.id];
      notice = `${ICONS.success} ${user} ajouté${owners ? ' aux owners de sécurité' : ' aux bots de confiance'}.`;
    }
  } else if (sub === 'retirer') {
    if (!before.includes(user.id)) notice = `${ICONS.info} ${user} n'y figure pas.`;
    else {
      after = before.filter((id) => id !== user.id);
      notice = `${ICONS.success} ${user} retiré${owners ? ' des owners de sécurité' : ' des bots de confiance'}.`;
    }
  } else throw new UserError('Cette sous-commande n\'est plus disponible.');
  if (after !== before) client.services.config.update(guildId, { secur: { [key]: after } });
  await interaction.reply({ embeds: [listCard({ kind, ids: after, notice })], ephemeral: true });
  if (after !== before) await journalOf(client, interaction, key, before, after);
}

/** État du panneau (section « panneau », chargée paresseusement : pas de cycle au chargement). */
function panelStateOf(client, interaction, notice) {
  return require('./dashboard')[0].panelState(client, interaction, notice);
}

/** Menus du panneau (vue owners) : la sélection REMPLACE la liste. */
const buttons = {
  /** cmd:secur:owners — propriétaire seul ; humains présents ; 25 au plus. */
  async owners(interaction, client) {
    assertManageOwners(client, interaction);
    const ids = [...new Set((interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id)))];
    validateSelection(interaction, ids, { bots: false });
    const ownerId = interaction.guild.ownerId;
    const after = ids.filter((id) => id !== ownerId);
    const before = [...(client.services.config.get(interaction.guildId).secur?.owners ?? [])];
    const changed = JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort());
    if (changed) client.services.config.update(interaction.guildId, { secur: { owners: after } });
    await interaction.update(V.renderView(panelStateOf(client, interaction, changed ? `${ICONS.success} ${after.length} owner(s) de sécurité.` : `${ICONS.info} Aucun changement.`), 'owners'));
    if (changed) await journalOf(client, interaction, 'owners', before, after);
  },
  /** cmd:secur:trust — niveau owner ; bots présents ; 25 au plus. */
  async trust(interaction, client) {
    assertOwnerLevel(client, interaction);
    const ids = [...new Set((interaction.values ?? []).filter((id) => /^\d{17,20}$/.test(id)))];
    validateSelection(interaction, ids, { bots: true });
    const before = [...(client.services.config.get(interaction.guildId).secur?.trustedBots ?? [])];
    const changed = JSON.stringify([...before].sort()) !== JSON.stringify([...ids].sort());
    if (changed) client.services.config.update(interaction.guildId, { secur: { trustedBots: ids } });
    const notice = changed ? `${ICONS.success} ${ids.length} bot(s) de confiance. ${ICONS.warning} Un bot de confiance compromis n'est plus surveillé.` : `${ICONS.info} Aucun changement.`;
    await interaction.update(V.renderView(panelStateOf(client, interaction, notice), 'owners'));
    if (changed) await journalOf(client, interaction, 'trustedBots', before, ids);
  },
};

module.exports = [
  {
    name: 'owner',
    type: 'group',
    listCard,
    build(group) {
      return group
        .setName('owner')
        .setDescription('Owners de sécurité (nommés par le propriétaire du serveur).')
        .addSubcommand((s) => s.setName('ajouter').setDescription('Nomme un owner de sécurité (propriétaire du serveur seulement).')
          .addUserOption((o) => o.setName('membre').setDescription('Membre humain à nommer owner').setRequired(true)))
        .addSubcommand((s) => s.setName('retirer').setDescription('Retire un owner de sécurité (propriétaire du serveur seulement).')
          .addUserOption((o) => o.setName('membre').setDescription('Owner à retirer').setRequired(true)))
        .addSubcommand((s) => s.setName('liste').setDescription('Affiche les owners de sécurité.'));
    },
    execute(interaction, client, [, sub]) {
      return editList(interaction, client, { kind: 'owners', sub, option: 'membre' });
    },
    buttons,
  },
  {
    name: 'confiance',
    type: 'group',
    build(group) {
      return group
        .setName('confiance')
        .setDescription('Bots de confiance : exemptés de Secur en on et en max.')
        .addSubcommand((s) => s.setName('ajouter').setDescription('Ajoute un bot de confiance (niveau owner).')
          .addUserOption((o) => o.setName('bot').setDescription('Bot présent sur le serveur').setRequired(true)))
        .addSubcommand((s) => s.setName('retirer').setDescription('Retire un bot de confiance (niveau owner).')
          .addUserOption((o) => o.setName('bot').setDescription('Bot de confiance à retirer').setRequired(true)))
        .addSubcommand((s) => s.setName('liste').setDescription('Affiche les bots de confiance.'));
    },
    execute(interaction, client, [, sub]) {
      return editList(interaction, client, { kind: 'trust', sub, option: 'bot' });
    },
  },
];

