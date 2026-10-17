'use strict';

const { card, field, wide, ICONS, actionButton, buttonRows } = require('../../../utils/ui');
const { discordTimestamp } = require('../../../utils/time');
const { fitList } = require('../../LoggingService');
const { assertAdmin } = require('../../ModerationService');
const { PUNISH_LABELS } = require('../cards');

/** Pastille d'un module : off ⚫, on 🟢, max 🔴 ; module déclaré mais non chargé : non disponible. Pure. */
function moduleLine(m) {
  if (!m.loaded) return `▫️ ${m.emoji} ${m.label} · *non disponible*`;
  const dot = { off: '⚫', on: '🟢', max: '🔴' }[m.mode] ?? '⚫';
  const suspended = m.suspendedUntil ? ` · ⏸️ conflit d'annulation jusqu'à ${discordTimestamp(m.suspendedUntil, 'T')}` : '';
  return `${dot} ${m.emoji} ${m.label}${m.mode === 'off' ? '' : ` · seuil ${m.limit}`}${suspended}`;
}

const POLICY_LABELS = { recent: 'Expulsé s\'il a moins de 7 jours', always: 'Toujours expulsé', never: 'Jamais expulsé (carte seule)' };

/**
 * Vue « statut » de /secur : modules, owners, bots de confiance, accès en attente, raid ping et
 * trois derniers incidents. Pure (lecture du service et de la configuration).
 * @param {import('../../../core/GadgetClient').GadgetClient} client
 * @param {import('discord.js').Interaction} interaction
 */
function renderStatus(client, interaction) {
  const guild = interaction.guild;
  const secur = client.services.secur;
  const cfg = client.services.config.get(guild.id);
  const sc = cfg.secur ?? {};
  const modules = secur?.moduleStatus(guild.id) ?? [];
  const loaded = modules.filter((m) => m.loaded);
  const active = loaded.filter((m) => m.mode !== 'off');
  const pending = secur?.pendingGrants(guild.id) ?? [];
  const incidents = client.repositories?.securityIncidents?.recent(guild.id, 3) ?? [];
  const half = Math.ceil(modules.length / 2);
  const embed = card({
    tone: active.length ? 'info' : 'neutral',
    section: 'security',
    icon: ICONS.shield,
    title: 'Secur · statut',
    description: [
      `**${active.length}** module(s) actif(s) sur **${modules.length}** · ${loaded.length < modules.length ? `**${modules.length - loaded.length}** non disponible(s) sur cette version` : 'tous disponibles'}.`,
      cfg.antiraid?.enabled ? `${ICONS.success} L'AntiRaid historique est actif (seuils de /antiraid) pour les types non couverts par un module.` : `${ICONS.info} L'AntiRaid historique est coupé (/antiraid).`,
    ],
    fields: [
      wide('🧩', 'Modules', modules.slice(0, half).map(moduleLine).join('\n') || '—'),
      wide('🧩', 'Modules (suite)', modules.slice(half).map(moduleLine).join('\n') || '—'),
      field(ICONS.owner, `Owners (${(sc.owners ?? []).length})`, fitList((sc.owners ?? []).map((id) => `<@${id}>`), 1000) ?? '*Aucun*'),
      field(ICONS.bot, `Bots de confiance (${(sc.trustedBots ?? []).length})`, fitList((sc.trustedBots ?? []).map((id) => `<@${id}>`), 1000) ?? '*Aucun*'),
      field('📢', 'Raid ping', sc.raidPingRoleId ? `<@&${sc.raidPingRoleId}>` : '*Aucun*'),
      field(ICONS.bot, 'Bot auteur', POLICY_LABELS[sc.botExecutor] ?? POLICY_LABELS.recent),
      field(ICONS.mail, 'MP', `Propriétaire : **${sc.notifyOwner === false ? 'non' : 'oui'}** · owners : **${sc.alertOwnersDm === false ? 'non' : 'oui'}**`),
      wide('🔐', `Accès de whitelist en attente (${pending.length})`, pending.length
        ? pending.slice(0, 5).map((g) => `#${g.id} · ${g.kind === 'wlrole' ? `<@&${g.subject_id}>` : `<@${g.subject_id}>`}${g.role_id ? ` (<@&${g.role_id}>)` : ''} · par <@${g.granted_by}> ${discordTimestamp(g.granted_at, 'R')}`).join('\n') + (pending.length > 5 ? `\n+${pending.length - 5}` : '')
        : '*Aucun*'),
      wide(ICONS.history, 'Derniers incidents', incidents.length
        ? incidents.map((i) => `#${i.id} · <@${i.executor_id}> · ${PUNISH_LABELS[i.punishment] ?? i.punishment} · ×${i.actions} ${discordTimestamp(i.created_at, 'R')}`).join('\n')
        : '*Aucun incident enregistré.*'),
    ],
  });
  return { embeds: [embed], components: buttonRows(actionButton({ command: 'secur', action: 'statut', label: 'Actualiser', emoji: ICONS.refresh })) };
}

/** Section « statut » de la coquille /secur (src/commands/security/secur.js). */
module.exports = {
  name: 'statut',
  type: 'subcommand',
  renderStatus,
  moduleLine,
  build(sub) {
    return sub.setName('statut').setDescription('Affiche l\'état de Secur (anti-nuke) : modules, owners, accès en attente, incidents.');
  },
  async execute(interaction, client) {
    await interaction.reply({ ...renderStatus(client, interaction), ephemeral: true });
  },
  buttons: {
    /** cmd:secur:statut — actualise la vue (message éphémère de l'administrateur). */
    async statut(interaction, client) {
      assertAdmin(interaction);
      await interaction.update(renderStatus(client, interaction));
    },
  },
  views: {
    statut: renderStatus,
  },
};
