'use strict';

const { fitEmbeds } = require('./ui');

/**
 * Archive d'un transcript (ticket ou ModMail) dans le salon de transcripts, avec,
 * si `tickets.archiveAttachments` est activé, les pièces jointes re-téléversées.
 *
 * Bornes : 8 Mo par fichier, 24 Mo au total ; envois découpés pour respecter les
 * limites de Discord (10 fichiers et la limite d'envoi du serveur par message).
 * Toute pièce jointe non archivée (trop lourde, lien expiré, envoi refusé…) est
 * ignorée et listée, dans la carte d'archive et à la fin du fichier .txt.
 */

const MB = 1024 * 1024;
const ARCHIVE_FILE_MAX = 8 * MB;
const ARCHIVE_TOTAL_MAX = 24 * MB;
const FILES_PER_MESSAGE = 10;
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** Hôtes des fichiers de Discord : aucun autre téléchargement (pas de requête vers une URL arbitraire). */
const CDN_HOST = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/i;
/** Champ « 📎 Pièces jointes » des cartes relayées par le ModMail : liens markdown. */
const LINK_RE = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g;

/** Limite d'envoi par message selon le niveau de boost du serveur (octets). Pur. */
function uploadLimit(guild) {
  const tier = Number(guild?.premiumTier ?? 0);
  return tier >= 3 ? 100 * MB : tier >= 2 ? 50 * MB : 10 * MB;
}

/** Lien de fichier Discord en https ? Pur. */
function isDiscordCdn(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CDN_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** Nom de fichier sûr et unique dans l'archive (« 03-photo.png »). Pur. */
function archiveName(name, index) {
  const base = String(name || 'fichier')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80) || 'fichier';
  return `${String(index + 1).padStart(2, '0')}-${base}`;
}

/**
 * Pièces jointes d'un message : fichiers réels, puis liens du champ « Pièces jointes »
 * des cartes (messages privés relayés par le ModMail). Pur.
 * @returns {Array<{ name: string, url: string, size: number|null, messageId: string|null, author: string }>}
 */
function attachmentsOf(message) {
  const out = [];
  const author = message?.author?.tag ?? message?.author?.username ?? 'inconnu';
  for (const a of message?.attachments?.values?.() ?? []) {
    out.push({ name: a.name ?? 'fichier', url: a.url, size: Number.isFinite(a.size) ? a.size : null, messageId: message.id ?? null, author });
  }
  for (const e of message?.embeds ?? []) {
    const fields = e.fields ?? e.data?.fields ?? [];
    const footer = e.footer?.text ?? e.data?.footer?.text ?? '';
    const section = e.author?.name ?? e.data?.author?.name ?? '';
    for (const f of fields) {
      if (!/Pièces jointes/i.test(f.name ?? '')) continue;
      for (const m of String(f.value ?? '').matchAll(LINK_RE)) {
        out.push({ name: m[1], url: m[2], size: null, messageId: message.id ?? null, author: section.replace(/ a écrit$/, '') || footer || author });
      }
    }
  }
  return out;
}

/**
 * Télécharge les pièces jointes des messages, dans les bornes.
 * @param {object[]} messages messages du transcript (du plus ancien au plus récent)
 * @param {{ fetchImpl?: typeof fetch, fileMax?: number, totalMax?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ files: Array<{ attachment: Buffer, name: string, size: number, original: string, author: string }>,
 *   skipped: Array<{ name: string, reason: string }> }>}
 */
async function collectAttachments(messages, { fetchImpl = globalThis.fetch, fileMax = ARCHIVE_FILE_MAX, totalMax = ARCHIVE_TOTAL_MAX, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const files = [];
  const skipped = [];
  let total = 0;
  const seen = new Set();
  const megas = (n) => `${Math.round(n / MB)} Mo`;
  for (const att of (messages ?? []).flatMap(attachmentsOf)) {
    if (seen.has(att.url)) continue;
    seen.add(att.url);
    const skip = (reason) => skipped.push({ name: att.name, reason });
    if (!isDiscordCdn(att.url)) {
      skip('lien hors de Discord');
      continue;
    }
    if (att.size != null && att.size > fileMax) {
      skip(`plus de ${megas(fileMax)}`);
      continue;
    }
    if (att.size != null && total + att.size > totalMax) {
      skip(`limite totale de ${megas(totalMax)} atteinte`);
      continue;
    }
    try {
      const res = await fetchImpl(att.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`);
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > fileMax) {
        skip(`plus de ${megas(fileMax)}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > fileMax) {
        skip(`plus de ${megas(fileMax)}`);
        continue;
      }
      if (total + buffer.length > totalMax) {
        skip(`limite totale de ${megas(totalMax)} atteinte`);
        continue;
      }
      total += buffer.length;
      files.push({ attachment: buffer, name: archiveName(att.name, files.length), size: buffer.length, original: att.name, author: att.author });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      skip(timeout ? 'délai de téléchargement dépassé' : `téléchargement impossible (${String(err?.message ?? err).slice(0, 60)})`);
    }
  }
  return { files, skipped };
}

/**
 * Répartit les fichiers en envois : ≤ 10 fichiers et ≤ `maxBytes` par message ; le premier
 * envoi garde `reserved` place(s) et octets pour le transcript. Pur.
 * @returns {Array<Array<object>>} lots (le premier peut être vide)
 */
function batchFiles(files, { maxBytes = 10 * MB, reservedBytes = 0, reservedSlots = 1 } = {}) {
  const batches = [[]];
  let bytes = reservedBytes;
  let slots = reservedSlots;
  for (const f of files) {
    if (slots >= FILES_PER_MESSAGE || bytes + f.size > maxBytes) {
      batches.push([]);
      bytes = 0;
      slots = 0;
    }
    batches[batches.length - 1].push(f);
    bytes += f.size;
    slots += 1;
  }
  return batches;
}

/** Annexe du fichier .txt : pièces jointes archivées et ignorées. Pur. */
function appendix({ archived = [], skipped = [] }) {
  if (!archived.length && !skipped.length) return '';
  const lines = ['', '─'.repeat(60)];
  if (archived.length) {
    lines.push(`Pièces jointes archivées (${archived.length}) : jointes à ce message d'archive (ou aux suivants).`);
    for (const f of archived) lines.push(`- ${f.name} ← « ${f.original} » (${f.author})`);
  }
  if (skipped.length) {
    lines.push(`Pièces jointes non archivées (${skipped.length}) :`);
    for (const s of skipped) lines.push(`- « ${s.name} » : ${s.reason}`);
  }
  return lines.join('\n');
}

/**
 * Publie l'archive d'un transcript.
 * @param {import('discord.js').TextChannel} channel salon des transcripts
 * @param {{
 *   transcript: { name: string, content: string },
 *   messages?: object[],
 *   archiveAttachments?: boolean,
 *   card: (summary: { archived: number, skipped: Array<{ name: string, reason: string }> } | null) => object,
 *   continuation?: (part: number, total: number) => object,
 *   fetchImpl?: typeof fetch,
 *   guild?: import('discord.js').Guild,
 * }} opts
 * @returns {Promise<{ archived: number, skipped: Array<{ name: string, reason: string }> } | null>} résumé (null : option désactivée)
 */
async function sendTranscriptArchive(channel, { transcript, messages = [], archiveAttachments = false, card, continuation, fetchImpl, guild }) {
  const txt = (content) => ({ attachment: Buffer.from(content, 'utf8'), name: transcript.name });
  if (!archiveAttachments) {
    await channel.send({ embeds: fitEmbeds([card(null)]), files: [txt(transcript.content)] });
    return null;
  }
  const { files, skipped } = await collectAttachments(messages, { fetchImpl });
  const txtBytes = Buffer.byteLength(transcript.content, 'utf8') + 4096; // annexe comprise (marge)
  const batches = batchFiles(files, { maxBytes: uploadLimit(guild ?? channel.guild), reservedBytes: txtBytes, reservedSlots: 1 });
  let archived = files;
  const summary = () => ({ archived: archived.length, skipped });
  const content = () => transcript.content + appendix({ archived, skipped });

  let main;
  try {
    main = await channel.send({ embeds: fitEmbeds([card(summary())]), files: [txt(content()), ...batches[0]] });
  } catch (err) {
    if (!batches[0].length) throw err;
    // Envoi refusé avec les fichiers (taille, type…) : le transcript passe seul.
    for (const f of batches[0]) skipped.push({ name: f.original, reason: 'envoi refusé par Discord' });
    archived = archived.filter((f) => !batches[0].includes(f));
    main = await channel.send({ embeds: fitEmbeds([card(summary())]), files: [txt(content())] });
  }
  let changed = false;
  const rest = batches.slice(1);
  for (const [i, batch] of rest.entries()) {
    try {
      await channel.send({ embeds: fitEmbeds([continuation ? continuation(i + 2, rest.length + 1) : card(summary())]), files: batch });
    } catch {
      for (const f of batch) skipped.push({ name: f.original, reason: 'envoi refusé par Discord' });
      archived = archived.filter((f) => !batch.includes(f));
      changed = true;
    }
  }
  if (changed) await main?.edit?.({ embeds: fitEmbeds([card(summary())]) }).catch(() => {});
  return summary();
}

module.exports = {
  sendTranscriptArchive,
  collectAttachments,
  attachmentsOf,
  batchFiles,
  appendix,
  archiveName,
  isDiscordCdn,
  uploadLimit,
  ARCHIVE_FILE_MAX,
  ARCHIVE_TOTAL_MAX,
  FILES_PER_MESSAGE,
};
