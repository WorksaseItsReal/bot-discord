'use strict';

/**
 * Membres PARTIELS (PRESENCE_INTENT=on) : un PRESENCE_UPDATE d'un membre absent du cache fait créer
 * par discord.js un GuildMember sans rôles ni date d'arrivée (PresenceUpdateAction), puis émet
 * guildMemberAvailable. Gardé en cache, il fausserait tout ce qui lit le cache d'abord : derank
 * Secur sans effet, whitelist par rôle ignorée, rôle soutien jamais retiré. Il est donc retiré du
 * cache tout de suite (avant presenceUpdate) : la lecture suivante relit le vrai membre par l'API.
 * Un membre complet (émis aussi par GuildMemberUpdate) n'est jamais touché.
 */
module.exports = {
  name: 'guildMemberAvailable',
  prepend: true,
  execute(_client, member) {
    if (member?.partial) member.guild?.members?.cache?.delete?.(member.id);
  },
};
