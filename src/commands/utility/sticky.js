'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { card, field, ICONS, status, subtext, buttonRows, actionButton } = require('../../utils/ui');
const { truncate } = require('../../utils/embeds');
const { requirePermission } = require('../../services/ModerationService');
const { MAX_STICKIES, MAX_CONTENT, MAX_TITLE, MIN_THRESHOLD, MAX_THRESHOLD } = require('../../services/StickyService');
const { UserError } = require('../../core/errors');

/**
 * /sticky definir | retirer | liste : messages épinglés automatiquement, réaffichés en bas
 * d'un salon après de l'activité (« Gérer les messages »). Voir services/StickyService.js.
 */

const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const SECTION = { emoji: '📌', label: 'Messages épinglés' };
const SEND_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

const guard = (interaction) => requirePermission(interaction, 'ManageMessages');
const row = (component) => new ActionRowBuilder().addComponents(component);

/** Salon cible : textuel, du serveur, où l'auteur peut gérer les messages et le bot écrire. */
function resolveChannel(interaction, channelId) {
  if (!SNOWFLAKE.test(channelId ?? '')) throw new UserError('Salon invalide.');
  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel || !TEXT_TYPES.includes(channel.type)) throw new UserError('Choisissez un salon textuel du serveur.');
  const memberPerms = interaction.member?.permissionsIn ? interaction.member.permissionsIn(channel) : null;
  if (memberPerms && !memberPerms.has(PermissionFlagsBits.ManageMessages)) throw new UserError(`Il vous faut la permission **Gérer les messages** dans <#${channel.id}>.`);
  return channel;
}

function assertBotCanSend(interaction, channel) {
  const me = interaction.guild.members?.me;
  const perms = me && channel.permissionsFor?.(me);
  if (perms && !perms.has(SEND_PERMS)) throw new UserError(`Je ne peux pas écrire dans <#${channel.id}> : donnez-moi **Voir**, **Envoyer** et **Intégrer des liens**.`);
}

function textField(interaction, id) {
  try {
    const v = interaction.fields.getTextInputValue(id)?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

function stickyModal(channel, current) {
  const input = (id, label, { value, placeholder, style = TextInputStyle.Short, max, required = false }) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
    if (value != null && String(value) !== '') t.setValue(String(value).slice(0, max));
    if (placeholder) t.setPlaceholder(placeholder);
    return row(t);
  };
  return new ModalBuilder()
    .setCustomId(`cmd:sticky:setsubmit:${channel.id}`)
    .setTitle(truncate(`Message épinglé · #${channel.name}`, 45))
    .addComponents(
      input('title', 'Titre (facultatif)', { value: current?.title, max: MAX_TITLE, placeholder: 'Règles du salon' }),
      input('content', 'Contenu', { value: current?.content, style: TextInputStyle.Paragraph, max: MAX_CONTENT, required: true, placeholder: 'Merci de rester courtois…' }),
      input('threshold', `Réafficher après N envois (${MIN_THRESHOLD} à ${MAX_THRESHOLD})`, { value: current?.threshold ?? 3, max: 2, required: true, placeholder: '3' }),
    );
}

function listView(client, guild, notice) {
  const rows = client.services.sticky.list(guild.id);
  const lines = rows.map((r) => `📌 <#${r.channel_id}> · ${r.title ? `**${truncate(r.title, 60)}**` : truncate(r.content.replace(/\s+/g, ' '), 60)} · après **${r.threshold}** envoi(s)`);
  const components = [];
  if (rows.length) {
    const name = (id) => guild.channels?.cache?.get(id)?.name ?? 'salon supprimé';
    components.push(row(
      new StringSelectMenuBuilder()
        .setCustomId('cmd:sticky:remove')
        .setPlaceholder('Retirer un message épinglé…')
        .setMinValues(1)
        .setMaxValues(rows.length)
        .addOptions(rows.map((r) => ({ value: r.channel_id, label: truncate(`#${name(r.channel_id)}`, 100), description: truncate(r.title || r.content, 100), emoji: '🗑️' }))),
    ));
  }
  components.push(...buttonRows(actionButton({ command: 'sticky', action: 'list', label: 'Actualiser', emoji: ICONS.refresh })));
  return {
    embeds: [
      card({
        tone: 'info',
        section: SECTION,
        icon: ICONS.list,
        title: 'Messages épinglés automatiquement',
        description: [
          notice ? `${notice}\n` : null,
          lines.length ? lines.join('\n') : '*Aucun message épinglé. Utilisez `/sticky definir`.*',
          '',
          subtext('Réaffichés en bas du salon après N envois (ou une minute d\'activité), au plus toutes les 15 s.'),
        ],
        fields: [field(ICONS.count, 'Messages épinglés', `${rows.length} / ${MAX_STICKIES}`)],
      }),
    ],
    components,
  };
}

module.exports = {
  category: 'utility',
  cooldown: 3_000,
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Messages épinglés automatiquement en bas d\'un salon.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s
        .setName('definir')
        .setDescription('Définit (ou modifie) le message épinglé d\'un salon.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut : celui-ci)').addChannelTypes(...TEXT_TYPES)),
    )
    .addSubcommand((s) =>
      s
        .setName('retirer')
        .setDescription('Retire le message épinglé d\'un salon.')
        .addChannelOption((o) => o.setName('salon').setDescription('Salon (par défaut : celui-ci)').addChannelTypes(...TEXT_TYPES)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Liste les messages épinglés du serveur.')),

  async execute(interaction, client) {
    guard(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === 'liste') {
      await interaction.reply({ ...listView(client, interaction.guild), ephemeral: true });
      return;
    }
    const channel = resolveChannel(interaction, interaction.options.getChannel('salon')?.id ?? interaction.channelId);
    const current = client.services.sticky.get(channel.id);
    if (sub === 'definir') {
      if (!current && client.services.sticky.list(interaction.guildId).length >= MAX_STICKIES) throw new UserError(`${MAX_STICKIES} messages épinglés maximum : retirez-en un d'abord.`);
      assertBotCanSend(interaction, channel);
      await interaction.showModal(stickyModal(channel, current));
      return;
    }
    // retirer
    if (!current) throw new UserError(`Aucun message épinglé dans <#${channel.id}>.`);
    await interaction.deferReply({ ephemeral: true });
    await client.services.sticky.remove(channel.id);
    await interaction.editReply({ embeds: [status.ok(`Message épinglé retiré de <#${channel.id}>.`)] });
  },

  buttons: {
    /** cmd:sticky:setsubmit:<channelId> — formulaire de /sticky definir. */
    async setsubmit(interaction, client, [channelId]) {
      guard(interaction);
      const channel = resolveChannel(interaction, channelId);
      assertBotCanSend(interaction, channel);
      const content = textField(interaction, 'content');
      if (!content) throw new UserError('Le contenu est obligatoire.');
      if (content.length > MAX_CONTENT) throw new UserError(`Le contenu est limité à ${MAX_CONTENT} caractères.`);
      const title = textField(interaction, 'title') ?? null;
      if (title && title.length > MAX_TITLE) throw new UserError(`Le titre est limité à ${MAX_TITLE} caractères.`);
      const threshold = Number((textField(interaction, 'threshold') ?? '3').replace(/\s/g, ''));
      if (!Number.isInteger(threshold) || threshold < MIN_THRESHOLD || threshold > MAX_THRESHOLD) throw new UserError(`Entrez un nombre d'envois entier entre ${MIN_THRESHOLD} et ${MAX_THRESHOLD}.`);
      const existing = client.services.sticky.get(channel.id);
      if (!existing && client.services.sticky.list(interaction.guildId).length >= MAX_STICKIES) throw new UserError(`${MAX_STICKIES} messages épinglés maximum : retirez-en un d'abord.`);
      await interaction.deferReply({ ephemeral: true });
      const { posted } = await client.services.sticky.set({ guildId: interaction.guildId, channel, title, content, threshold, authorId: interaction.user.id });
      const embed = posted
        ? status.ok(`Message épinglé ${existing ? 'modifié' : 'défini'} dans <#${channel.id}> : il sera réaffiché après **${threshold}** envoi(s).`)
        : status.warn(`Message épinglé enregistré pour <#${channel.id}>, mais je n'ai pas pu le publier pour l'instant (permissions ?). Il le sera à la prochaine activité.`);
      await interaction.editReply({ embeds: [embed] });
    },
    /** Menu « Retirer un message épinglé » (valeurs : identifiants de salons). */
    async remove(interaction, client) {
      guard(interaction);
      const ids = (interaction.values ?? []).filter((id) => SNOWFLAKE.test(id));
      await interaction.deferUpdate();
      let n = 0;
      for (const id of ids) {
        const channel = interaction.guild.channels.cache.get(id);
        const memberPerms = channel && interaction.member?.permissionsIn ? interaction.member.permissionsIn(channel) : null;
        if (memberPerms && !memberPerms.has(PermissionFlagsBits.ManageMessages)) continue;
        const row = client.services.sticky.get(id);
        if (row?.guild_id !== interaction.guildId) continue;
        if (await client.services.sticky.remove(id)) n += 1;
      }
      await interaction.editReply(listView(client, interaction.guild, `${ICONS.success} ${n} message(s) épinglé(s) retiré(s).`));
    },
    /** Actualiser la liste. */
    async list(interaction, client) {
      guard(interaction);
      await interaction.update(listView(client, interaction.guild));
    },
  },
};
