'use strict';

const { SlashCommandBuilder, ApplicationCommandOptionType: T, PermissionsBitField } = require('discord.js');
const { truncate } = require('../../utils/embeds');
const { row, selectMenu } = require('../../utils/components');
const { CATEGORIES, categoryMeta } = require('../../utils/categories');
const { permissionLabel } = require('../../utils/permissionNames');
const { card, field, wide, ICONS, subtext, buttonRows } = require('../../utils/ui');
const { UserError } = require('../../core/errors');
const { inviteButton } = require('../utility/invite');
const { DEFAULT_COOLDOWN_MS } = require('../../events/interactionCreate');
const { isContextMenu, commandLabel, contextMenuWhere } = require('../../core/CommandHandler');

/** Icône des menus contextuels (clic droit → Applications). */
const CONTEXT_ICON = '🖱️';

/** Description d'une commande : celle du slash, sinon celle exportée par le menu contextuel. */
function describe(cmd) {
  if (!isContextMenu(cmd)) return cmd.data.description ?? '';
  return cmd.description ?? contextMenuWhere(cmd);
}

/** Commande par nom saisi (« ban », « /ban », « signaler le message »), sans tenir compte de la casse. */
function findCommand(commands, raw) {
  const key = String(raw ?? '').trim().replace(/^\//, '').toLowerCase();
  if (!key) return null;
  return commands.get(key) ?? [...commands.values()].find((c) => c.data.name.toLowerCase() === key) ?? null;
}

/**
 * /help interactif : accueil avec toutes les catégories, menu déroulant pour
 * naviguer, et fiche détaillée de chaque commande (sous-commandes, options).
 */
module.exports = {
  guildOnly: false,
  category: 'information',
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Affiche le menu d\'aide interactif du bot.')
    .addStringOption((o) => o.setName('commande').setDescription('Détail d\'une commande précise').setAutocomplete(true).setMaxLength(32)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction, client) {
    const specific = interaction.options.getString('commande');
    if (specific) {
      const cmd = findCommand(client.commands, specific);
      if (!cmd) throw new UserError(`Commande inconnue : \`${truncate(specific, 32)}\`. Tapez \`/help\` pour la liste.`);
      return interaction.reply({ embeds: [commandDetailEmbed(cmd)], ephemeral: true });
    }

    const grouped = groupByCategory(client.commands);
    const menuId = `help:${interaction.id}`;
    const menu = (selected) =>
      selectMenu({
        id: menuId,
        placeholder: 'Choisissez une catégorie…',
        options: [
          { label: 'Accueil', value: '__home', description: 'Vue d\'ensemble', emoji: ICONS.server, default: selected === '__home' },
          ...[...grouped.keys()].slice(0, 24).map((key) => ({
            label: categoryMeta(key).label,
            value: key,
            description: `${grouped.get(key).length} commande(s) — ${categoryMeta(key).description}`,
            emoji: categoryMeta(key).emoji,
            default: selected === key,
          })),
        ],
      });
    const links = buttonRows(inviteButton(client));
    const components = (selected) => [row(menu(selected)), ...links];

    const message = await interaction.reply({
      embeds: [homeEmbed(client, grouped)],
      components: components('__home'),
      ephemeral: true,
      fetchReply: true,
    });

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId === menuId,
      time: 300_000,
    });
    collector.on('collect', async (i) => {
      const key = i.values[0];
      const embed = key === '__home' || !grouped.has(key) ? homeEmbed(client, grouped) : categoryEmbed(key, grouped.get(key));
      await i.update({ embeds: [embed], components: components(key) }).catch(() => {});
    });
    // Fin de navigation : le menu disparaît, les liens restent utiles.
    collector.on('end', () => interaction.editReply({ components: links }).catch(() => {}));
  },

  /** @param {import('discord.js').AutocompleteInteraction} interaction */
  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused().toLowerCase().replace(/^\//, '');
    const choices = [...client.commands.values()]
      .filter((c) => c.data.name.toLowerCase().includes(focused) || describe(c).toLowerCase().includes(focused))
      .sort((a, b) => a.data.name.localeCompare(b.data.name))
      .slice(0, 25)
      .map((c) => ({ name: truncate(`${isContextMenu(c) ? `${CONTEXT_ICON} ${c.data.name}` : `/${c.data.name}`} — ${describe(c)}`, 100), value: c.data.name }));
    await interaction.respond(choices);
  },
};

function groupByCategory(commands) {
  const map = new Map();
  for (const key of Object.keys(CATEGORIES)) {
    const cmds = [...commands.values()].filter((c) => c.category === key);
    if (cmds.length) map.set(key, cmds.sort((a, b) => a.data.name.localeCompare(b.data.name)));
  }
  for (const cmd of commands.values()) {
    if (!map.has(cmd.category)) map.set(cmd.category, [...commands.values()].filter((c) => c.category === cmd.category));
  }
  return map;
}

/** Sous-commandes « à plat » d'une commande (groupes dépliés). */
function subcommandsOf(data) {
  return (data.options || []).flatMap((o) => (o.type === T.Subcommand ? [o] : o.type === T.SubcommandGroup ? o.options || [] : []));
}

/** Nombre total de commandes + sous-commandes (ce que l'utilisateur peut réellement taper). */
function countEntries(commands) {
  let n = 0;
  for (const c of commands.values()) n += subcommandsOf(c.data.toJSON()).length || 1;
  return n;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function homeEmbed(client, grouped) {
  return card({
    tone: 'brand',
    section: 'information',
    icon: ICONS.help,
    title: `Aide de ${client.user.username}`,
    description: [
      `Bienvenue ! **${client.commands.size}** commandes et **${countEntries(client.commands)}** actions sont à votre disposition.`,
      '',
      `${ICONS.next} Choisissez une **catégorie** dans le menu ci-dessous.`,
      `${ICONS.search} Tapez \`/help commande:<nom>\` pour la fiche d'une commande.`,
      subtext('Les commandes que vous ne pouvez pas utiliser sont masquées par Discord.'),
    ],
    thumbnail: client.user.displayAvatarURL({ size: 256 }),
    fields: [...grouped.entries()].slice(0, 24).map(([key, cmds]) => {
      const meta = categoryMeta(key);
      return field(meta.emoji, meta.label, `\`${plural(cmds.length, 'commande')}\``);
    }),
  });
}

function categoryEmbed(key, cmds) {
  const meta = categoryMeta(key);
  const lines = cmds.map((c) => {
    if (isContextMenu(c)) return `${CONTEXT_ICON} **${c.data.name}** — ${describe(c)} *(${contextMenuWhere(c).toLowerCase()})*`;
    const subs = subcommandsOf(c.data.toJSON()).length;
    return `**\`/${c.data.name}\`** — ${c.data.description}${subs ? ` *(${plural(subs, 'action')})*` : ''}`;
  });
  return card({
    tone: 'brand',
    section: 'information',
    icon: meta.emoji,
    title: meta.label,
    description: [meta.description, '', ...lines],
    footer: `${plural(cmds.length, 'commande')} • /help commande:<nom> pour le détail`,
  });
}

function describeOption(o) {
  return `\`${o.name}\`${o.required ? '' : ' *(optionnel)*'} — ${o.description}`;
}

/** Répartit des lignes sur plusieurs champs pleine largeur (≤ 1024 caractères chacun). */
function chunkFields(icon, label, lines) {
  const out = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk && (chunk + line).length > 1000) {
      out.push(wide(out.length ? null : icon, out.length ? '​' : label, chunk));
      chunk = '';
    }
    chunk += `${line}\n`;
  }
  if (chunk) out.push(wide(out.length ? null : icon, out.length ? '​' : label, chunk));
  return out;
}

/** Délai entre deux utilisations : celui de la commande, sinon le délai par défaut du routeur. */
function cooldownLabel(cmd) {
  const ms = cmd.cooldown ?? DEFAULT_COOLDOWN_MS;
  if (!ms) return 'Aucun';
  const s = ms / 1000;
  return `\`${Number.isInteger(s) ? s : s.toFixed(1).replace('.', ',')} s\`${cmd.cooldown == null ? ' (par défaut)' : ''}`;
}

function commandDetailEmbed(cmd) {
  const data = cmd.data.toJSON();
  const options = data.options || [];
  const meta = categoryMeta(cmd.category);
  const fields = [
    field(ICONS.category, 'Catégorie', `${meta.emoji} ${meta.label}`),
    field(ICONS.mail, 'En message privé', cmd.guildOnly === false ? 'Oui' : 'Non'),
    field(ICONS.duration, 'Délai', cooldownLabel(cmd)),
  ];
  if (data.default_member_permissions) {
    const perms = new PermissionsBitField(BigInt(data.default_member_permissions)).toArray().map(permissionLabel);
    if (perms.length) fields.push(wide(ICONS.lock, 'Permission requise', perms.join(' · ')));
  }

  const subs = options.filter((o) => o.type === T.Subcommand || o.type === T.SubcommandGroup);
  if (isContextMenu(cmd)) {
    fields.push(wide(CONTEXT_ICON, 'Utilisation', `${contextMenuWhere(cmd)} → **${data.name}**`));
  } else if (subs.length) {
    const lines = subs.flatMap((s) =>
      s.type === T.SubcommandGroup
        ? (s.options || []).map((ss) => `**\`/${data.name} ${s.name} ${ss.name}\`** — ${ss.description}`)
        : [`**\`/${data.name} ${s.name}\`** — ${s.description}`],
    );
    fields.push(...chunkFields(ICONS.list, `Sous-commandes (${lines.length})`, lines));
  } else {
    fields.push(wide(ICONS.settings, 'Options', options.length ? options.map(describeOption).join('\n') : '*Aucune option*'));
  }

  return card({
    tone: 'info',
    section: 'information',
    icon: isContextMenu(cmd) ? CONTEXT_ICON : ICONS.search,
    title: commandLabel(cmd).replace(/^« (.*) »$/, '$1'),
    description: [describe(cmd), subtext(isContextMenu(cmd) ? 'Menu contextuel : il n\'apparaît pas dans la liste des commandes /.' : `Tapez /${data.name} pour l'utiliser.`)],
    fields,
  });
}

module.exports.commandDetailEmbed = commandDetailEmbed;
module.exports.cooldownLabel = cooldownLabel;
module.exports.homeEmbed = homeEmbed;
module.exports.categoryEmbed = categoryEmbed;
module.exports.groupByCategory = groupByCategory;
module.exports.findCommand = findCommand;
