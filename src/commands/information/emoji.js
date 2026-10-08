'use strict';

const { SlashCommandBuilder, SnowflakeUtil } = require('discord.js');
const { card, field, wide, ICONS, code, subtext, linkButton, buttonRows } = require('../../utils/ui');
const { discordTimestamp } = require('../../utils/time');
const { UserError } = require('../../core/errors');

/** Bloc de code copiable (les accents graves sont neutralisés). */
function copyBlock(text) {
  return `\`\`\`\n${String(text).replace(/`/g, 'ˋ')}\n\`\`\``;
}

/** Nombre maximal d'emojis standard analysés en une fois. */
const MAX_EMOJIS = 10;
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/u;
const segmenter = new Intl.Segmenter('fr', { granularity: 'grapheme' });

/**
 * Un graphème est-il un vrai emoji Unicode ? Pictogramme (`\p{Extended_Pictographic}`,
 * avec ses variantes : teinte, ZWJ…), drapeau (indicateurs régionaux) ou keycap (1️⃣ #️⃣ *️⃣). Pur.
 */
function isStandardEmoji(grapheme) {
  return KEYCAP.test(grapheme) || /\p{Extended_Pictographic}/u.test(grapheme) || /^\p{Regional_Indicator}{2}$/u.test(grapheme);
}

/** Emojis standard d'une saisie (hors espaces), ou null si un élément n'en est pas un. Pur. */
function parseStandardEmojis(input) {
  const graphemes = [...segmenter.segment(String(input ?? ''))].map((s) => s.segment).filter((g) => !/^\s+$/u.test(g));
  if (!graphemes.length || graphemes.length > MAX_EMOJIS || !graphemes.every(isStandardEmoji)) return null;
  return graphemes;
}

module.exports = {
  guildOnly: false,
  isStandardEmoji,
  parseStandardEmojis,
  data: new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Affiche un emoji personnalisé en grand avec ses informations.')
    .addStringOption((o) => o.setName('emoji').setDescription('L\'emoji (ex : :pepe:)').setRequired(true).setMaxLength(100)),
  async execute(interaction, client) {
    const input = interaction.options.getString('emoji').trim();
    const custom = input.match(/<(a?):(\w{2,32}):(\d{17,20})>/);
    if (custom) {
      const [raw, animated, name, id] = custom;
      const ext = animated ? 'gif' : 'png';
      const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=512`;
      const known = client.emojis?.cache?.get(id);
      const created = Number(SnowflakeUtil.timestampFrom(id));
      return interaction.reply({
        embeds: [
          card({
            tone: 'brand',
            section: 'information',
            icon: ICONS.emoji,
            title: `:${name}:`,
            url,
            description: [
              `Emoji personnalisé${animated ? ' **animé**' : ''}.`,
              subtext(known?.guild ? `Provient du serveur ${known.guild.name}.` : 'Serveur d\'origine inconnu du bot.'),
            ],
            image: url,
            fields: [
              field(ICONS.id, 'Identifiant', code(id)),
              field(ICONS.image, 'Format', animated ? 'GIF animé' : 'PNG'),
              field(ICONS.date, 'Créé', `${discordTimestamp(created, 'D')}\n${discordTimestamp(created, 'R')}`),
              wide(ICONS.tag, 'Code', copyBlock(raw)),
            ],
          }),
        ],
        components: buttonRows(
          linkButton('Ouvrir', url, ICONS.link),
          linkButton('WEBP', `https://cdn.discordapp.com/emojis/${id}.webp?size=512${animated ? '&animated=true' : ''}`),
        ),
      });
    }

    const emojis = parseStandardEmojis(input);
    if (!emojis) {
      throw new UserError(`Envoyez un emoji personnalisé (ex : \`:pepe:\`) ou jusqu'à ${MAX_EMOJIS} emojis standard (ex : 😀 🇫🇷 1️⃣).`);
    }
    const chars = [...emojis.join('')];
    const codes = chars.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
    await interaction.reply({
      embeds: [
        card({
          tone: 'brand',
          section: 'information',
          icon: ICONS.emoji,
          title: 'Emoji standard',
          description: [`# ${emojis.join('')}`, subtext('Emoji Unicode : disponible partout, sans Nitro.')],
          fields: [
            field(ICONS.id, 'Unicode', code(codes)),
            field(ICONS.count, 'Points de code', `**${chars.length}**`),
            wide(ICONS.tag, 'Copier', copyBlock(emojis.join(''))),
          ],
        }),
      ],
    });
  },
};
