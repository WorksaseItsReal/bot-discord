'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { discordTimestamp } = require('../../utils/time');
const { confirm } = require('../../utils/confirmation');
const { paginate } = require('../../utils/pagination');
const { card, field, wide, subtext, bullets, code, ICONS, actionButton, buttonRows, ButtonStyle } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { MAX_AUTO_BACKUPS, MAX_MANUAL_BACKUPS } = require('../../services/BackupService');

/** Rappel des quotas (comptés séparément). */
const QUOTA_TEXT = `${MAX_MANUAL_BACKUPS} manuelles + ${MAX_AUTO_BACKUPS} automatiques`;

/** Nombre de sauvegardes par page de /backup list. */
const PER_PAGE = 5;

const RESTORE_WARNING = [
  'Recrée uniquement les rôles et salons **manquants** (comparaison par nom), puis remet les rôles dans l\'ordre de la sauvegarde (sous mon rôle le plus haut).',
  'Ne supprime rien ; les salons existants gardent leurs permissions.',
  'Messages, membres, emojis et attribution des rôles ne sont **pas** restaurés (limite Discord).',
];

/** Avertissements selon l'option « permissions des salons existants ». Pur. */
function restoreWarning(syncPermissions = false) {
  if (!syncPermissions) return RESTORE_WARNING;
  return [
    RESTORE_WARNING[0],
    'Ne supprime rien, mais les permissions des salons **existants** seront **remplacées** par celles de la sauvegarde (celles des intégrations et du bot sont conservées).',
    RESTORE_WARNING[2],
  ];
}

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** Composition d'une sauvegarde (catégories, salons écrits/vocaux, rôles). Pur. */
function composition(data) {
  const channels = data?.channels || [];
  return {
    roles: data?.counts?.roles ?? data?.roles?.length ?? 0,
    channels: data?.counts?.channels ?? channels.length,
    categories: channels.filter((c) => c.type === ChannelType.GuildCategory).length,
    text: channels.filter((c) => TEXT_TYPES.has(c.type)).length,
    voice: channels.filter((c) => VOICE_TYPES.has(c.type)).length,
  };
}

/** Les boutons revérifient la permission par défaut de la commande. */
function assertAdmin(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    throw new UserError('Il faut la permission **Administrateur** pour gérer les sauvegardes.');
  }
}

function dateLines(ts) {
  return `${discordTimestamp(ts, 'D')}\n${discordTimestamp(ts, 'R')}`;
}

/** Fiche détaillée d'une sauvegarde + actions (restaurer, supprimer). */
function infoView(b) {
  const c = composition(b.data);
  const roles = (b.data?.roles || []).slice(0, 15).map((r) => code(truncate(r.name, 30)));
  return {
    embeds: [
      card({
        tone: 'brand',
        section: 'configuration',
        icon: ICONS.memory,
        title: b.name,
        description: [`Sauvegarde de **${truncate(b.data?.name ?? 'ce serveur', 100)}**.`, subtext('Structure uniquement : rôles, salons, catégories et permissions.')],
        thumbnail: b.data?.iconURL || null,
        fields: [
          field(ICONS.id, 'Identifiant', code(b.id)),
          field(ICONS.date, 'Créée', dateLines(b.created_at)),
          field(ICONS.user, 'Par', b.created_by ? `<@${b.created_by}>` : '*Automatique*'),
          field(ICONS.role, 'Rôles', `**${c.roles}**`),
          field(ICONS.category, 'Catégories', `**${c.categories}**`),
          field(ICONS.channel, 'Salons', `**${c.text}** écrits · **${c.voice}** vocaux`),
          wide(ICONS.role, 'Aperçu des rôles', roles.length ? `${roles.join(' ')}${c.roles > roles.length ? ` ${subtext(`+${c.roles - roles.length}`)}` : ''}` : '*Aucun rôle*'),
          wide(ICONS.warning, 'Avant de restaurer', bullets(RESTORE_WARNING)),
        ],
      }),
    ],
    components: buttonRows(
      actionButton({ command: 'backup', action: 'restore', args: [b.id], label: 'Restaurer', emoji: '♻️', style: ButtonStyle.Primary }),
      actionButton({ command: 'backup', action: 'restore', args: [b.id, 'perms'], label: 'Restaurer + permissions', emoji: ICONS.lock }),
      actionButton({ command: 'backup', action: 'remove', args: [b.id], label: 'Supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
    ),
    ephemeral: true,
  };
}

/**
 * Restauration (après confirmation) puis carte de résultat en suivi.
 * @param {{ syncPermissions?: boolean }} [opts] rétablir aussi les permissions des salons existants
 */
async function runRestore(interaction, backup, id, { syncPermissions = false } = {}) {
  const b = backup.get(interaction.guild.id, id);
  if (backup.isRestoring?.(interaction.guild.id)) throw new UserError('Une restauration est déjà en cours sur ce serveur : attendez qu\'elle se termine.');
  const ok = await confirm(interaction, {
    description: [
      `Restaurer **${truncate(b.name, 100)}** (${code(b.id)})${syncPermissions ? ' **avec les permissions des salons existants**' : ''} ?`,
      '',
      bullets(restoreWarning(syncPermissions)),
    ].join('\n'),
    confirmLabel: syncPermissions ? 'Restaurer + permissions' : 'Restaurer',
    timeout: 45_000,
  });
  if (!ok) return;
  const res = await backup.restore(interaction.guild, id, { syncPermissions });
  await interaction.followUp({ embeds: [restoreResultCard(b, res)], ephemeral: true });
}

const FAILURE_ICONS = { role: ICONS.role, channel: ICONS.channel, order: '↕️', permissions: ICONS.lock };

/** Libellé court d'un échec (« nom (code) »). Pur. */
const failureLine = (f) => `${FAILURE_ICONS[f.kind] ?? ICONS.channel} ${code(truncate(f.name, 40))}${f.kind === 'permissions' ? ' (permissions)' : ''} · ${code(f.code)}`;

/** Carte de résultat d'une restauration (créations, échecs, permissions ignorées). Pur. */
function restoreResultCard(b, res) {
  const created = res.roles + res.channels;
  const synced = res.permissionsSynced ?? 0;
  const reordered = res.reordered ?? 0;
  const failed = res.failed ?? [];
  const skipped = res.skippedOverwrites ?? [];
  const changed = created + synced;
  const tone = failed.length ? (changed ? 'warning' : 'danger') : changed ? 'success' : 'info';
  const failedText = failed.length ? ` **${failed.length}** opération${failed.length > 1 ? 's ont' : ' a'} échoué.` : '';
  let description;
  if (failed.length && !changed) description = `Rien n'a pu être restauré : Discord a refusé **${failed.length}** opération${failed.length > 1 ? 's' : ''}.`;
  else if (created) description = `**${created}** élément${created > 1 ? 's' : ''} recréé${created > 1 ? 's' : ''} depuis **${truncate(b.name, 100)}**.${synced ? ` Permissions rétablies dans **${synced}** salon${synced > 1 ? 's' : ''}.` : ''}${failedText}`;
  else if (synced) description = `Permissions rétablies dans **${synced}** salon${synced > 1 ? 's' : ''} depuis **${truncate(b.name, 100)}**.${failedText}`;
  else description = `Rien à recréer : tous les rôles et salons de la sauvegarde existent déjà${res.syncPermissions ? ', avec les mêmes permissions' : ''}.`;
  return card({
    tone,
    section: 'configuration',
    icon: tone === 'success' ? ICONS.success : tone === 'info' ? ICONS.info : tone === 'danger' ? ICONS.error : ICONS.warning,
    title: failed.length && !changed ? 'Restauration échouée' : 'Restauration terminée',
    description,
    fields: [
      field(ICONS.role, 'Rôles recréés', `**${res.roles}**`),
      field(ICONS.channel, 'Salons recréés', `**${res.channels}**`),
      field(ICONS.id, 'Sauvegarde', code(b.id)),
      res.roles ? field('↕️', 'Rôles replacés', `**${reordered}**`) : null,
      res.syncPermissions ? field(ICONS.lock, 'Permissions rétablies', `**${synced}** salon${synced > 1 ? 's' : ''}`) : null,
      failed.length
        ? wide(ICONS.error, `Échecs (${failed.length})`, `${failed.slice(0, 10).map(failureLine).join('\n')}${failed.length > 10 ? `\n${subtext(`+${failed.length - 10} autre(s)`)}` : ''}\n${subtext('50013 : permission ou hiérarchie insuffisante (je ne peux accorder que les permissions que j\'ai) · 30005/30013 : limite de rôles/salons atteinte.')}`)
        : null,
      skipped.length
        ? wide(ICONS.lock, 'Permissions ignorées', `${truncate(skipped.slice(0, 10).map((s) => code(truncate(s, 40))).join(' '), 900)}${skipped.length > 10 ? ` ${subtext(`+${skipped.length - 10}`)}` : ''}\n${subtext('Rôles ou membres introuvables : ces surcharges de salon n\'ont pas été recréées.')}`)
        : null,
      created
        ? wide(ICONS.warning, 'À vérifier', bullets([
          'Les rôles placés au-dessus de mon rôle le plus haut ne peuvent pas être replacés.',
          'Réattribuez les rôles aux membres (non restaurés).',
          'Les permissions des salons privés recréés.',
        ]))
        : null,
    ],
  });
}

/** Suppression (après confirmation) puis carte de résultat en suivi. */
async function runDelete(interaction, backup, id) {
  const b = backup.get(interaction.guild.id, id);
  const ok = await confirm(interaction, {
    description: `Supprimer définitivement la sauvegarde **${truncate(b.name, 100)}** (${code(b.id)}) ?`,
    confirmLabel: 'Supprimer',
  });
  if (!ok) return;
  backup.delete(interaction.guild.id, id);
  await interaction.followUp({
    embeds: [
      card({
        tone: 'danger',
        section: 'configuration',
        icon: ICONS.delete,
        title: 'Sauvegarde supprimée',
        description: [`**${truncate(b.name, 100)}** (${code(b.id)}) a été supprimée.`, subtext('Cette action est définitive.')],
      }),
    ],
    ephemeral: true,
  });
}

module.exports = {
  category: 'configuration',
  composition,
  restoreResultCard,
  restoreWarning,
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Sauvegarde/restauration de la structure du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('create').setDescription('Crée une sauvegarde.').addStringOption((o) => o.setName('nom').setDescription('Nom').setMaxLength(100)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les sauvegardes.'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails d\'une sauvegarde.').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Supprime une sauvegarde.').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('restore').setDescription('Restaure (recrée rôles/salons manquants).')
        .addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true))
        .addBooleanOption((o) => o.setName('permissions').setDescription('Rétablir aussi les permissions des salons existants (non par défaut)')))
    .addSubcommand((s) =>
      s.setName('auto').setDescription('Active/désactive les sauvegardes automatiques.')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addIntegerOption((o) => o.setName('intervalle_h').setDescription('Intervalle en heures').setMinValue(1))),

  async execute(interaction, client) {
    // Revérifiée ici comme dans les boutons : la permission par défaut peut être modifiée par serveur.
    assertAdmin(interaction);
    const sub = interaction.options.getSubcommand();
    const { backup, config } = client.services;
    const guildId = interaction.guild.id;

    if (sub === 'create') {
      await interaction.deferReply({ ephemeral: true });
      const { id, data } = backup.create(interaction.guild, interaction.user, interaction.options.getString('nom'));
      const b = backup.get(guildId, id);
      const c = composition(data);
      return interaction.editReply({
        embeds: [
          card({
            tone: 'success',
            section: 'configuration',
            icon: ICONS.success,
            title: 'Sauvegarde créée',
            description: [`**${truncate(b.name, 100)}** est prête à être restaurée.`, subtext(`Les ${MAX_MANUAL_BACKUPS} sauvegardes manuelles les plus récentes sont conservées (les automatiques ont leur propre quota).`)],
            fields: [
              field(ICONS.id, 'Identifiant', code(id)),
              field(ICONS.role, 'Rôles', `**${c.roles}**`),
              field(ICONS.channel, 'Salons', `**${c.channels}**`),
              wide(ICONS.info, 'Contenu', bullets([
                'Rôles : nom, couleur, permissions, affichage.',
                'Salons et catégories, avec leurs permissions.',
                'Non inclus : messages, membres, emojis.',
              ])),
            ],
          }),
        ],
        components: buttonRows(actionButton({ command: 'backup', action: 'info', args: [id], label: 'Détails', emoji: ICONS.info })),
      });
    }

    if (sub === 'list') {
      const list = backup.list(guildId);
      const auto = config.get(guildId).autobackup;
      const autoLine = auto?.enabled ? `🟢 Automatiques : toutes les **${auto.intervalHours} h**` : '🔴 Sauvegardes automatiques désactivées';
      if (!list.length) {
        return interaction.reply({
          embeds: [card({ tone: 'info', section: 'configuration', icon: ICONS.memory, title: 'Aucune sauvegarde', description: ['Créez la première avec `/backup create`.', subtext(autoLine)] })],
          ephemeral: true,
        });
      }
      const pages = [];
      for (let i = 0; i < list.length; i += PER_PAGE) {
        const chunk = list.slice(i, i + PER_PAGE);
        pages.push(
          card({
            tone: 'brand',
            section: 'configuration',
            icon: ICONS.memory,
            title: 'Sauvegardes du serveur',
            description: [`**${list.length}** sauvegarde${list.length > 1 ? 's' : ''} · au plus ${QUOTA_TEXT}`, autoLine],
            fields: chunk.map((row) =>
              wide(
                ICONS.memory,
                truncate(row.name, 200),
                [
                  `${ICONS.id} ${code(row.id)}  ·  ${ICONS.role} **${row.role_count ?? 0}** rôles  ·  ${ICONS.channel} **${row.channel_count ?? 0}** salons`,
                  `${ICONS.date} ${discordTimestamp(row.created_at, 'D')} (${discordTimestamp(row.created_at, 'R')})${row.created_by ? ` · par <@${row.created_by}>` : ' · automatique'}`,
                ].join('\n'),
              ),
            ),
            footer: 'Détails : /backup info',
          }),
        );
      }
      return paginate(interaction, pages, { ephemeral: true });
    }

    if (sub === 'info') {
      return interaction.reply(infoView(backup.get(guildId, interaction.options.getString('id'))));
    }

    if (sub === 'delete') return runDelete(interaction, backup, interaction.options.getString('id'));

    if (sub === 'restore') return runRestore(interaction, backup, interaction.options.getString('id'), { syncPermissions: interaction.options.getBoolean('permissions') === true });

    if (sub === 'auto') {
      const enabled = interaction.options.getBoolean('actif');
      const interval = interaction.options.getInteger('intervalle_h');
      const patch = { enabled };
      if (interval) patch.intervalHours = interval;
      const auto = config.update(guildId, { autobackup: patch }).autobackup;
      const next = auto.lastRun ? auto.lastRun + auto.intervalHours * 3_600_000 : null;
      return interaction.reply({
        embeds: [
          card({
            tone: enabled ? 'success' : 'neutral',
            section: 'configuration',
            icon: enabled ? ICONS.success : ICONS.info,
            title: enabled ? 'Sauvegardes automatiques activées' : 'Sauvegardes automatiques désactivées',
            description: enabled
              ? `Une sauvegarde sera créée toutes les **${auto.intervalHours} h**.`
              : 'Plus aucune sauvegarde ne sera créée automatiquement. Les sauvegardes existantes sont conservées.',
            fields: [
              field(ICONS.status, 'État', enabled ? '🟢 Activées' : '🔴 Désactivées'),
              field(ICONS.duration, 'Intervalle', `${auto.intervalHours} h`),
              field(ICONS.date, 'Dernière', auto.lastRun ? discordTimestamp(auto.lastRun, 'R') : '*Jamais*'),
              enabled ? wide(ICONS.time, 'Prochaine', next && next > Date.now() ? discordTimestamp(next, 'R') : 'Au prochain passage du planificateur') : null,
            ],
            footer: `Les ${MAX_AUTO_BACKUPS} sauvegardes automatiques les plus récentes sont conservées`,
          }),
        ],
        ephemeral: true,
      });
    }
    throw new UserError('Sous-commande inconnue.');
  },

  buttons: {
    /** cmd:backup:info:<id> — fiche détaillée (éphémère). */
    async info(interaction, client, [id]) {
      assertAdmin(interaction);
      await interaction.reply(infoView(client.services.backup.get(interaction.guildId, id)));
    },
    /** cmd:backup:restore:<id>[:perms] — restauration après confirmation (« perms » : permissions des salons existants). */
    async restore(interaction, client, [id, mode]) {
      assertAdmin(interaction);
      await runRestore(interaction, client.services.backup, id, { syncPermissions: mode === 'perms' });
    },
    /** cmd:backup:remove:<id> — suppression après confirmation. */
    async remove(interaction, client, [id]) {
      assertAdmin(interaction);
      await runDelete(interaction, client.services.backup, id);
    },
  },
};
