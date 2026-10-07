'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { progressBar } = require('../../utils/embeds');
const { card, field, wide, blank, subtext, status, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');

/** Catégories de logs → libellé et icône (catalogue commun, cf. /logs). */
const LOG_CATEGORIES = Object.freeze(
  Object.fromEntries(Object.entries(require('../../utils/logCatalog').LOG_CATEGORIES).map(([k, c]) => [k, { label: c.label, emoji: c.emoji }])),
);

const ACTION_LABELS = { warn: `${ICONS.warn} Avertissement`, mute: `${ICONS.mute} Mute`, timeout: `${ICONS.mute} Exclusion temporaire`, kick: `${ICONS.kick} Expulsion`, ban: `${ICONS.ban} Bannissement`, tempban: `${ICONS.ban} Ban temporaire` };

const ON = '🟢';
const OFF = '🔴';
const UNSET = '—';

const onOff = (value, on = 'Activé', off = 'Désactivé') => (value ? `${ON} ${on}` : `${OFF} ${off}`);

/** Les boutons revérifient la permission par défaut de la commande. */
function assertManageGuild(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError('Il faut la permission **Gérer le serveur** pour consulter la configuration.');
  }
}

/**
 * État d'un salon de logs : [pastille, texte].
 * 🟢 OK · ⚠️ je ne peux pas écrire · ❌ introuvable · — non défini
 */
function logChannelState(guild, id) {
  if (!id) return [UNSET, '*Non défini*'];
  const channel = guild.channels.cache.get(id);
  if (!channel) return [ICONS.error, `\`${id}\` · *introuvable*`];
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const canWrite = !perms || perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  return canWrite ? [ON, `${channel}`] : [ICONS.warning, `${channel} · *accès refusé*`];
}

/** Tableau de bord : un module = un champ, avec son état. */
function renderDashboard(guild, cfg) {
  const logIds = Object.keys(LOG_CATEGORIES).map((k) => cfg.logChannels?.[k]);
  const logsSet = logIds.filter(Boolean).length;
  const filters = Object.values(cfg.automod?.filters || {});
  const activeFilters = filters.filter((f) => f.enabled).length;
  const thresholds = cfg.strikes?.thresholds || [];
  const whitelist = (cfg.whitelist?.users?.length ?? 0) + (cfg.whitelist?.roles?.length ?? 0);

  const modules = [
    ['Salons de logs', logsSet > 0],
    ['Strikes', cfg.strikes?.enabled],
    ['AutoMod', cfg.automod?.enabled],
    ['AntiRaid', cfg.antiraid?.enabled],
    ['Tickets', Boolean(cfg.tickets?.categoryId)],
    ['Modmail', cfg.modmail?.enabled],
    ['Suggestions', Boolean(cfg.suggestions?.channelId)],
    ['Vocaux temporaires', cfg.tempVoice?.enabled],
    ['Sauvegardes auto', cfg.autobackup?.enabled],
  ];
  const active = modules.filter(([, on]) => on).length;

  const fields = [
    field(ICONS.moderator, 'Modération', [onOff(cfg.moderation?.dmOnSanction, 'DM au sanctionné', 'Pas de DM'), onOff(cfg.moderation?.confirmDangerous, 'Confirmations', 'Sans confirmation')].join('\n')),
    field('⚖️', 'Strikes', cfg.strikes?.enabled ? `${ON} Activés\n${subtext(`${thresholds.length} palier${thresholds.length > 1 ? 's' : ''}`)}` : `${OFF} Désactivés`),
    field(ICONS.automod, 'AutoMod', cfg.automod?.enabled ? `${ON} Actif\n${subtext(`${activeFilters}/${filters.length} filtres`)}` : `${OFF} Inactif`),
    field('🚨', 'AntiRaid', cfg.antiraid?.enabled ? `${ON} Actif\n${subtext(`Seuil : ${cfg.antiraid.joinThreshold} arrivées / ${cfg.antiraid.joinWindowSeconds} s`)}` : `${OFF} Inactif`),
    field(ICONS.ticket, 'Tickets', cfg.tickets?.categoryId ? `${ON} Configurés\n${subtext(`${cfg.tickets.maxPerUser ?? 1} par membre${cfg.tickets.reasons?.length ? ` · ${cfg.tickets.reasons.length} motif(s)` : ''}`)}` : `${UNSET} Non configurés`),
    field(ICONS.mail, 'Modmail', onOff(cfg.modmail?.enabled, 'Actif', 'Inactif')),
    field(ICONS.idea, 'Suggestions', cfg.suggestions?.channelId ? `${ON} <#${cfg.suggestions.channelId}>` : `${UNSET} Non configurées`),
    field(ICONS.voice, 'Vocaux temporaires', onOff(cfg.tempVoice?.enabled, 'Actifs', 'Inactifs')),
    field(ICONS.memory, 'Sauvegardes auto', cfg.autobackup?.enabled ? `${ON} Toutes les ${cfg.autobackup.intervalHours} h` : `${OFF} Désactivées`),
    field(ICONS.project, 'Projets', cfg.projects?.openCreation ? `${ON} Création ouverte` : `${OFF} Gestionnaires`),
    field(ICONS.check, 'Whitelist', whitelist ? `${ON} **${whitelist}** entrée${whitelist > 1 ? 's' : ''}` : `${UNSET} Vide`),
  ];

  // Grille des salons de logs sur deux colonnes.
  const keys = Object.keys(LOG_CATEGORIES);
  const half = Math.ceil(keys.length / 2);
  const column = (list) =>
    list
      .map((k) => {
        const [dot, text] = logChannelState(guild, cfg.logChannels?.[k]);
        return `${dot} **${LOG_CATEGORIES[k].label}** · ${text}`;
      })
      .join('\n');
  // 11 modules + 1 espaceur : la grille des logs commence toujours sur une nouvelle ligne.
  while (fields.length % 3) fields.push(blank());
  fields.push(
    field(ICONS.list, `Salons de logs · ${logsSet}/${logIds.length}`, column(keys.slice(0, half))),
    { name: '​', value: column(keys.slice(half)), inline: true },
  );

  return card({
    tone: 'brand',
    section: 'configuration',
    icon: ICONS.settings,
    title: 'Configuration du serveur',
    description: [
      `Vue d'ensemble des réglages de **${guild.name}**.`,
      `\`${progressBar(active / modules.length, 16)}\` **${active}/${modules.length}** modules actifs`,
      subtext(`${ON} actif · ${OFF} désactivé · ${UNSET} non configuré`),
    ],
    thumbnail: guild.iconURL?.({ size: 128 }) ?? null,
    fields,
    footer: 'Modifier : /logs · /antiraid · /tickets · /settings moderation',
  });
}

/** Détail des salons de logs : une case par catégorie, avec vérification d'accès. */
function renderLogs(guild, cfg) {
  const entries = Object.entries(LOG_CATEGORIES).map(([key, meta]) => {
    const [dot, text] = logChannelState(guild, cfg.logChannels?.[key]);
    return { key, meta, dot, text };
  });
  const ok = entries.filter((e) => e.dot === ON).length;
  const broken = entries.filter((e) => e.dot === ICONS.error || e.dot === ICONS.warning).length;
  return card({
    tone: broken ? 'warning' : 'brand',
    section: 'configuration',
    icon: ICONS.list,
    title: 'Salons de logs',
    description: [
      `**${ok}/${entries.length}** catégories journalisées.`,
      broken ? `${ICONS.warning} **${broken}** salon${broken > 1 ? 's' : ''} à corriger (supprimé ou accès refusé).` : null,
      subtext(`${ON} opérationnel · ${ICONS.warning} accès refusé · ${ICONS.error} introuvable · ${UNSET} non défini`),
    ],
    fields: entries.map((e) => field(e.meta.emoji, e.meta.label, `${e.dot} ${e.text}`)),
    footer: 'Tout se configure dans /logs (bouton ci-dessous)',
  });
}

/** Détail des options de modération et des paliers de strikes. */
function renderModeration(cfg) {
  const m = cfg.moderation || {};
  const thresholds = [...(cfg.strikes?.thresholds || [])].sort((a, b) => a.strikes - b.strikes);
  const ladder = thresholds.map((t) => `**${t.strikes}** strikes → ${ACTION_LABELS[t.action] ?? t.action}${t.duration ? ` · ${t.duration}` : ''}`);
  return card({
    tone: 'brand',
    section: 'configuration',
    icon: ICONS.moderator,
    title: 'Options de modération',
    description: 'Comportement des commandes de sanction sur ce serveur.',
    fields: [
      field(ICONS.mail, 'DM au sanctionné', onOff(m.dmOnSanction, 'Oui', 'Non')),
      field(ICONS.warning, 'Confirmation', onOff(m.confirmDangerous, 'Demandée', 'Désactivée')),
      field(ICONS.reason, 'Raison obligatoire', onOff(m.requireReason, 'Oui', 'Non')),
      field(ICONS.mute, 'Rôle muet', m.mutedRoleId ? `<@&${m.mutedRoleId}>` : `${UNSET} Aucun`),
      field('⚖️', 'Strikes', onOff(cfg.strikes?.enabled, 'Activés', 'Désactivés')),
      field(ICONS.count, 'Paliers', `**${thresholds.length}**`),
      wide('📈', 'Paliers de strikes', cfg.strikes?.enabled ? ladder.join('\n') || '*Aucun palier : les strikes sont seulement comptés.*' : '*Système désactivé.*'),
    ],
    footer: 'Modifier : /settings moderation',
  });
}

function dashboardView(guild, cfg) {
  return { embeds: [renderDashboard(guild, cfg)], components: [...tabsFor('view'), ...shortcuts()] };
}

/** Raccourcis vers les tableaux de bord de configuration (chacun revérifie sa permission). */
function shortcuts() {
  return buttonRows(
    actionButton({ command: 'antiraid', action: 'go', args: ['home'], label: 'AntiRaid', emoji: '🚨' }),
    actionButton({ command: 'tickets', action: 'go', args: ['home'], label: 'Tickets', emoji: ICONS.ticket }),
  );
}

/** Onglets : [⚙️ Vue d'ensemble | 🔄 Actualiser] [📋 Logs] [🛡️ Modération] — l'onglet courant est désactivé. */
function tabsFor(current) {
  const style = (tab) => (current === tab ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return buttonRows(
    current === 'view'
      ? actionButton({ command: 'settings', action: 'view', label: 'Actualiser', emoji: ICONS.refresh, style: ButtonStyle.Primary })
      : actionButton({ command: 'settings', action: 'view', label: 'Vue d\'ensemble', emoji: ICONS.settings }),
    actionButton({ command: 'settings', action: 'logs', label: 'Logs', emoji: ICONS.list, style: style('logs'), disabled: current === 'logs' }),
    actionButton({ command: 'settings', action: 'moderation', label: 'Modération', emoji: ICONS.moderator, style: style('moderation'), disabled: current === 'moderation' }),
  );
}

module.exports = {
  category: 'configuration',
  LOG_CATEGORIES,
  renderDashboard,
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure le bot pour ce serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('view').setDescription('Affiche la configuration actuelle.'))
    .addSubcommand((s) =>
      s
        .setName('moderation')
        .setDescription('Règle les options de modération.')
        .addBooleanOption((o) => o.setName('dm_sanction').setDescription('Envoyer un DM au membre sanctionné.'))
        .addBooleanOption((o) => o.setName('confirmation').setDescription('Demander confirmation pour les actions dangereuses.')),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const { config } = client.services;
    const guild = interaction.guild;

    if (sub === 'view') {
      return interaction.reply({ ...dashboardView(guild, config.get(guild.id)), ephemeral: true });
    }

    if (sub === 'moderation') {
      const patch = {};
      const dm = interaction.options.getBoolean('dm_sanction');
      const confirm = interaction.options.getBoolean('confirmation');
      if (dm !== null) patch.dmOnSanction = dm;
      if (confirm !== null) patch.confirmDangerous = confirm;
      if (!Object.keys(patch).length) {
        return interaction.reply({
          embeds: [status.warn('Aucune option fournie. Précisez `dm_sanction` et/ou `confirmation`.', 'Rien à modifier')],
          components: buttonRows(actionButton({ command: 'settings', action: 'moderation', label: 'Voir les options', emoji: ICONS.moderator })),
          ephemeral: true,
        });
      }
      const cfg = config.update(guild.id, { moderation: patch });
      return interaction.reply({
        embeds: [
          card({
            tone: 'success',
            section: 'configuration',
            icon: ICONS.success,
            title: 'Options de modération mises à jour',
            description: 'Les nouveaux réglages s\'appliquent immédiatement.',
            fields: [
              field(ICONS.mail, 'DM au sanctionné', `${onOff(cfg.moderation.dmOnSanction, 'Oui', 'Non')}${dm !== null ? ' ✏️' : ''}`),
              field(ICONS.warning, 'Confirmation', `${onOff(cfg.moderation.confirmDangerous, 'Demandée', 'Désactivée')}${confirm !== null ? ' ✏️' : ''}`),
            ],
            footer: '✏️ = modifié',
          }),
        ],
        components: buttonRows(actionButton({ command: 'settings', action: 'view', label: 'Vue d\'ensemble', emoji: ICONS.settings })),
        ephemeral: true,
      });
    }
    throw new UserError('Sous-commande inconnue.');
  },

  buttons: {
    /** cmd:settings:view — tableau de bord (actualise / revient à la vue d'ensemble). */
    async view(interaction, client) {
      assertManageGuild(interaction);
      await interaction.update(dashboardView(interaction.guild, client.services.config.get(interaction.guildId)));
    },
    /** cmd:settings:logs — détail des salons de logs. */
    async logs(interaction, client) {
      assertManageGuild(interaction);
      await interaction.update({
        embeds: [renderLogs(interaction.guild, client.services.config.get(interaction.guildId))],
        components: [
          ...tabsFor('logs'),
          ...buttonRows(actionButton({ command: 'logs', action: 'go', args: ['home'], label: 'Configurer les logs', emoji: '📋', style: ButtonStyle.Primary })),
        ],
      });
    },
    /** cmd:settings:moderation — options de modération et paliers de strikes. */
    async moderation(interaction, client) {
      assertManageGuild(interaction);
      await interaction.update({ embeds: [renderModeration(client.services.config.get(interaction.guildId))], components: tabsFor('moderation') });
    },
  },
};
