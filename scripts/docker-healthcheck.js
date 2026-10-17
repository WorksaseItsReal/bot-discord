'use strict';

/**
 * Sonde HEALTHCHECK de l'image Docker (l'image slim n'a ni curl ni wget).
 * Interroge http://127.0.0.1:$HEALTH_PORT/healthz : code 0 si 200, 1 sinon.
 */
const http = require('node:http');

const port = Number(process.env.HEALTH_PORT || 8080);
const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 4_000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
