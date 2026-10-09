'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { card, field, ICONS, subtext, status, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { requirePermission, needPermission } = require('../../services/ModerationService');
const { REPORT_COOLDOWN_MS, REPORT_TIMEOUT_MS, MAX_REPORT_REASON, REPORT_ICON, STATUS, TEXT_TYPES, messageLink, normalizeReportReason } = require('../../services/ReportService');
const { snowflake } = require('../../utils/buttonGuard');
const { assertCanModerate } = require('../../utils/permissions');
const { applyEscalation } = require('./warn');
const { UserError } = require('../../core/errors');

/**
 * /signalements : tableau de bord des signalements (éphémère, « Gérer le serveur ») et
 * routes des cartes de signalement publiées dans le salon du staff.
 *
 *   cmd:signalements:submit:<salon>:<message>  formulaire du menu « Signaler le message »
 *   cmd:signalements:del|warn|mute:<id>        actions du staff sur la carte
 *   cmd:signalements:resolve:<id>:<statut>     classer (handled) / rejeter (dismissed)
 */

const MAX_OPEN_LIST = 10;
const guard = (interaction) => requirePermission(interaction, 'ManageGuild');
const cooldownKey = (userId) => `report:${userId}`;

/** Formulaire « Signaler le message » (raison facultative, ≤ 500 caractères). */
function reportModal(channelId, messageId) {
  return new ModalBuilder()
    .setCustomId(`cmd:signalements:submit:${channelId}:${messageId}`)
    .setTitle('Signaler le message')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('raison')
          .setLabel('Raison (facultative)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(MAX_REPORT_REASON)
          .setPlaceholder('Pourquoi ce message pose-t-il problème ? (insulte, spam, arnaque…)'),
      ),
    );
}

/** Refuse si le membre vient déjà d'envoyer un signalement (sans consommer le délai). */
function assertNoCooldown(client, userId) {
  const remaining = client.cooldowns.remaining?.(cooldownKey(userId)) ?? 0;
  if (remaining > 0) throw new UserError(`Vous venez d'envoyer un signalement. Vous pourrez en envoyer un autre ${discordTimestamp(Date.now() + remaining, 'R')}.`);
}

// ---------------------------------------------------------------- tableau de bord

function destinationText(dest) {
  if (dest.status === 'unset') return `${ICONS.warning} *Aucun* : choisissez un salon (ou configurez le salon de logs Modération).`;
  const where = `<#${dest.channelId}>${dest.fallback ? ' *(salon de logs Modération)*' : ''}`;
  if (dest.status === 'missing') return `${ICONS.error} ${where} · *salon introuvable*`;
  if (dest.status === 'noperm') return `🔒 ${where} · *je ne peux pas y écrire*`;
  return where;
}

/** Le salon est-il visible par @everyone ? (les cartes doivent rester réservées au staff) */
function isPublic(guild, channelId) {
  const channel = channelId && guild.channels?.cache?.get(channelId);
  const everyone = guild.roles?.everyone;
  if (!channel?.permissionsFor || !everyone) return false;
  try {
    return channel.permissionsFor(everyone)?.has?.(PermissionFlagsBits.ViewChannel) === true;
  } catch {
    return false;
  }
}

function openLine(guild, r) {
  const cardLink = r.card_channel_id && r.card_message_id ? ` · [carte](${messageLink(guild.id, r.card_channel_id, r.card_message_id)})` : '';
  return `${REPORT_ICON} \`#${r.id}\` · <@${r.target_id}> · <#${r.channel_id}> · ${discordTimestamp(r.created_at, 'R')} · [message](${messageLink(guild.id, r.channel_id, r.message_id)})${cardLink}`;
}

function homeView(client, guild, notice) {
  const { reports } = client.services;
  const settings = reports.settings(guild.id);
  const on = settings.enabled !== false;
  const dest = reports.destination(guild);
  const counts = client.repositories.reports.counts(guild.id);
  const open = client.repositories.reports.list(guild.id, 'open', MAX_OPEN_LIST);
  const showReporter = settings.showReporter !== false;
  const role = settings.pingRoleId && guild.roles?.cache?.has(settings.pingRoleId) ? settings.pingRoleId : null;

  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId('cmd:signalements:channel')
    .setPlaceholder('Salon des signalements (vide : salon de logs Modération)')
    .setChannelTypes(...TEXT_TYPES)
    .setMinValues(0)
    .setMaxValues(1);
  if (settings.channelId && guild.channels?.cache?.has(settings.channelId)) channelMenu.setDefaultChannels(settings.channelId);
  const roleMenu = new RoleSelectMenuBuilder().setCustomId('cmd:signalements:role').setPlaceholder('Rôle à mentionner à chaque signalement (facultatif)').setMinValues(0).setMaxValues(1);
  if (role) roleMenu.setDefaultRoles(role);

  return {
    embeds: [
      card({
        tone: !on ? 'neutral' : dest.status !== 'ok' ? 'warning' : counts.open ? 'caution' : 'success',
        section: 'moderation',
        icon: REPORT_ICON,
        title: 'Signalements · Tableau de bord',
        description: [
          notice ? `${notice}\n` : null,
          on ? '🟢 Les membres peuvent **signaler** un message : clic droit → Applications → **Signaler le message**.' : '🔴 Les signalements sont **désactivés**.',
          on && dest.status !== 'ok' ? `${ICONS.warning} Aucun salon utilisable : les signalements sont refusés tant qu'un salon n'est pas configuré.` : null,
          dest.status === 'ok' && isPublic(guild, dest.channelId) ? `${ICONS.warning} **Ce salon est visible par @everyone** : les cartes (auteur, signaleur, contenu) doivent rester réservées au staff.` : null,
          '',
          `**Signalements ouverts** (${counts.open})`,
          open.length ? open.map((r) => openLine(guild, r)).join('\n') : '*Aucun signalement en attente.* ✨',
          counts.open > open.length ? subtext(`+ ${counts.open - open.length} autre(s) plus ancien(s)`) : null,
        ],
        fields: [
          field(STATUS.open.emoji, 'Ouverts', `**${counts.open}**`),
          field(STATUS.handled.emoji, 'Traités', `**${counts.handled}**`),
          field(STATUS.dismissed.emoji, 'Rejetés', `**${counts.dismissed}**`),
          field(ICONS.channel, 'Salon', destinationText(dest)),
          field('🔔', 'Rôle mentionné', role ? `<@&${role}>` : '*Aucun*'),
          field('🕵️', 'Signaleur', showReporter ? 'Affiché au staff' : 'Masqué (anonyme)'),
        ],
        footer: 'Le membre signalé n\'est jamais prévenu de l\'identité du signaleur',
      }),
    ],
    components: [
      new ActionRowBuilder().addComponents(channelMenu),
      new ActionRowBuilder().addComponents(roleMenu),
      ...buttonRows(
        on
          ? actionButton({ command: 'signalements', action: 'toggle', args: ['off'], label: 'Désactiver', emoji: '⏸️', style: ButtonStyle.Danger })
          : actionButton({ command: 'signalements', action: 'toggle', args: ['on'], label: 'Activer', emoji: '▶️', style: ButtonStyle.Success }),
        showReporter
          ? actionButton({ command: 'signalements', action: 'reporter', args: ['hide'], label: 'Masquer le signaleur', emoji: '🕵️' })
          : actionButton({ command: 'signalements', action: 'reporter', args: ['show'], label: 'Afficher le signaleur', emoji: ICONS.visible }),
        actionButton({ command: 'signalements', action: 'home', label: 'Actualiser', emoji: ICONS.refresh }),
      ),
    ],
  };
}

// ---------------------------------------------------------------- cartes du staff

/** Le cliqueur est-il visé par ce signalement ? (conflit d'intérêts, sauf propriétaire du serveur) */
function assertNotConcerned(interaction, report) {
  if (interaction.user.id === interaction.guild.ownerId) return;
  if (report.target_id === interaction.user.id || report.reporter_id === interaction.user.id) {
    throw new UserError('Ce signalement vous concerne : laissez un autre membre du staff le traiter.');
  }
}

function parseReportId(raw) {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw) || Number(raw) < 1) throw new UserError('Bouton invalide (signalement).');
  return Number(raw);
}

/** Signalement visé par un bouton, revérifié (serveur, conflit d'intérêts). */
function reportFor(interaction, client, rawId) {
  const report = client.services.reports.get(interaction.guildId, parseReportId(rawId));
  assertNotConcerned(interaction, report);
  return report;
}

/** Membre visé (fetch), après acquittement du clic. */
async function targetMember(guild, report) {
  const member = await guild.members.fetch(report.target_id).catch(() => null);
  if (member && (!member.roles?.highest || !member.guild)) throw new UserError('Impossible de vérifier les rôles de ce membre pour le moment. Réessayez dans quelques secondes.');
  return member;
}

const sanctionReason = (report) => `Message signalé (signalement #${report.id})`;

module.exports = {
  category: 'moderation',
  cooldown: 3_000,
  reportModal,
  assertNoCooldown,
  homeView,
  data: new SlashCommandBuilder()
    .setName('signalements')
    .setDescription('Tableau de bord des signalements : salon du staff, rôle à mentionner, signalements ouverts.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    guard(interaction);
    await interaction.reply({ ...homeView(client, interaction.guild), ephemeral: true });
  },

  buttons: {
    // ------------------------------------------------------------ tableau de bord
    /** cmd:signalements:home — actualiser. */
    async home(interaction, client) {
      guard(interaction);
      await interaction.update(homeView(client, interaction.guild));
    },
    /** cmd:signalements:channel — salon des signalements (vide : salon de logs Modération). */
    async channel(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!/^\d{17,20}$/.test(id)) throw new UserError('Salon invalide.');
        const ch = interaction.guild.channels.cache.get(id);
        if (!ch || !TEXT_TYPES.includes(ch.type)) throw new UserError('Choisissez un salon textuel du serveur.');
      }
      client.services.config.update(interaction.guildId, { reports: { channelId: id } });
      const dest = client.services.reports.destination(interaction.guild);
      const notice = !id
        ? `${ICONS.success} Les signalements iront dans le salon de logs Modération${dest.status === 'unset' ? ' (non configuré : `/logs`)' : ''}.`
        : dest.status === 'noperm'
          ? `${ICONS.warning} Salon enregistré, mais je ne peux pas y écrire : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`
          : `${ICONS.success} Signalements → <#${id}>.`;
      await interaction.update(homeView(client, interaction.guild, notice));
    },
    /** cmd:signalements:role — rôle mentionné à chaque signalement. */
    async role(interaction, client) {
      guard(interaction);
      const id = interaction.values?.[0] ?? null;
      if (id) {
        if (!/^\d{17,20}$/.test(id) || id === interaction.guildId) throw new UserError('Choisissez un rôle du staff (pas @everyone).');
        const role = interaction.guild.roles.cache.get(id);
        if (!role) throw new UserError('Ce rôle est introuvable.');
        if (role.managed) throw new UserError('Ce rôle est géré par une intégration : choisissez un rôle du staff.');
      }
      client.services.config.update(interaction.guildId, { reports: { pingRoleId: id } });
      await interaction.update(homeView(client, interaction.guild, id ? `${ICONS.success} <@&${id}> sera mentionné à chaque signalement.` : `${ICONS.success} Plus aucun rôle mentionné.`));
    },
    /** cmd:signalements:toggle:<on|off> — valeur cible (un double clic ne réinverse pas). */
    async toggle(interaction, client, [state]) {
      guard(interaction);
      if (state !== 'on' && state !== 'off') throw new UserError('Bouton invalide.');
      client.services.config.update(interaction.guildId, { reports: { enabled: state === 'on' } });
      await interaction.update(homeView(client, interaction.guild, `${ICONS.success} Signalements ${state === 'on' ? 'activés' : 'désactivés'}.`));
    },
    /** cmd:signalements:reporter:<show|hide> — affichage du signaleur sur les cartes. */
    async reporter(interaction, client, [state]) {
      guard(interaction);
      if (state !== 'show' && state !== 'hide') throw new UserError('Bouton invalide.');
      client.services.config.update(interaction.guildId, { reports: { showReporter: state === 'show' } });
      await interaction.update(homeView(client, interaction.guild, state === 'show' ? `${ICONS.success} Le signaleur est affiché sur les nouvelles cartes.` : `${ICONS.success} Le signaleur est masqué : les cartes indiquent « Anonyme ».`));
    },

    // ------------------------------------------------------------ formulaire du signaleur
    /** cmd:signalements:submit:<salon>:<message> — formulaire « Signaler le message ». */
    async submit(interaction, client, [rawChannelId, rawMessageId]) {
      const channelId = snowflake(rawChannelId, 'salon');
      const messageId = snowflake(rawMessageId, 'message');
      const { reports } = client.services;
      reports.assertAvailable(interaction.guild);
      const reason = normalizeReportReason(interaction.fields.getTextInputValue('raison'));
      const key = cooldownKey(interaction.user.id);
      assertNoCooldown(client, interaction.user.id);
      client.cooldowns.hit(key, REPORT_COOLDOWN_MS);
      try {
        const channel = interaction.guild.channels.cache.get(channelId);
        // customId contrôlé par le client : le signaleur doit pouvoir lire ce salon.
        const perms = channel?.permissionsFor?.(interaction.member);
        if (!channel?.messages || !perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
          throw new UserError('Ce message est introuvable.');
        }
        await interaction.deferReply({ ephemeral: true });
        const message = channel.messages.cache.get(messageId) ?? (await channel.messages.fetch(messageId).catch(() => null));
        if (!message) throw new UserError('Ce message est introuvable (il a peut-être été supprimé).');
        reports.assertReportable(interaction.guildId, interaction.user.id, message);
        const report = await reports.submit(interaction.guild, { reporter: interaction.user, message, reason });
        await interaction.editReply({
          embeds: [
            status.ok(
              ['Merci ! L\'équipe de modération a été prévenue et va examiner ce message.', subtext('Le membre signalé n\'est pas prévenu et ne saura pas qui l\'a signalé.')].join('\n'),
              'Signalement envoyé',
              { footer: `Signalement #${report.id}` },
            ),
          ],
        });
      } catch (err) {
        client.cooldowns.release(key);
        throw err;
      }
    },

    // ------------------------------------------------------------ actions du staff
    /** cmd:signalements:del:<id> — supprime le message signalé. */
    async del(interaction, client, [rawId]) {
      requirePermission(interaction, 'ManageMessages');
      const report = reportFor(interaction, client, rawId);
      const guild = interaction.guild;
      const channel = guild.channels.cache.get(report.channel_id);
      if (!channel?.messages) throw new UserError('Le salon de ce message n\'existe plus.');
      const mine = channel.permissionsFor?.(guild.members.me);
      if (mine && !mine.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
        throw new UserError(`Il me manque la permission **Gérer les messages** dans <#${channel.id}>.`);
      }
      await interaction.deferUpdate();
      const updated = await client.services.reports.act(guild, report, {
        type: 'delete',
        moderator: interaction.user,
        run: async () => {
          const member = await targetMember(guild, report);
          if (member) assertCanModerate(interaction.member, member, guild.members.me, { action: 'supprimer le message de' });
          client.services.logging.suppressMessage(report.message_id);
          try {
            await channel.messages.delete(report.message_id);
          } catch (err) {
            if (err?.code === 10008) return 'Le message avait déjà été supprimé.';
            throw err;
          }
          return null;
        },
      });
      await interaction.editReply(client.services.reports.cardPayload(guild, updated));
    },
    /** cmd:signalements:warn:<id> — avertit l'auteur (strikes et escalade comme /warn). */
    async warn(interaction, client, [rawId]) {
      requirePermission(interaction, 'ModerateMembers');
      const report = reportFor(interaction, client, rawId);
      const guild = interaction.guild;
      await interaction.deferUpdate();
      const { moderation, strikes, reports } = client.services;
      const updated = await reports.act(guild, report, {
        type: 'warn',
        moderator: interaction.user,
        run: async () => {
          const member = await targetMember(guild, report);
          if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
          const { id } = await moderation.warn(guild, member, interaction.member, sanctionReason(report));
          const { count } = strikes.add(guild.id, member.id, 1);
          const step = strikes.pendingEscalation(guild.id, count, moderation.appliedEscalationLevel(guild.id, member.id));
          const escalation = step ? await applyEscalation(client, interaction, member, step) : null;
          return [`Sanction #${id} · ${count} strike(s)`, escalation?.text].filter(Boolean).join(' · ');
        },
      });
      await interaction.editReply(reports.cardPayload(guild, updated));
    },
    /** cmd:signalements:mute:<id> — timeout de 10 minutes pour l'auteur. */
    async mute(interaction, client, [rawId]) {
      requirePermission(interaction, 'ModerateMembers');
      const report = reportFor(interaction, client, rawId);
      const guild = interaction.guild;
      await interaction.deferUpdate();
      const { moderation, reports } = client.services;
      const updated = await reports.act(guild, report, {
        type: 'timeout',
        moderator: interaction.user,
        run: async () => {
          const member = await targetMember(guild, report);
          if (!member) throw new UserError('Ce membre n\'est plus sur le serveur.');
          const { id } = await moderation.timeout(guild, member, interaction.member, sanctionReason(report), REPORT_TIMEOUT_MS);
          return `Sanction #${id}`;
        },
      });
      await interaction.editReply(reports.cardPayload(guild, updated));
    },
    /** cmd:signalements:resolve:<id>:<handled|dismissed> — classer ou rejeter. */
    async resolve(interaction, client, [rawId, state]) {
      const perms = interaction.memberPermissions;
      if (!perms?.has(PermissionFlagsBits.ModerateMembers) && !perms?.has(PermissionFlagsBits.ManageMessages)) throw needPermission('ModerateMembers');
      if (state !== 'handled' && state !== 'dismissed') throw new UserError('Bouton invalide.');
      const report = reportFor(interaction, client, rawId);
      if (report.status !== 'open') throw new UserError('Ce signalement a déjà été traité.');
      await interaction.deferUpdate();
      const updated = await client.services.reports.resolve(interaction.guild, report, state, interaction.user);
      await interaction.editReply(client.services.reports.cardPayload(interaction.guild, updated));
    },
  },
};
