'use strict';

/** Snowflakes Discord déterministes (l'horodatage encodé compte : âge des comptes, antiraid…). */
const EPOCH = 1420070400000n;
let increment = 0;

function snowflakeAt(timestamp, inc = increment++) {
  return String(((BigInt(Math.floor(timestamp)) - EPOCH) << 22n) | BigInt(inc & 0xfff));
}

/** Nouvel identifiant « maintenant » (messages, salons créés…). */
function nextId() {
  return snowflakeAt(Date.now());
}

const DAY = 86_400_000;

module.exports = { snowflakeAt, nextId, DAY };
