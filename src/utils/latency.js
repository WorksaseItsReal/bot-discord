'use strict';

/**
 * Latence WebSocket du bot en ms, ou -1 si elle est encore inconnue
 * (discord.js renvoie -1 ou NaN avant le premier heartbeat).
 * @param {import('discord.js').Client} client
 */
function wsLatency(client) {
  const ms = Math.round(client?.ws?.ping);
  return Number.isFinite(ms) && ms >= 0 ? ms : -1;
}

module.exports = { wsLatency };
