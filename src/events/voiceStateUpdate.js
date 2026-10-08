'use strict';

const { field, ICONS, userLine } = require('../utils/ui');
const { logCard } = require('../services/LoggingService');

module.exports = {
  name: 'voiceStateUpdate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, oldState, newState) {
    await client.services.tempVoice.handleVoiceUpdate(oldState, newState).catch(() => {});

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    const user = member.user;
    // Salon supprimé entre-temps (hors cache) : mention par identifiant plutôt que « null ».
    const before = oldState.channel ?? (oldState.channelId ? `<#${oldState.channelId}>` : '—');
    const after = newState.channel ?? (newState.channelId ? `<#${newState.channelId}>` : '—');

    let log = null;
    if (!oldState.channelId && newState.channelId) {
      log = { event: 'voiceJoin', tone: 'success', title: 'Connexion vocale', description: `${user} a rejoint ${after}.`, fields: [field(ICONS.voice, 'Salon', `${after}`)] };
    } else if (oldState.channelId && !newState.channelId) {
      log = { event: 'voiceLeave', tone: 'neutral', title: 'Déconnexion vocale', description: `${user} a quitté ${before}.`, fields: [field(ICONS.voice, 'Salon', `${before}`)] };
    } else if (oldState.channelId !== newState.channelId) {
      log = {
        event: 'voiceMove',
        tone: 'info',
        title: 'Changement de salon vocal',
        description: `${user} est passé de ${before} à ${after}.`,
        fields: [field('⬅️', 'Avant', `${before}`), field('➡️', 'Après', `${after}`)],
      };
    }
    if (!log) return;

    await client.services.logging.send(
      newState.guild.id,
      'voice',
      logCard({ category: 'voice', icon: ICONS.voice, user, tone: log.tone, title: log.title, description: log.description, fields: [field(ICONS.user, 'Membre', userLine(user)), ...log.fields] }), undefined, { event: log.event });
  },
};
