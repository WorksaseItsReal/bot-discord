'use strict';

const { embeds } = require('../utils/embeds');

module.exports = {
  name: 'voiceStateUpdate',
  /** @param {import('../core/GadgetClient').GadgetClient} client */
  async execute(client, oldState, newState) {
    await client.services.tempVoice.handleVoiceUpdate(oldState, newState).catch(() => {});

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;
    let action = null;
    if (!oldState.channelId && newState.channelId) action = `a rejoint ${newState.channel}`;
    else if (oldState.channelId && !newState.channelId) action = `a quitté ${oldState.channel}`;
    else if (oldState.channelId !== newState.channelId) action = `${oldState.channel} → ${newState.channel}`;
    if (!action) return;

    await client.services.logging.send(
      newState.guild.id,
      'voice',
      embeds.info(`${member.user} ${action}`, '🔊 Vocal'),
    );
  },
};
