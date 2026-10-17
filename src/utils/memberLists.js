'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { card, field, ICONS, code, subtext, bullets } = require('./ui');
const { discordTimestamp } = require('./time');
const { truncate } = require('./embeds');

/**
 * Listes de membres de /membres liste (pur → testable) : administrateurs, modérateurs, bots,
 * boosters, membres en vocal. La liste « role » est déléguée à /inrole (lazyRolePages).
 *
 * Confidentialité :
 *  - admins et moderateurs : réservées à « Exclure temporairement » OU « Gérer le serveur »
 *    (vérifié par la commande ET par chaque bouton de page), affichées en éphémère ;
 *  - vocal : seuls les salons que le LECTEUR voit sont nommés ; les autres connectés sont
 *    seulement comptés (éphémère, la liste dépend du lecteur) ;
 *  - jamais de ping : les mentions sont dans des embeds.
 * Calculées sur le cache des membres (téléchargé au besoin, borné) : partiel sur un très gros
 * serveur, signalé dans la vue.
 */

const PER_PAGE = 20;

/** Types de listes (hors « role », délégué à /inrole). */
const LIST_TYPES = Object.freeze({
  admins: { label: 'Administrateurs', icon: ICONS.shield, restricted: true, ephemeral: true },
  moderateurs: { label: 'Modérateurs', icon: ICONS.moderator, restricted: true, ephemeral: true },
  bots: { label: 'Bots', icon: ICONS.bot, restricted: false, ephemeral: false },
  boosters: { label: 'Boosters', icon: ICONS.boost, restricted: false, ephemeral: false },
  vocal: { label: 'En vocal', icon: ICONS.voice, restricted: false, ephemeral: true },
});

/** Permissions de modération repérées (hors Administrateur) et leur pictogramme. */
const MOD_FLAGS = Object.freeze([
  [PermissionFlagsBits.BanMembers, ICONS.ban, 'bannir'],
  [PermissionFlagsBits.KickMembers, ICONS.kick, 'expulser'],
  [PermissionFlagsBits.ModerateMembers, ICONS.duration, 'exclure'],
  [PermissionFlagsBits.ManageMessages, '🧹', 'messages'],
  [PermissionFlagsBits.ManageGuild, ICONS.settings, 'serveur'],
]);

const has = (perms, flag) => Boolean(perms?.has?.(flag));

/** Le lecteur peut-il voir les listes réservées (admins, modérateurs) ? Pur. */
function canViewRestricted(perms) {
  return has(perms, PermissionFlagsBits.ModerateMembers) || has(perms, PermissionFlagsBits.ManageGuild);
}

const name = (m) => m.displayName ?? m.user?.globalName ?? m.user?.username ?? m.id;
const byName = (a, b) => String(name(a)).localeCompare(String(name(b)), 'fr');
const handle = (m) => code(truncate(m.user?.username ?? m.id, 32));

/**
 * Lignes d'une liste (pur).
 * @param {keyof LIST_TYPES} type
 * @param {{ guild: object, members: object[], viewer?: object, trustedBots?: string[], voiceStates?: object[] }} ctx
 * @returns {{ rows: string[], counts: Record<string, number>, hidden: number }}
 */
function collect(type, { guild, members = [], viewer = null, trustedBots = [], voiceStates = [] }) {
  const trusted = new Set(trustedBots);
  if (type === 'admins') {
    const list = members.filter((m) => has(m.permissions, PermissionFlagsBits.Administrator));
    const owner = (m) => m.id === guild.ownerId;
    list.sort((a, b) => Number(owner(b)) - Number(owner(a)) || Number(Boolean(a.user?.bot)) - Number(Boolean(b.user?.bot)) || byName(a, b));
    const bots = list.filter((m) => m.user?.bot);
    return {
      rows: list.map((m) => {
        const tags = [owner(m) ? `${ICONS.owner} propriétaire` : null, m.user?.bot ? `${ICONS.bot} bot` : null, trusted.has(m.id) ? `${ICONS.success} de confiance` : null].filter(Boolean);
        return `${m} · ${handle(m)}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
      }),
      counts: { humans: list.length - bots.length, bots: bots.length, trusted: bots.filter((m) => trusted.has(m.id)).length },
      hidden: 0,
    };
  }
  if (type === 'moderateurs') {
    const list = members.filter((m) => !has(m.permissions, PermissionFlagsBits.Administrator) && MOD_FLAGS.some(([flag]) => has(m.permissions, flag))).sort(byName);
    const bots = list.filter((m) => m.user?.bot);
    return {
      rows: list.map((m) => `${m} · ${handle(m)} · ${MOD_FLAGS.filter(([flag]) => has(m.permissions, flag)).map(([, icon]) => icon).join('')}${m.user?.bot ? ` · ${ICONS.bot}${trusted.has(m.id) ? ` ${ICONS.success}` : ''}` : ''}`),
      counts: { humans: list.length - bots.length, bots: bots.length },
      hidden: 0,
    };
  }
  if (type === 'bots') {
    const list = members.filter((m) => m.user?.bot).sort((a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0) || byName(a, b));
    return {
      rows: list.map((m) => `${m} · ${handle(m)} · ajouté ${m.joinedTimestamp ? discordTimestamp(m.joinedTimestamp, 'R') : '—'}`),
      counts: { bots: list.length },
      hidden: 0,
    };
  }
  if (type === 'boosters') {
    const list = members.filter((m) => m.premiumSinceTimestamp).sort((a, b) => a.premiumSinceTimestamp - b.premiumSinceTimestamp || byName(a, b));
    return {
      rows: list.map((m) => `${m} · ${handle(m)} · depuis ${discordTimestamp(m.premiumSinceTimestamp, 'D')} (${discordTimestamp(m.premiumSinceTimestamp, 'R')})`),
      counts: { boosters: list.length },
      hidden: 0,
    };
  }
  if (type === 'vocal') {
    const visible = [];
    let hidden = 0;
    for (const state of voiceStates) {
      if (!state?.channelId) continue;
      const channel = state.channel ?? guild.channels?.cache?.get?.(state.channelId);
      const member = state.member ?? guild.members?.cache?.get?.(state.id);
      if (!channel || !member) continue;
      const sees = viewer && typeof channel.permissionsFor === 'function' ? has(channel.permissionsFor(viewer), PermissionFlagsBits.ViewChannel) : false;
      if (!sees) {
        hidden += 1;
        continue;
      }
      visible.push({ member, channel, state });
    }
    visible.sort((a, b) => (a.channel.rawPosition ?? 0) - (b.channel.rawPosition ?? 0) || String(a.channel.id).localeCompare(String(b.channel.id)) || byName(a.member, b.member));
    return {
      rows: visible.map(({ member, channel, state }) => {
        const marks = [state.serverMute || state.selfMute ? ICONS.mute : null, state.serverDeaf || state.selfDeaf ? '🎧' : null, state.streaming ? '📺' : null].filter(Boolean).join('');
        return `${member} · ${ICONS.voice} ${channel}${marks ? ` · ${marks}` : ''}`;
      }),
      counts: { visible: visible.length },
      hidden,
    };
  }
  throw new Error(`Liste inconnue : ${type}`);
}

function pageCount(n) {
  return Math.max(1, Math.ceil(n / PER_PAGE));
}

/** Page `index` d'une liste (pur). */
function buildListPage(type, data, index, { guildName = 'ce serveur', partial = false, partialNote = null } = {}) {
  const meta = LIST_TYPES[type];
  const pages = pageCount(data.rows.length);
  const i = Math.min(Math.max(0, index), pages - 1);
  const slice = data.rows.slice(i * PER_PAGE, (i + 1) * PER_PAGE);
  const n = data.rows.length;
  const intro = {
    admins: `**${n}** membre${n > 1 ? 's ont' : ' a'} la permission **Administrateur** sur ${guildName}.`,
    moderateurs: `**${n}** membre${n > 1 ? 's peuvent' : ' peut'} sanctionner sans être administrateur.`,
    bots: `**${n}** bot${n > 1 ? 's' : ''} sur ${guildName}, du plus récent au plus ancien.`,
    boosters: `**${n}** booster${n > 1 ? 's' : ''}, du plus fidèle au plus récent.`,
    vocal: `**${n}** membre${n > 1 ? 's' : ''} en vocal dans les salons que vous voyez.`,
  }[type];
  const notes = [];
  if (type === 'moderateurs') notes.push(MOD_FLAGS.map(([, icon, label]) => `${icon} ${label}`).join(' · '));
  if (type === 'vocal' && data.hidden) notes.push(`${data.hidden} autre(s) connecté(s) dans des salons que vous ne voyez pas.`);
  if (meta.restricted) notes.push('Liste réservée à la modération.');
  if (partial) notes.push(partialNote ?? 'Liste peut-être incomplète : tous les membres n\'ont pas pu être chargés.');
  const counts = data.counts;
  const fields = {
    admins: [field(ICONS.user, 'Humains', `**${counts.humans}**`), field(ICONS.bot, 'Bots', `**${counts.bots}**`), field(ICONS.success, 'Bots de confiance', `**${counts.trusted}**`)],
    moderateurs: [field(ICONS.user, 'Humains', `**${counts.humans}**`), field(ICONS.bot, 'Bots', `**${counts.bots}**`)],
    bots: [],
    boosters: [],
    vocal: data.hidden ? [field(ICONS.hidden, 'Non affichés', `**${data.hidden}**`)] : [],
  }[type];
  return card({
    tone: 'brand',
    section: 'information',
    icon: meta.icon,
    title: meta.label,
    description: [intro, '', n ? bullets(slice) : '*Personne pour le moment.*', ...notes.map((t) => subtext(t))],
    fields,
    footer: pages > 1 ? `Page ${i + 1}/${pages}` : undefined,
  });
}

module.exports = { LIST_TYPES, MOD_FLAGS, PER_PAGE, canViewRestricted, collect, buildListPage, pageCount };
