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
  'Recrée uniquement les rôles et salons **manquants** (comparaison par nom).',
  'Ne supprime ni ne modifie rien d\'existant.',
  'Messages, membres, emojis et attribution des rôles ne sont **pas** restaurés (limite Discord).',
];

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
      actionButton({ command: 'backup', action: 'remove', args: [b.id], label: 'Supprimer', emoji: ICONS.delete, style: ButtonStyle.Danger }),
    ),
    ephemeral: true,
  };
}

/** Restauration (après confirmation) puis carte de résultat en suivi. */
async function runRestore(interaction, backup, id) {
  const b = backup.get(interaction.guild.id, id);
  const ok = await confirm(interaction, {
    description: [`Restaurer **${truncate(b.name, 100)}** (${code(b.id)}) ?`, '', bullets(RESTORE_WARNING)].join('\n'),
    confirmLabel: 'Restaurer',
    timeout: 45_000,
  });
  if (!ok) return;
  const res = await backup.restore(interaction.guild, id);
  const created = res.roles + res.channels;
  await interaction.followUp({
    embeds: [
      card({
        tone: created ? 'success' : 'info',
        section: 'configuration',
        icon: created ? ICONS.success : ICONS.info,
        title: 'Restauration terminée',
        description: created
          ? `**${created}** élément${created > 1 ? 's' : ''} recréé${created > 1 ? 's' : ''} depuis **${truncate(b.name, 100)}**.`
          : 'Rien à recréer : tous les rôles et salons de la sauvegarde existent déjà.',
        fields: [
          field(ICONS.role, 'Rôles recréés', `**${res.roles}**`),
          field(ICONS.channel, 'Salons recréés', `**${res.channels}**`),
          field(ICONS.id, 'Sauvegarde', code(b.id)),
          created
            ? wide(ICONS.warning, 'À vérifier', bullets([
              'L\'ordre des rôles recréés : replacez-les si besoin.',
              'Réattribuez les rôles aux membres (non restaurés).',
              'Les permissions des salons privés recréés.',
            ]))
            : null,
        ],
      }),
    ],
    ephemeral: true,
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
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Sauvegarde/restauration de la structure du serveur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName('create').setDescription('Crée une sauvegarde.').addStringOption((o) => o.setName('nom').setDescription('Nom').setMaxLength(100)))
    .addSubcommand((s) => s.setName('list').setDescription('Liste les sauvegardes.'))
    .addSubcommand((s) => s.setName('info').setDescription('Détails d\'une sauvegarde.').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Supprime une sauvegarde.').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) => s.setName('restore').setDescription('Restaure (recrée rôles/salons manquants).').addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('auto').setDescription('Active/désactive les sauvegardes automatiques.')
        .addBooleanOption((o) => o.setName('actif').setDescription('Activer ?').setRequired(true))
        .addIntegerOption((o) => o.setName('intervalle_h').setDescription('Intervalle en heures').setMinValue(1))),

  async execute(interaction, client) {
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

    if (sub === 'restore') return runRestore(interaction, backup, interaction.options.getString('id'));

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
    /** cmd:backup:restore:<id> — restauration après confirmation. */
    async restore(interaction, client, [id]) {
      assertAdmin(interaction);
      await runRestore(interaction, client.services.backup, id);
    },
    /** cmd:backup:remove:<id> — suppression après confirmation. */
    async remove(interaction, client, [id]) {
      assertAdmin(interaction);
      await runDelete(interaction, client.services.backup, id);
    },
  },
};
