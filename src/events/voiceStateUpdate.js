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

    let log = null;
    if (!oldState.channelId && newState.channelId) {
      log = { tone: 'success', title: 'Connexion vocale', description: `${user} a rejoint ${newState.channel}.`, fields: [field(ICONS.voice, 'Salon', `${newState.channel}`)] };
    } else if (oldState.channelId && !newState.channelId) {
      log = { tone: 'neutral', title: 'Déconnexion vocale', description: `${user} a quitté ${oldState.channel}.`, fields: [field(ICONS.voice, 'Salon', `${oldState.channel}`)] };
    } else if (oldState.channelId !== newState.channelId) {
      log = {
        tone: 'info',
        title: 'Changement de salon vocal',
        description: `${user} est passé de ${oldState.channel} à ${newState.channel}.`,
        fields: [field('⬅️', 'Avant', `${oldState.channel}`), field('➡️', 'Après', `${newState.channel}`)],
      };
    }
    if (!log) return;

    await client.services.logging.send(
      newState.guild.id,
      'voice',
      logCard({ category: 'voice', icon: ICONS.voice, user, ...log, fields: [field(ICONS.user, 'Membre', userLine(user)), ...log.fields] }),
    );
  },
};
