'use strict';

const http = require('node:http');
const { createLogger } = require('./logger');

const logger = createLogger('health');

/**
 * Serveur HTTP natif (sans dépendance) pour la supervision, activé par HEALTH_PORT :
 *  - `GET /healthz` → 200 `{ status, ready, ping, guilds, uptime, db }` si le client
 *    Discord est prêt ET la base répond à `SELECT 1`, 503 sinon ;
 *  - `GET /metrics` → métriques au format texte Prometheus.
 * Aucune donnée de serveur Discord (noms, IDs) n'est exposée.
 */

/** La base répond-elle ? `ok` | `closed` | `error`. */
function dbStatus(client) {
  const manager = client.database;
  if (!manager?.db) return 'closed';
  try {
    manager.db.prepare('SELECT 1').get();
    return 'ok';
  } catch {
    return 'error';
  }
}

function isReady(client) {
  try {
    return typeof client.isReady === 'function' ? Boolean(client.isReady()) : false;
  } catch {
    return false;
  }
}

/** Instantané de santé. Pur vis-à-vis du client (testé). */
function snapshot(client) {
  const ready = isReady(client);
  const db = dbStatus(client);
  const ping = Number.isFinite(client.ws?.ping) ? Math.round(client.ws.ping) : -1;
  const uptimeMs = Number(client.uptime) || 0;
  return {
    status: ready && db === 'ok' ? 'ok' : 'unavailable',
    ready,
    ping,
    guilds: client.guilds?.cache?.size ?? 0,
    uptime: Math.floor(uptimeMs / 1000),
    db,
  };
}

/** Métriques au format d'exposition texte Prometheus 0.0.4. */
function renderMetrics(client) {
  const snap = snapshot(client);
  const mem = process.memoryUsage();
  const metrics = [
    ['gadget_up', 'gauge', 'Le processus du bot répond (toujours 1).', 1],
    ['gadget_ready', 'gauge', 'Client Discord connecté et prêt (1/0).', snap.ready ? 1 : 0],
    ['gadget_db_up', 'gauge', 'La base SQLite répond à SELECT 1 (1/0).', snap.db === 'ok' ? 1 : 0],
    ['gadget_guilds', 'gauge', 'Nombre de serveurs Discord.', snap.guilds],
    ['gadget_ws_ping_milliseconds', 'gauge', 'Latence de la passerelle Discord (-1 si inconnue).', snap.ping],
    ['gadget_uptime_seconds', 'gauge', 'Durée de fonctionnement du bot.', snap.uptime],
    ['gadget_commands_loaded', 'gauge', 'Commandes slash chargées.', client.commands?.size ?? 0],
    ['gadget_commands_run_total', 'counter', 'Commandes slash exécutées avec succès depuis le démarrage.', Number(client.stats?.commandsRun) || 0],
    ['gadget_errors_total', 'counter', "Erreurs d'interaction depuis le démarrage.", Number(client.stats?.errors) || 0],
    ['process_resident_memory_bytes', 'gauge', 'Mémoire résidente du processus.', mem.rss],
    ['nodejs_heap_used_bytes', 'gauge', 'Tas V8 utilisé.', mem.heapUsed],
    ['nodejs_heap_total_bytes', 'gauge', 'Tas V8 alloué.', mem.heapTotal],
  ];
  return `${metrics.map(([name, type, help, value]) => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`).join('\n')}\n`;
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

/** Gestionnaire de requêtes (exporté pour les tests). */
function handler(client) {
  return (req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, JSON.stringify({ error: 'method_not_allowed' }), 'application/json; charset=utf-8');
    }
    try {
      if (pathname === '/healthz') {
        const snap = snapshot(client);
        return send(res, snap.status === 'ok' ? 200 : 503, JSON.stringify(snap), 'application/json; charset=utf-8');
      }
      if (pathname === '/metrics') {
        return send(res, 200, renderMetrics(client), 'text/plain; version=0.0.4; charset=utf-8');
      }
      return send(res, 404, JSON.stringify({ error: 'not_found' }), 'application/json; charset=utf-8');
    } catch (err) {
      logger.warn('Requête de supervision en échec :', err);
      return send(res, 500, JSON.stringify({ error: 'internal' }), 'application/json; charset=utf-8');
    }
  };
}

/**
 * Démarre le serveur. Résout avec `{ server, port, close() }`. Une erreur d'écoute
 * (port occupé…) rejette : l'appelant décide (le bot la journalise et continue).
 * @param {import('discord.js').Client} client
 * @param {{ port: number, host?: string }} opts
 */
function startHealthServer(client, { port, host = '127.0.0.1' }) {
  const server = http.createServer(handler(client));
  // Requêtes de supervision : courtes, jamais de connexion qui traîne.
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      server.on('error', (err) => logger.warn('Serveur de supervision :', err));
      const actual = server.address().port;
      let closing = null;
      const close = () => {
        if (!closing) {
          closing = new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          });
        }
        return closing;
      };
      resolve({ server, port: actual, close });
    });
  });
}

module.exports = { startHealthServer, snapshot, renderMetrics, handler };
