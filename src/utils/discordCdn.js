'use strict';

const { safeFetch, FetchError } = require('./safeFetch');

/**
 * Téléchargement SÛR d'une pièce jointe hébergée par Discord (avatar ou bannière du bot,
 * fichier relayé par /embed texte, images restaurées par l'anti-nuke).
 *
 * Pourquoi : `editMe`, `setAvatar`, `guild.edit`… passent une CHAÎNE à `resolveImage` de
 * discord.js, qui lit un fichier LOCAL si ce n'est pas une URL (preuve resolveImage-lfi) et
 * télécharge sans limite une URL quelconque. On ne leur donne donc JAMAIS de chaîne : on
 * télécharge ici, puis on passe un Buffer.
 *
 * Garanties (en plus de celles de safeFetch : adresses privées refusées à la connexion, ports
 * 80/443/8080/8443, en-têtes bornés, décompression bornée) :
 *  - https uniquement, hôtes cdn.discordapp.com et media.discordapp.net uniquement, liste
 *    revalidée à CHAQUE redirection (option allowedHosts de safeFetch) ;
 *  - taille plafonnée (en-tête Content-Length ET flux), 8 Mo pour une image ; délai de 10 s ;
 *  - image : type vérifié par l'en-tête ET par la signature du fichier (PNG, JPEG, GIF, WebP) ;
 *  - interrupteur CDN_NETWORK=off (config.cdnNetwork) : refus clair, aucune requête.
 */

const DISCORD_CDN_HOSTS = Object.freeze(['cdn.discordapp.com', 'media.discordapp.net']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Plafond absolu d'un fichier relayé (au-delà, Discord refuserait l'envoi d'un bot de toute façon). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' });
const IMAGES_OFF = 'téléchargement d\'images désactivé sur cette instance (CDN_NETWORK=off)';
const FILES_OFF = 'téléchargement de fichiers désactivé sur cette instance (CDN_NETWORK=off)';

/**
 * Transport HTTP par défaut : safeFetch. Remplaçable (tests de bout en bout) ; chaque appel
 * peut aussi recevoir `http` en option.
 */
const transport = { http: safeFetch };

/** Format d'image d'après la signature (« nombres magiques »), ou null. Pur. */
function sniffImage(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : null;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  const head = b.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Type de contenu (sans paramètres, en minuscules) d'en-têtes `Headers` ou d'un objet. Pur. */
function contentTypeOf(headers) {
  const raw = typeof headers?.get === 'function' ? headers.get('content-type') : headers?.['content-type'];
  return String(raw ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * URL d'une pièce jointe de Discord : https, hôte du CDN, port par défaut, sans identifiants.
 * Lève une FetchError (message affichable). Pur.
 * @returns {URL}
 */
function assertDiscordCdnUrl(raw) {
  let url;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(String(raw ?? ''));
  } catch {
    throw new FetchError('adresse de fichier invalide', { blocked: true });
  }
  if (url.protocol !== 'https:') throw new FetchError('seules les adresses https du CDN de Discord sont acceptées', { blocked: true });
  if (url.username || url.password) throw new FetchError('une adresse avec identifiants n\'est pas acceptée', { blocked: true });
  if (url.port && url.port !== '443') throw new FetchError('port refusé pour le CDN de Discord', { blocked: true });
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!DISCORD_CDN_HOSTS.includes(host)) throw new FetchError('seuls les fichiers hébergés par Discord (pièces jointes) sont acceptés', { blocked: true });
  return url;
}

/** Interrupteur réseau : option explicite, sinon config.cdnNetwork (relu à chaque appel). */
function networkAllowed(explicit) {
  if (explicit !== undefined) return Boolean(explicit);
  return require('../config').config.cdnNetwork !== false;
}

const tooBig = (max) => new FetchError(`fichier trop volumineux (plus de ${Math.round(max / 1024 / 1024 * 10) / 10} Mo)`);

/**
 * Télécharge une pièce jointe du CDN de Discord.
 * @param {string|URL} rawUrl
 * @param {{ maxBytes?: number, timeoutMs?: number, http?: typeof safeFetch, networkEnabled?: boolean,
 *   signal?: AbortSignal, offMessage?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function fetchDiscordFile(rawUrl, opts = {}) {
  const { timeoutMs = TIMEOUT_MS, http = transport.http, signal, offMessage = FILES_OFF } = opts;
  if (!networkAllowed(opts.networkEnabled)) throw new FetchError(offMessage, { blocked: true });
  const cap = Math.max(1, Math.min(Number(opts.maxBytes) || MAX_FILE_BYTES, MAX_FILE_BYTES));
  const url = assertDiscordCdnUrl(rawUrl);
  const res = await http(url.toString(), {
    maxBytes: cap,
    timeoutMs: Math.min(timeoutMs, TIMEOUT_MS),
    maxRedirects: MAX_REDIRECTS,
    allowedHosts: DISCORD_CDN_HOSTS,
    httpsOnly: true,
    signal,
    headers: { accept: '*/*', 'user-agent': 'InspecteurGadget (discord bot)' },
  });
  if (!res?.ok) throw new FetchError(`le CDN de Discord a répondu ${res?.status ?? 'sans statut'}`);
  // Défense en profondeur (transport injecté) : URL finale, en-tête et taille réelle revérifiés.
  if (res.url) assertDiscordCdnUrl(res.url);
  const declared = Number(typeof res.headers?.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > cap) throw tooBig(cap);
  const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body ?? []);
  if (buffer.length > cap) throw tooBig(cap);
  if (!buffer.length) throw new FetchError('fichier vide');
  return { buffer, contentType: contentTypeOf(res.headers) };
}

/**
 * Télécharge une IMAGE du CDN de Discord (PNG, JPEG, GIF ou WebP, 8 Mo au plus) et renvoie
 * son Buffer, à passer tel quel à editMe / setAvatar / guild.edit.
 * @param {string|URL} rawUrl
 * @param {{ maxBytes?: number, timeoutMs?: number, http?: typeof safeFetch, networkEnabled?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<Buffer>}
 */
async function fetchDiscordImage(rawUrl, opts = {}) {
  const maxBytes = Math.min(Number(opts.maxBytes) || MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  const { buffer, contentType } = await fetchDiscordFile(rawUrl, { ...opts, maxBytes, offMessage: IMAGES_OFF });
  const declared = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
  if (!Object.values(IMAGE_TYPES).includes(declared)) throw new FetchError(`type de fichier refusé (${declared.slice(0, 40) || 'non indiqué'}) : PNG, JPEG, GIF ou WebP uniquement`);
  const kind = sniffImage(buffer);
  if (!kind) throw new FetchError('ce fichier n\'est pas une image PNG, JPEG, GIF ou WebP valide');
  if (IMAGE_TYPES[kind] !== declared) throw new FetchError('le type annoncé ne correspond pas au contenu du fichier');
  return buffer;
}

module.exports = {
  fetchDiscordImage,
  fetchDiscordFile,
  assertDiscordCdnUrl,
  sniffImage,
  contentTypeOf,
  transport,
  DISCORD_CDN_HOSTS,
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  TIMEOUT_MS,
  IMAGE_TYPES,
  IMAGES_OFF,
  FILES_OFF,
};
