'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { card, field, wide, ICONS, code, subtext, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { requirePermission } = require('../../services/ModerationService');
const {
  COUNTER_TYPES,
  CATEGORY_NAME,
  availableTypes,
  hasPresenceIntent,
  renderName,
  computeValues,
  formatCount,
} = require('../../services/StatsCounterService');
const { UserError } = require('../../core/errors');

/**
 * /compteurs : tableau de bord des compteurs de statistiques (éphémère, « Gérer le serveur »).
 * Vues : home · counter:<type> · confirmRemove
 * Salons vocaux verrouillés (Connect refusé à @everyone) dont le nom affiche une valeur,
 * renommés au plus une fois toutes les 10 minutes et seulement si la valeur change.
 */

const SECTION = { emoji: '📊', label: 'Compteurs' };
const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const svc = (client) => client.services.counters;

/** État affiché d'un compteur : on · noperm · off. */
function counterState(client, guild, type) {
  const c = svc(client).counter(guild.id, type);
  if (!c.enabled || !c.channelId) return 'off';
  const channel = guild.channels.cache.get(c.channelId);
  if (!channel) return 'off';
  if (svc(client).problems.has(channel.id) || !svc(client).canManage(channel)) return 'noperm';
  return 'on';
}

const STATES = {
  on: ['🟢', 'Actif'],
  noperm: ['🔒', 'Permissions manquantes'],
  off: ['⚪', 'Non créé'],
};

function assertType(client, type) {
  if (!availableTypes(client).includes(type)) throw new UserError('Ce compteur n\'est pas disponible.');
}

const homeButton = () => actionButton({ command: 'compteurs', action: 'go', args: ['home'], label: 'Accueil', emoji: '🏠' });

function pickRow(client, guild, current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cmd:compteurs:pick')
      .setPlaceholder('Régler un compteur…')
      .addOptions(availableTypes(client).map((type) => {
        const [dot, label] = STATES[counterState(client, guild, type)];
        return { value: type, label: COUNTER_TYPES[type].label, emoji: COUNTER_TYPES[type].emoji, description: `${dot} ${label} · ${COUNTER_TYPES[type].description}`.slice(0, 100), default: current === type };
      })),
  );
}

function homeView(client, guild, notice) {
  const service = svc(client);
  const types = availableTypes(client);
  const values = computeValues(guild);
  const cfg = service.cfg(guild.id);
  const states = types.map((t) => [t, counterState(client, guild, t)]);
  const active = states.filter(([, s]) => s !== 'off').length;
  const noperm = states.filter(([, s]) => s === 'noperm').length;
  const missing = service.missingGuildPermissions(guild);
  const category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;
  const lines = states.map(([t, s]) => {
    const meta = COUNTER_TYPES[t];
    const [dot, label] = STATES[s];
    const channelId = service.counter(guild.id, t).channelId;
    return `${dot} ${meta.emoji} **${meta.label}** · ${s === 'off' ? label : `<#${channelId}>`}${s === 'noperm' ? ` · *${label}*` : ''} · **${formatCount(values[t])}**`;
  });
  return {
    embeds: [
      card({
        tone: missing.length || noperm ? 'warning' : active ? 'success' : 'info',
        section: SECTION,
        icon: ICONS.stats,
        title: 'Compteurs · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          'Des salons vocaux **verrouillés** dont le nom affiche une statistique du serveur, mis à jour automatiquement.',
          missing.length ? `\n${ICONS.warning} Il me manque : ${missing.map((l) => `**${l}**`).join(', ')} (nécessaire pour créer les salons).` : null,
          noperm ? `\n🔒 Je ne peux pas renommer **${noperm}** salon(s) : donnez-moi **Voir le salon**, **Se connecter** et **Gérer les salons** dans ces salons.` : null,
          '',
          ...lines,
          !hasPresenceIntent(client) ? `\n${subtext('« En ligne » n\'est pas proposé : l\'intent GuildPresences n\'est pas activé sur ce bot.')}` : null,
        ],
        fields: [
          field(ICONS.count, 'Actifs', `${active} / ${types.length}`),
          field(ICONS.category, 'Catégorie', category ? `<#${category.id}>` : '*Aucune*'),
          field(ICONS.refresh, 'Mise à jour', 'Au plus toutes les 10 min'),
        ],
        footer: 'Discord limite le renommage d\'un salon à 2 fois par 10 minutes',
      }),
    ],
    components: [
      pickRow(client, guild),
      ...buttonRows(
        active < types.length
          ? actionButton({ command: 'compteurs', action: 'create', label: active ? 'Créer les manquants' : 'Tout créer', emoji: '⚡', style: ButtonStyle.Primary, disabled: missing.length > 0 })
          : null,
        active ? actionButton({ command: 'compteurs', action: 'refresh', label: 'Mettre à jour', emoji: ICONS.refresh }) : null,
        active || category ? actionButton({ command: 'compteurs', action: 'go', args: ['confirmRemove'], label: 'Tout supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }) : null,
        actionButton({ command: 'compteurs', action: 'go', args: ['home'], label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

function counterView(client, guild, type, notice) {
  assertType(client, type);
  const service = svc(client);
  const meta = COUNTER_TYPES[type];
  const c = service.counter(guild.id, type);
  const state = counterState(client, guild, type);
  const [dot, label] = STATES[state];
  const template = service.templateOf(guild.id, type);
  const value = computeValues(guild)[type];
  const next = service.nextRenameAt(guild.id, type);
  const on = state !== 'off';
  return {
    embeds: [
      card({
        tone: state === 'on' ? 'success' : state === 'noperm' ? 'warning' : 'neutral',
        section: SECTION,
        icon: meta.emoji,
        title: `Compteur · ${meta.label}`,
        description: [
          notice ? `${notice}\n` : null,
          meta.description + '.',
          state === 'noperm' ? `\n🔒 Donnez-moi **Voir le salon**, **Se connecter** et **Gérer les salons** dans <#${c.channelId}> pour qu'il reste à jour.` : null,
          state === 'off' ? `\n${ICONS.info} Activez-le pour créer son salon dans la catégorie **${CATEGORY_NAME}**.` : null,
        ],
        fields: [
          field(ICONS.status, 'État', `${dot} ${label}`),
          field(ICONS.voice, 'Salon', on ? `<#${c.channelId}>` : '—'),
          field(ICONS.count, 'Valeur', `**${formatCount(value)}**`),
          wide(ICONS.tag, 'Modèle', `${code(template)}${c.template ? '' : ' *(par défaut)*'}`),
          wide(ICONS.visible, 'Aperçu', renderName(template, value)),
          on ? field(ICONS.time, 'Prochain renommage', next ? discordTimestamp(next, 'R') : 'Possible maintenant') : null,
        ],
        footer: '{n} est remplacé par la valeur · 100 caractères au plus',
      }),
    ],
    components: [
      pickRow(client, guild, type),
      ...buttonRows(
        on
          ? actionButton({ command: 'compteurs', action: 'toggle', args: [type, 'off'], label: 'Désactiver', emoji: '⏸️', style: ButtonStyle.Danger })
          : actionButton({ command: 'compteurs', action: 'toggle', args: [type, 'on'], label: 'Activer', emoji: '▶️', style: ButtonStyle.Success }),
        actionButton({ command: 'compteurs', action: 'edit', args: [type], label: 'Modifier le nom', emoji: '✏️', style: ButtonStyle.Primary }),
        c.template ? actionButton({ command: 'compteurs', action: 'reset', args: [type], label: 'Modèle par défaut', emoji: '↩️' }) : null,
        homeButton(),
      ),
    ],
  };
}

function confirmRemoveView(client, guild) {
  const service = svc(client);
  const ids = service.active(guild.id).map((t) => service.counter(guild.id, t).channelId).filter((id) => guild.channels.cache.has(id));
  return {
    embeds: [
      card({
        tone: 'danger',
        section: SECTION,
        icon: ICONS.warning,
        title: 'Supprimer les compteurs ?',
        description: [
          `Les **${ids.length}** salon(s) compteurs seront supprimés, ainsi que la catégorie **${CATEGORY_NAME}** si elle est vide :`,
          ids.map((id) => `<#${id}>`).join(' ') || '*Aucun salon trouvé.*',
          '',
          subtext('Les modèles de noms personnalisés seront aussi réinitialisés.'),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'compteurs', action: 'remove', label: 'Oui, supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
      homeButton(),
    ),
  };
}

function render(client, guild, view = 'home', notice) {
  const [name, arg] = String(view).split(/[:.]/);
  if (name === 'counter') return counterView(client, guild, arg, notice);
  if (name === 'confirmRemove') return confirmRemoveView(client, guild);
  return homeView(client, guild, notice);
}

/** Résumé d'une mise à jour (StatsCounterService#update). */
function updateNotice(summary) {
  const parts = [];
  if (summary.renamed.length) parts.push(`${ICONS.success} **${summary.renamed.length}** salon(s) renommé(s)`);
  if (summary.unchanged.length) parts.push(`${summary.unchanged.length} déjà à jour`);
  if (summary.waiting.length) parts.push(`⏳ ${summary.waiting.length} en attente (limite Discord : 10 min)`);
  if (summary.noperm.length) parts.push(`🔒 ${summary.noperm.length} sans permission`);
  if (summary.removed.length) parts.push(`🗑️ ${summary.removed.length} salon(s) supprimé(s) retiré(s)`);
  return parts.length ? parts.join(' · ') : `${ICONS.info} Aucun compteur actif.`;
}

module.exports = {
  category: 'configuration',
  cooldown: 3_000,
  render,
  updateNotice,
  data: new SlashCommandBuilder()
    .setName('compteurs')
    .setDescription('Ouvre le tableau de bord des compteurs de statistiques (salons vocaux).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...render(client, interaction.guild, 'home'), ephemeral: true });
  },

  buttons: {
    /** Menu « Régler un compteur… ». */
    async pick(interaction, client) {
      guard(interaction);
      await interaction.update(counterView(client, interaction.guild, interaction.values?.[0]));
    },
    /** cmd:compteurs:go:<vue> */
    async go(interaction, client, [view]) {
      guard(interaction);
      await interaction.update(render(client, interaction.guild, view ?? 'home'));
    },
    /** Création en un clic : catégorie « 📊 Statistiques » + tous les compteurs manquants. */
    async create(interaction, client) {
      guard(interaction);
      await interaction.deferUpdate();
      const result = await svc(client).create(interaction.guild, availableTypes(client), `Compteurs créés par ${interaction.user.tag}`);
      const notice = `${ICONS.success} **Compteurs prêts** dans <#${result.category.id}>${result.created.length ? ` · ${result.created.length} salon(s) créé(s)` : ''}.`;
      await interaction.editReply(render(client, interaction.guild, 'home', notice));
    },
    /** Mise à jour immédiate (dans la limite de 1 renommage / 10 min par salon). */
    async refresh(interaction, client) {
      guard(interaction);
      await interaction.deferUpdate();
      const summary = await svc(client).update(interaction.guild);
      await interaction.editReply(render(client, interaction.guild, 'home', updateNotice(summary)));
    },
    /** cmd:compteurs:toggle:<type>:<on|off> — valeur cible (un double clic ne réinverse pas). */
    async toggle(interaction, client, [type, state]) {
      guard(interaction);
      assertType(client, type);
      if (state !== 'on' && state !== 'off') throw new UserError('Ce bouton est invalide.');
      const on = counterState(client, interaction.guild, type) !== 'off';
      if ((state === 'on') === on) {
        await interaction.update(counterView(client, interaction.guild, type));
        return;
      }
      await interaction.deferUpdate();
      let notice;
      if (state === 'on') {
        await svc(client).create(interaction.guild, [type], `Compteur activé par ${interaction.user.tag}`);
        notice = `${ICONS.success} Compteur **${COUNTER_TYPES[type].label}** activé.`;
      } else {
        await svc(client).disable(interaction.guild, type, `Compteur désactivé par ${interaction.user.tag}`);
        notice = `${ICONS.success} Compteur **${COUNTER_TYPES[type].label}** désactivé : son salon a été supprimé (le modèle est conservé).`;
      }
      await interaction.editReply(counterView(client, interaction.guild, type, notice));
    },
    /** cmd:compteurs:edit:<type> — ouvre le formulaire du modèle de nom. */
    async edit(interaction, client, [type]) {
      guard(interaction);
      assertType(client, type);
      const input = new TextInputBuilder()
        .setCustomId('modele')
        .setLabel('Modèle du nom ({n} = valeur)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(100)
        .setPlaceholder(COUNTER_TYPES[type].template)
        .setValue(svc(client).templateOf(interaction.guildId, type));
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`cmd:compteurs:template:${type}`)
          .setTitle(`Compteur · ${COUNTER_TYPES[type].label}`)
          .addComponents(new ActionRowBuilder().addComponents(input)),
      );
    },
    /** cmd:compteurs:template:<type> — formulaire soumis. */
    async template(interaction, client, [type]) {
      guard(interaction);
      assertType(client, type);
      const template = svc(client).setTemplate(interaction.guildId, type, interaction.fields.getTextInputValue('modele'));
      await applyAndShow(interaction, client, type, `${ICONS.success} Modèle enregistré : ${code(template)}`);
    },
    /** cmd:compteurs:reset:<type> — modèle par défaut. */
    async reset(interaction, client, [type]) {
      guard(interaction);
      assertType(client, type);
      svc(client).setTemplate(interaction.guildId, type, null);
      await applyAndShow(interaction, client, type, `${ICONS.success} Modèle par défaut rétabli.`);
    },
    /** Suppression (après confirmation) de tous les compteurs. */
    async remove(interaction, client) {
      guard(interaction);
      await interaction.deferUpdate();
      const { removed, failed } = await svc(client).removeAll(interaction.guild, `Compteurs supprimés par ${interaction.user.tag}`);
      const notice = [
        `${ICONS.success} ${removed} salon(s) compteur(s) supprimé(s).`,
        failed.length ? `${ICONS.warning} Impossible de supprimer : ${failed.map((t) => `**${COUNTER_TYPES[t].label}**`).join(', ')} (permission **Gérer les salons** manquante dans ces salons).` : null,
      ].filter(Boolean).join('\n');
      await interaction.editReply(render(client, interaction.guild, 'home', notice));
    },
  },
};

/** Applique tout de suite le nouveau nom si la limite de renommage le permet, puis affiche le compteur. */
async function applyAndShow(interaction, client, type, notice) {
  const fromMessage = interaction.isModalSubmit?.() ? interaction.isFromMessage?.() : true;
  if (fromMessage) await interaction.deferUpdate();
  else await interaction.deferReply({ ephemeral: true });
  let extra = '';
  if (counterState(client, interaction.guild, type) !== 'off') {
    const summary = await svc(client).update(interaction.guild);
    if (summary.renamed.includes(type)) extra = '\nLe salon a été renommé.';
    else if (summary.waiting.includes(type)) extra = `\n⏳ Le salon sera renommé ${discordTimestamp(svc(client).nextRenameAt(interaction.guildId, type), 'R')} (limite Discord).`;
  }
  await interaction.editReply(counterView(client, interaction.guild, type, `${notice}${extra}`));
}
