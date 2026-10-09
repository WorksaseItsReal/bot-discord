'use strict';

/**
 * Harnais de bout en bout : fait tourner le VRAI bot (GadgetClient, bootstrap,
 * événements, commandes) sur le VRAI code discord.js, sans réseau.
 *
 *  - REST : `client.rest.request` est remplacé par un faux Discord (lib/fakeDiscord.js)
 *    qui enregistre chaque requête, valide les corps contre les limites Discord et
 *    renvoie des objets plausibles (ou des erreurs injectées) ;
 *  - passerelle : une vraie WebSocketShard (statut Ready) dont `send` est intercepté ;
 *    les paquets (INTERACTION_CREATE, MESSAGE_CREATE…) passent par les handlers réels
 *    de discord.js (`client.ws.handlePacket`) ;
 *  - serveur : injecté via `client.guilds._add(payloadBrut)` (lib/fixtures.js).
 *
 * Critères d'échec relevés par `problems()` : log `error` du bot, rejet non géré,
 * avertissement de dépréciation, interaction jamais acquittée (ou après 3 s),
 * violation de limite / appel refusé par Discord, texte suspect (« undefined »…),
 * mention de masse effective (@everyone/@here ou rôle que allowed_mentions laisserait notifier).
 *
 * Utilisation : `const h = await createHarness(); h.configureAll();`
 *   `await h.slash('ban', [{ name: 'membre', type: 6, value: IDS.users.target }])`,
 *   `await h.click(message, customId, { as: 'member', values })`, `await h.submitModal(rec)`,
 *   `await h.contextMenu('Signaler le message', message)` (menus contextuels), `await h.userMessage({ as, channel, content })`, `await h.voice(as, salon)`…
 *   puis `assert.equal(h.problemCount(), 0, h.formatProblems())` et `await h.close()`.
 * Exploration automatique des composants : lib/explore.js.
 */

const { IDS, buildGuild, rawUser, rawMember } = require('./lib/fixtures');

// Configuration du bot AVANT son chargement (lue à l'import de src/config).
process.env.DATABASE_PATH = ':memory:';
process.env.LOG_FORMAT = 'json';
process.env.LOG_LEVEL = 'debug';
process.env.OWNER_IDS = IDS.users.botOwner;
process.env.CLIENT_ID = IDS.users.bot;
delete process.env.HEALTH_PORT;
delete process.env.DB_BACKUP_INTERVAL_HOURS;

const { ClientUser, ClientApplication, WebSocketShard, Status, PermissionsBitField } = require('discord.js');
const { GadgetClient } = require('../../src/core/GadgetClient');
const { FakeDiscord, EPHEMERAL } = require('./lib/fakeDiscord');
const { nextId, snowflakeAt, DAY } = require('./lib/ids');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

/** Capture des logs JSON du bot (console.log / console.error). */
function captureConsole(sink, verbose) {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const handle = (stream) => (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : require('node:util').inspect(a))).join(' ');
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = { level: stream === 'log' ? 'info' : 'warn', scope: 'console', msg: line };
    }
    sink.push(entry);
    if (verbose && (entry.level === 'error' || entry.level === 'warn' || verbose === 'all')) original.error(`[bot ${entry.level}] ${entry.scope}: ${entry.msg}${entry.err ? ` — ${entry.err.stack ?? entry.err.message}` : ''}`);
  };
  console.log = handle('log');
  console.error = handle('error');
  console.warn = handle('warn');
  return () => Object.assign(console, original);
}

/**
 * Crée un harnais prêt : bot amorcé, serveur injecté, `clientReady` émis.
 * @param {{ botAdministrator?: boolean, big?: boolean, restrictBot?: boolean, ready?: boolean, verbose?: boolean|'all' }} [opts]
 *   big : gros serveur (rôles, salons, membres, noms longs) · restrictBot : le bot ne peut
 *   ni écrire dans #général ni voir #logs · verbose (ou E2E_VERBOSE=1|all) : affiche les logs.
 */
async function createHarness(opts = {}) {
  const verbose = opts.verbose ?? (process.env.E2E_VERBOSE ? (process.env.E2E_VERBOSE === 'all' ? 'all' : true) : false);
  const logs = [];
  const restoreConsole = captureConsole(logs, verbose);
  const warnings = [];
  const unhandled = [];
  const onWarning = (w) => warnings.push({ name: w.name, message: w.message, stack: w.stack });
  const onRejection = (err) => unhandled.push({ kind: 'unhandledRejection', err });
  const onException = (err) => unhandled.push({ kind: 'uncaughtException', err });
  process.on('warning', onWarning);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  const { guild: rawGuild, users } = buildGuild({ botAdministrator: opts.botAdministrator ?? true, big: opts.big ?? false, restrictBot: opts.restrictBot ?? false });

  const client = new GadgetClient();
  client.bootstrap();

  // Utilisateur et application du bot, comme le ferait le paquet READY.
  client.user = new ClientUser(client, users.bot);
  client.users.cache.set(client.user.id, client.user);
  client.application = new ClientApplication(client, { id: users.bot.id, name: users.bot.username, flags: 0, bot_public: true });

  // Faux Discord branché sur le REST réel de discord.js.
  const fake = new FakeDiscord({ client, guild: rawGuild, users, botUser: users.bot });
  client.rest.request = (options) => fake.request(options);

  // Passerelle : vraie WebSocketShard « Ready », envoi intercepté.
  const shard = new WebSocketShard(client.ws, 0);
  shard.status = Status.Ready;
  shard.ping = 42;
  client.ws.shards.set(0, shard);
  client.ws._ws = {
    send: (_shardId, packet) => gatewaySend(packet),
    destroy: async () => {},
    fetchShardCount: async () => 1,
  };
  client.ws.status = Status.Ready;
  client.readyTimestamp = Date.now();

  function gatewaySend(packet) {
    if (packet?.op === 8) {
      // REQUEST_GUILD_MEMBERS → GUILD_MEMBERS_CHUNK
      const members = fake.membersForRequest(packet.d);
      setImmediate(() => fake.dispatchNow('GUILD_MEMBERS_CHUNK', { guild_id: packet.d.guild_id, members, chunk_index: 0, chunk_count: 1, not_found: [], nonce: packet.d.nonce }));
    }
  }

  // Serveur injecté via les structures réelles (sans émettre guildCreate).
  const guild = client.guilds._add(JSON.parse(JSON.stringify(rawGuild)));

  // Suivi des promesses des écouteurs (pour attendre la fin d'un traitement).
  const pending = new Set();
  const track = (value) => {
    if (value && typeof value.then === 'function') {
      pending.add(value);
      value.finally(() => pending.delete(value)).catch(() => {});
    }
    return value;
  };
  for (const name of client.eventNames()) {
    for (const raw of client.rawListeners(name)) {
      const listener = raw.listener ?? raw;
      const once = raw.listener !== undefined;
      client.off(name, raw);
      const wrapped = (...args) => track(listener(...args));
      if (once) client.once(name, wrapped);
      else client.on(name, wrapped);
    }
  }

  // Réseau sortant coupé : un téléchargement du bot (image d'emoji…) passe par `h.fetch`,
  // qui refuse par défaut ; un test le remplace pour simuler une réponse.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => h.fetch(...args);

  // Objets Interaction discord.js créés, par identifiant.
  const interactionObjects = new Map();
  client.prependListener('interactionCreate', (i) => interactionObjects.set(i.id, i));

  const h = {
    client,
    guild,
    fake,
    IDS,
    users,
    logs,
    warnings,
    unhandled,
    pending,
    interactionObjects,
    /** Interactions envoyées : { rec, label } */
    sent: [],
    /** Requêtes réseau du bot (fetch) : { url, init }. */
    fetches: [],
    /** `fetch` vu par le bot : refuse tout par défaut (aucun accès réseau pendant les tests). */
    async fetch(url, init) {
      h.fetches.push({ url: String(url), init });
      throw new TypeError(`fetch failed (réseau coupé dans les tests : ${String(url).slice(0, 80)})`);
    },

    /* ---------------------------------------------------------------- */
    /* Synchronisation                                                   */
    /* ---------------------------------------------------------------- */

    /**
     * Attend que le bot ait fini de réagir : plus aucune requête ni événement en
     * vol, et (si `rec`) l'interaction acquittée. Plafonné à `timeout` ms.
     */
    async settle({ rec = null, timeout = 3_000 + fake.latency * 4 } = {}) {
      const start = Date.now();
      let last = -1;
      let stable = 0;
      let quiet = false;
      while (Date.now() - start < timeout) {
        await tick();
        const now = fake.calls.length;
        if (now === last && fake.pendingDispatch === 0 && fake.inflight === 0) stable += 1;
        else stable = 0;
        last = now;
        if (stable >= 4) {
          if (rec && rec.ackType != null) return;
          if (pending.size === 0 || (!rec && stable >= 12)) {
            // Confirmation après une courte attente : un minuteur court (setTimeout 0)
            // du bot peut encore relancer du travail.
            if (quiet) return;
            quiet = true;
            await sleep(3);
            continue;
          }
          await sleep(5); // un minuteur du bot (attente volontaire) peut être en cours
        } else if (fake.inflight) {
          await sleep(1);
        }
      }
    },

    /** Attend qu'une condition devienne vraie (travail différé du bot), au plus `timeout` ms. */
    async waitFor(predicate, { timeout = 1_500 } = {}) {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeout) return false;
        await sleep(5);
      }
      await this.settle();
      return true;
    },

    /* ---------------------------------------------------------------- */
    /* Construction des interactions                                      */
    /* ---------------------------------------------------------------- */

    member(as) {
      const userId = IDS.users[as] ?? as;
      return guild.members.cache.get(userId);
    },

    channelId(name) {
      return IDS.channels[name] ?? name;
    },

    /** Permissions calculées (chaîne) d'un membre dans un salon, via discord.js. */
    permissionsIn(userId, channelId) {
      const ch = client.channels.cache.get(channelId);
      const m = guild.members.cache.get(userId);
      if (!m) return '0';
      const perms = ch?.permissionsFor?.(m) ?? m.permissions;
      return (perms ?? new PermissionsBitField(0n)).bitfield.toString();
    },

    rawMemberFor(userId, channelId) {
      const m = fake.members.get(userId);
      if (!m) return null;
      return { ...JSON.parse(JSON.stringify(m)), permissions: this.permissionsIn(userId, channelId) };
    },

    rawChannelFor(channelId, forUserId) {
      const ch = fake.channels.get(channelId) ?? fake.dms.get(channelId);
      if (!ch) return { id: channelId, type: 0 };
      return { ...JSON.parse(JSON.stringify(ch)), permissions: this.permissionsIn(forUserId, channelId) };
    },

    /** Données « resolved » pour des identifiants référencés. */
    resolvedFor(refs, channelId) {
      const resolved = {};
      const put = (key, id, value) => {
        resolved[key] ??= {};
        resolved[key][id] = value;
      };
      for (const { type, id } of refs) {
        if (type === 'user') {
          const u = fake.users.get(id);
          if (!u) continue;
          put('users', id, u);
          const m = fake.channels.has(channelId) && fake.members.get(id);
          if (m) {
            const { user: _u, ...rest } = this.rawMemberFor(id, channelId);
            put('members', id, rest);
          }
        } else if (type === 'role') {
          const r = fake.roles.get(id);
          if (r) put('roles', id, r);
        } else if (type === 'channel') {
          const c = fake.channels.get(id);
          if (c) put('channels', id, { id: c.id, name: c.name, type: c.type, parent_id: c.parent_id ?? null, permissions: this.permissionsIn(client.user.id, id), ...(c.thread_metadata ? { thread_metadata: c.thread_metadata } : {}) });
        } else if (type === 'attachment') {
          put('attachments', id, { id, filename: 'image.png', size: 1024, url: `https://cdn.discordapp.com/attachments/1/${id}/image.png`, proxy_url: `https://media.discordapp.net/attachments/1/${id}/image.png`, content_type: 'image/png', width: 64, height: 64, ephemeral: true });
        }
      }
      return resolved;
    },

    baseInteraction(type, { as = 'admin', channel = 'general', data, message } = {}) {
      const userId = IDS.users[as] ?? as;
      const channelId = channel === 'dm' ? this.dmChannel(as).id : this.channelId(channel);
      const inGuild = fake.channels.has(channelId);
      const raw = {
        id: nextId(),
        application_id: client.user.id,
        type,
        token: `tok-${nextId()}-${Math.random().toString(36).slice(2)}`,
        version: 1,
        locale: 'fr',
        channel_id: channelId,
        channel: this.rawChannelFor(channelId, userId),
        app_permissions: inGuild ? this.permissionsIn(client.user.id, channelId) : '0',
        entitlements: [],
        authorizing_integration_owners: { 0: inGuild ? guild.id : undefined },
        context: inGuild ? 0 : 1,
        attachment_size_limit: 10 * 1024 * 1024,
        data,
      };
      if (inGuild) {
        raw.guild_id = guild.id;
        raw.guild_locale = 'fr';
        raw.guild = { id: guild.id, locale: 'fr', features: rawGuild.features };
        raw.member = this.rawMemberFor(userId, channelId);
      } else {
        raw.user = fake.users.get(userId);
      }
      if (message) raw.message = JSON.parse(JSON.stringify(message));
      return raw;
    },

    /** Envoie un paquet INTERACTION_CREATE par le chemin réel de discord.js. */
    async dispatchInteraction(raw, label, extra = {}) {
      const rec = fake.registerInteraction(raw, { label, ...extra });
      this.sent.push(rec);
      fake.dispatchNow('INTERACTION_CREATE', raw, label);
      rec.interaction = interactionObjects.get(raw.id) ?? null;
      await this.settle({ rec });
      // Composant sans gestionnaire (collector terminé ou réservé à un autre membre) :
      // le routeur répond « bouton expiré » après 2,5 s, au-delà de la fenêtre de settle.
      if (rec.ackType == null && raw.type === 3 && !client.componentHandler?.resolve(raw.data.custom_id)) {
        await this.waitFor(() => rec.ackType != null, { timeout: 3_000 });
      }
      return rec;
    },

    /**
     * Commande slash.
     * @param {string} name
     * @param {object[]} options options au format API ({ name, type, value, options })
     * @param {{ as?: string, channel?: string, label?: string }} [ctx]
     */
    async slash(name, options = [], ctx = {}) {
      // Les cooldowns du bot (2 s par commande) ralentiraient les scénarios : levés sauf demande.
      if (!ctx.keepCooldowns) client.cooldowns.expiries.clear();
      const command = client.commands.get(name);
      // Menu contextuel (clic droit → Applications) : même pipeline, cible au lieu d'options.
      const type = command?.data?.type;
      if (type === 2 || type === 3) return this.contextMenu(name, ctx.target, ctx);
      const refs = collectRefs(options);
      const channelId = ctx.channel === 'dm' ? this.dmChannel(ctx.as ?? 'admin').id : this.channelId(ctx.channel ?? 'general');
      const data = {
        id: snowflakeAt(Date.parse('2024-01-01'), name.length),
        name,
        type: 1,
        ...(fake.channels.has(channelId) ? { guild_id: guild.id } : {}),
        options,
        resolved: this.resolvedFor(refs, channelId),
      };
      if (!Object.keys(data.resolved).length) delete data.resolved;
      if (!command) data.id = nextId();
      const raw = this.baseInteraction(2, { ...ctx, data });
      return this.dispatchInteraction(raw, ctx.label ?? `/${name}${describeOptions(options)}`);
    },

    /**
     * Menu contextuel (type 2 : utilisateur, type 3 : message).
     * @param {string} name nom du menu (« Signaler le message »)
     * @param {string|object} [target] utilisateur (clé d'IDS.users ou identifiant) ou message
     *   (brut ou identifiant) ; par défaut : le membre « target », ou un nouveau message de lui
     * @param {{ as?: string, channel?: string, label?: string }} [ctx]
     */
    async contextMenu(name, target, ctx = {}) {
      if (!ctx.keepCooldowns) client.cooldowns.expiries.clear();
      const command = client.commands.get(name);
      const type = command?.data?.type ?? 2;
      const channelId = this.channelId(ctx.channel ?? 'general');
      const data = { id: snowflakeAt(Date.parse('2024-01-01'), name.length), name, type, guild_id: guild.id };
      if (type === 3) {
        const message = typeof target === 'object' && target
          ? target
          : (target && fake.messages.get(target)) ?? fake.buildMessage({ channelId, body: { content: 'Message de test à signaler' }, author: fake.users.get(IDS.users.target) });
        data.target_id = message.id;
        data.resolved = { messages: { [message.id]: JSON.parse(JSON.stringify(message)) } };
        ctx = { ...ctx, channel: message.channel_id };
      } else {
        const userId = IDS.users[target] ?? target ?? IDS.users.target;
        data.target_id = userId;
        data.resolved = this.resolvedFor([{ type: 'user', id: userId }], channelId);
      }
      const raw = this.baseInteraction(2, { ...ctx, data });
      return this.dispatchInteraction(raw, ctx.label ?? `menu « ${name} »`);
    },

    /** Autocomplétion (option `focused: true` dans `options`). */
    async autocomplete(name, options = [], ctx = {}) {
      const data = { id: snowflakeAt(Date.parse('2024-01-01'), name.length), name, type: 1, guild_id: guild.id, options };
      const raw = this.baseInteraction(4, { ...ctx, data });
      return this.dispatchInteraction(raw, ctx.label ?? `autocomplete /${name}`);
    },

    /** Messages (bruts) produits par une interaction : réponse, suivis, message mis à jour. */
    messagesOf(rec) {
      return [...new Set([...(rec?.messages ?? []), ...(rec?.followUps ?? [])])].map((id) => fake.messages.get(id)).filter(Boolean);
    },

    /** Texte de la réponse d'une interaction (titres et descriptions des embeds). */
    replyText(rec) {
      return this.messagesOf(rec)
        .flatMap((m) => [m.content, ...(m.embeds ?? []).flatMap((e) => [e.title, e.description])])
        .filter(Boolean)
        .join('\n');
    },

    /** Vrai si la réponse est une carte d'erreur du bot (❌). */
    isError(rec) {
      return this.messagesOf(rec).some((m) => (m.embeds?.[0]?.description ?? '').startsWith('❌'));
    },

    /**
     * Clique « Confirmer » (ou « Annuler ») sur la demande de confirmation ouverte par
     * une interaction (utils/confirmation.js). Renvoie l'interaction du clic, ou null.
     */
    async confirm(rec, { cancel = false } = {}) {
      const prefix = cancel ? 'cancel:' : 'confirm:';
      for (const m of this.messagesOf(rec)) {
        const button = (m.components ?? []).flatMap((r) => r.components ?? []).find((c) => c.custom_id?.startsWith(prefix));
        if (button) return this.click(m, button.custom_id, { as: rec.raw.member?.user?.id ?? rec.raw.user?.id });
      }
      return null;
    },

    /** Message stocké par le faux Discord. */
    message(id) {
      return fake.messages.get(id) ?? null;
    },

    /** Composant (brut) d'un message, par customId. */
    findComponent(message, customId) {
      for (const row of message?.components ?? []) {
        for (const c of row.components ?? []) if (c.custom_id === customId) return c;
      }
      return null;
    },

    /**
     * Clique un bouton ou choisit des valeurs dans un menu d'un message.
     * @param {object|string} messageOrId message brut ou identifiant
     * @param {string} customId
     * @param {{ as?: string, values?: string[], label?: string }} [ctx]
     */
    async click(messageOrId, customId, ctx = {}) {
      const message = typeof messageOrId === 'string' ? this.message(messageOrId) : messageOrId;
      if (!message) throw new Error(`click : message introuvable (${messageOrId})`);
      const comp = this.findComponent(message, customId);
      const componentType = comp?.type ?? ctx.componentType ?? 2;
      const data = { custom_id: customId, component_type: componentType };
      if (componentType !== 2) {
        data.values = ctx.values ?? [];
        const refType = { 5: 'user', 6: 'role', 7: null, 8: 'channel' }[componentType];
        if (refType !== undefined) {
          const refs = data.values.map((id) => ({ type: refType ?? (fake.roles.has(id) ? 'role' : 'user'), id }));
          data.resolved = this.resolvedFor(refs, message.channel_id);
        }
      }
      const raw = this.baseInteraction(3, { ...ctx, channel: message.channel_id, data, message });
      return this.dispatchInteraction(raw, ctx.label ?? `clic ${customId}${data.values?.length ? ` = ${data.values.join(',')}` : ''}`);
    },

    /**
     * Soumet un formulaire ouvert par une interaction (`rec.modals`).
     * @param {object} rec interaction ayant ouvert le formulaire
     * @param {Record<string, string|string[]>} [values] valeurs par custom_id (sinon générées)
     */
    async submitModal(rec, values = {}, ctx = {}) {
      const modal = rec.modals[rec.modals.length - 1];
      if (!modal) throw new Error('submitModal : aucun formulaire ouvert');
      const components = modal.components.map((row) => {
        if (row.type === 1) {
          const input = row.components[0];
          return { type: 1, components: [{ type: 4, id: input.id, custom_id: input.custom_id, value: String(values[input.custom_id] ?? generateTextValue(input, input.label)) }] };
        }
        if (row.type === 18) {
          const c = row.component;
          if (c.type === 4) return { type: 18, id: row.id, component: { type: 4, id: c.id, custom_id: c.custom_id, value: String(values[c.custom_id] ?? generateTextValue(c, row.label)) } };
          const vals = values[c.custom_id] ?? defaultSelectValues(c, this);
          return { type: 18, id: row.id, component: { type: c.type, id: c.id, custom_id: c.custom_id, values: vals } };
        }
        return { type: row.type, id: row.id };
      });
      const data = { custom_id: modal.custom_id, components };
      const refs = [];
      for (const row of components) {
        const c = row.component;
        if (c?.values && [5, 6, 7, 8].includes(c.type)) for (const id of c.values) refs.push({ type: c.type === 6 ? 'role' : c.type === 8 ? 'channel' : fake.roles.has(id) ? 'role' : 'user', id });
      }
      if (refs.length) data.resolved = this.resolvedFor(refs, rec.channelId);
      const message = rec.componentMessageId ? this.message(rec.componentMessageId) : undefined;
      const as = ctx.as ?? rec.raw.member?.user?.id ?? rec.raw.user?.id;
      const raw = this.baseInteraction(5, { as, channel: rec.channelId, data, message });
      return this.dispatchInteraction(raw, ctx.label ?? `formulaire ${modal.custom_id}`, { fromModal: modal });
    },

    /* ---------------------------------------------------------------- */
    /* Événements de passerelle                                           */
    /* ---------------------------------------------------------------- */

    /** Nouvel utilisateur (compte créé il y a `ageDays` jours). */
    addUser(name, { ageDays = 400, bot = false } = {}) {
      const id = snowflakeAt(Date.now() - ageDays * DAY);
      const user = rawUser('member', name, { id, bot, username: name.toLowerCase().replace(/[^a-z0-9_.]/g, '') || `u${id.slice(-4)}` });
      fake.users.set(id, user);
      return user;
    },

    async memberJoin(user, { label } = {}) {
      const m = rawMember(user, [], 0);
      fake.members.set(user.id, m);
      fake.label = label ?? `arrivée ${user.username}`;
      fake.dispatchNow('GUILD_MEMBER_ADD', { ...m, guild_id: guild.id });
      await this.settle();
      return m;
    },

    async memberLeave(userId, { label } = {}) {
      const m = fake.members.get(userId);
      fake.members.delete(userId);
      fake.label = label ?? `départ ${userId}`;
      fake.dispatchNow('GUILD_MEMBER_REMOVE', { guild_id: guild.id, user: m?.user ?? fake.users.get(userId) });
      await this.settle();
    },

    /** Salon de messages privés entre un utilisateur et le bot (créé au besoin). */
    dmChannel(as) {
      const userId = IDS.users[as] ?? as;
      let dm = [...fake.dms.values()].find((d) => d.recipients[0].id === userId);
      if (!dm) {
        dm = { id: nextId(), type: 1, recipients: [fake.users.get(userId)], last_message_id: null, flags: 0 };
        fake.dms.set(dm.id, dm);
      }
      return dm;
    },

    /** Message d'un utilisateur (MESSAGE_CREATE) ; `channel: 'dm'` pour un message privé. */
    async userMessage({ as = 'member', channel = 'general', content = '', label, extra = {} } = {}) {
      const userId = IDS.users[as] ?? as;
      const channelId = channel === 'dm' ? this.dmChannel(as).id : this.channelId(channel);
      const author = fake.users.get(userId);
      // Mentions résolues comme le fait Discord (utilisateurs, rôles, @everyone).
      const mentions = [...content.matchAll(/<@!?(\d{17,20})>/g)].map((m) => fake.users.get(m[1])).filter(Boolean)
        .map((u) => ({ ...u, ...(fake.members.has(u.id) && channel !== 'dm' ? { member: { ...fake.members.get(u.id), user: undefined } } : {}) }));
      const mentionRoles = [...content.matchAll(/<@&(\d{17,20})>/g)].map((m) => m[1]).filter((id) => fake.roles.has(id));
      extra = { mentions, mention_roles: mentionRoles, mention_everyone: /@(everyone|here)/.test(content), ...extra };
      const msg = fake.buildMessage({ channelId, body: { content }, author, extra });
      const member = fake.members.get(userId);
      fake.label = label ?? `message ${as} : ${content.slice(0, 30)}`;
      const channelType = (fake.channels.get(channelId) ?? fake.dms.get(channelId))?.type;
      fake.dispatchNow('MESSAGE_CREATE', { ...msg, channel_type: channelType, ...(member && msg.guild_id ? { member: { ...member, user: undefined } } : {}) });
      await this.settle();
      return msg;
    },

    async editUserMessage(id, content, { label } = {}) {
      const msg = fake.messages.get(id);
      msg.content = content;
      msg.edited_timestamp = new Date().toISOString();
      fake.label = label ?? `édition ${id}`;
      fake.dispatchNow('MESSAGE_UPDATE', { ...msg });
      await this.settle();
      return msg;
    },

    async deleteUserMessage(id, { label } = {}) {
      const msg = fake.messages.get(id);
      fake.messages.delete(id);
      fake.label = label ?? `suppression ${id}`;
      fake.dispatchNow('MESSAGE_DELETE', { id, channel_id: msg.channel_id, guild_id: msg.guild_id });
      await this.settle();
    },

    /** Connexion / déplacement / déconnexion vocale (VOICE_STATE_UPDATE). */
    async voice(as, channel, { label } = {}) {
      const userId = IDS.users[as] ?? as;
      fake.label = label ?? `vocal ${as} → ${channel ?? 'déconnexion'}`;
      fake.setVoice(userId, channel ? this.channelId(channel) : null);
      await this.settle();
    },

    /** Entrée du journal d'audit (GUILD_AUDIT_LOG_ENTRY_CREATE) faite par un humain. */
    async auditEntry(entry, { label } = {}) {
      const full = { id: nextId(), changes: [], ...entry };
      fake.auditLog.unshift(full);
      fake.label = label ?? `audit ${entry.action_type}`;
      fake.dispatchNow('GUILD_AUDIT_LOG_ENTRY_CREATE', { ...full, guild_id: guild.id });
      await this.settle();
    },

    /** Modifie la configuration du serveur (ConfigService réel). */
    configure(patch) {
      client.services.config.update(guild.id, patch);
      return client.services.config.get(guild.id);
    },

    /** Configuration « tout activé » : logs, automod, antiraid, tickets, accueil, niveaux… */
    configureAll() {
      const logs = IDS.channels.logs;
      const filters = {};
      for (const key of Object.keys(client.services.config.get(guild.id).automod.filters)) filters[key] = { enabled: true };
      filters.badWords = { enabled: true, words: ['interdit'] };
      return this.configure({
        logChannels: Object.fromEntries(['moderation', 'messages', 'members', 'roles', 'channels', 'voice', 'security', 'automod', 'server'].map((k) => [k, logs])),
        logs: { ignoreBots: false },
        automod: { enabled: true, notify: 'channel', filters, newMembers: { enabled: true } },
        antiraid: { enabled: true, joinThreshold: 3, joinWindowSeconds: 10, minAccountAgeDays: 7, antiBot: true, alertChannel: logs, action: 'kick' },
        tickets: { categoryId: IDS.channels.catTickets, supportRoleId: IDS.roles.mod, supportRoleIds: [IDS.roles.mod], logChannel: logs },
        modmail: { enabled: true, categoryId: IDS.channels.catTickets, staffRoleId: IDS.roles.mod, logChannel: logs },
        suggestions: { channelId: IDS.channels.general },
        tempVoice: { enabled: true, hubChannelId: IDS.channels.hub, categoryId: IDS.channels.catVoice },
        welcome: {
          join: { enabled: true, channelId: IDS.channels.general, dm: true },
          leave: { enabled: true, channelId: IDS.channels.general },
          autoRoles: { humans: [IDS.roles.member], bots: [] },
        },
        levels: { enabled: true, cooldownSeconds: 0, minLength: 1, rewards: [{ level: 1, roleId: IDS.roles.notif }], voice: { enabled: true } },
      });
    },

    async emitReady() {
      fake.label = 'clientReady';
      client.emit('clientReady', client);
      await this.settle();
    },

    /* ---------------------------------------------------------------- */
    /* Bilan                                                             */
    /* ---------------------------------------------------------------- */

    /** Problèmes relevés depuis le dernier `resetProblems()`. */
    problems() {
      const errors = logs.filter((l) => l.level === 'error');
      const unacked = this.sent.filter((rec) => rec.ackType == null).map((rec) => rec.label);
      // Discord invalide une interaction non acquittée sous 3 s.
      const late = this.sent.filter((rec) => rec.ackType != null && rec.ackedAt - rec.createdAt > 3_000).map((rec) => `${rec.label} (${rec.ackedAt - rec.createdAt} ms)`);
      const deprecations = warnings.filter((w) => w.name === 'DeprecationWarning' || /deprecated/i.test(w.message));
      return {
        errors: errors.map((e) => `${e.scope}: ${e.msg}${e.err ? ` — ${e.err.message}\n${e.err.stack ?? ''}` : ''}`),
        unhandled: unhandled.map((u) => `${u.kind}: ${u.err?.stack ?? u.err}`),
        deprecations: deprecations.map((w) => `${w.message}\n${w.stack ?? ''}`),
        unacked,
        late,
        violations: fake.violations.map((v) => `[${v.label}] ${v.method} ${v.route} : ${v.problems.join(' ; ')}`),
        suspicious: fake.suspicious.map((v) => `[${v.label}] ${v.method} ${v.route} : ${v.problems.join(' ; ')}`),
        massMentions: fake.massMentions.map((v) => `[${v.label}] ${v.method} ${v.route} : ${v.problems.join(' ; ')}`),
      };
    },

    problemCount() {
      const p = this.problems();
      return Object.values(p).reduce((n, list) => n + list.length, 0);
    },

    /** Texte lisible des problèmes (message d'assertion). */
    formatProblems() {
      const p = this.problems();
      return Object.entries(p)
        .filter(([, list]) => list.length)
        .map(([k, list]) => `${k} (${list.length}) :\n  - ${list.join('\n  - ')}`)
        .join('\n');
    },

    resetProblems() {
      logs.length = 0;
      warnings.length = 0;
      unhandled.length = 0;
      fake.violations.length = 0;
      fake.suspicious.length = 0;
      fake.massMentions.length = 0;
      this.sent = [];
    },

    /** Avertissements du bot (non bloquants, utiles au diagnostic). */
    warnLogs() {
      return logs.filter((l) => l.level === 'warn').map((e) => `${e.scope}: ${e.msg}`);
    },

    async close() {
      await this.settle({ timeout: 500 });
      try {
        await client.shutdown();
      } catch {
        /* ignoré */
      }
      process.off('warning', onWarning);
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
      globalThis.fetch = realFetch;
      restoreConsole();
    },
  };

  if (opts.ready !== false) await h.emitReady();
  return h;
}

/* -------------------------------------------------------------------- */
/* Aides                                                                 */
/* -------------------------------------------------------------------- */

const OPTION_REF = { 6: 'user', 7: 'channel', 8: 'role', 11: 'attachment' };

function collectRefs(options, out = []) {
  for (const o of options ?? []) {
    if (o.options) collectRefs(o.options, out);
    if (OPTION_REF[o.type]) out.push({ type: OPTION_REF[o.type], id: o.value });
    if (o.type === 9) out.push({ type: o.mentionableType ?? 'user', id: o.value });
  }
  return out;
}

function describeOptions(options) {
  const parts = [];
  const walk = (list) => {
    for (const o of list ?? []) {
      if (o.type === 1 || o.type === 2) {
        parts.push(o.name);
        walk(o.options);
      } else parts.push(`${o.name}:${String(o.value).slice(0, 20)}`);
    }
  };
  walk(options);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** Valeur plausible pour un champ de formulaire (respecte min/max). */
function generateTextValue(input, label = '') {
  if (input.value != null && String(input.value).length) return input.value;
  const hint = `${input.custom_id} ${label ?? ''} ${input.placeholder ?? ''}`.toLowerCase();
  let v;
  if (/couleur|color|hex/.test(hint)) v = '#5865F2';
  else if (/url|lien|link|image|thumbnail|icon/.test(hint)) v = 'https://example.com/image.png';
  else if (/dur[ée]e|duration|délai|delai|temps|time|expire/.test(hint)) v = '10m';
  else if (/emoji/.test(hint)) v = '✅';
  else if (/nombre|count|seuil|max|min|limit|niveau|level|xp|threshold|jours|days|secondes|seconds|minutes|age|âge|position|quantit|%|pourcent|percent|taille|size|cooldown|messages|mentions|lignes|lines|caract/.test(hint)) v = '5';
  else if (/mots|words|domain|domaine|invit|liste|list/.test(hint)) v = 'exemple';
  else if (/json/.test(hint)) v = '{"title":"Test"}';
  else if (/regex|motif|pattern/.test(hint)) v = 'arnaque';
  else if (/id\b|identifiant/.test(hint)) v = IDS.users.target;
  else v = input.style === 2 ? 'Texte de test pour le formulaire.' : 'Test e2e';
  const min = input.min_length ?? 0;
  const max = input.max_length ?? 4000;
  if (v.length < min) v = v.padEnd(min, 'x');
  if (v.length > max) v = v.slice(0, max);
  return v;
}

/** Salon du serveur de test compatible avec des types de salons autorisés. */
function channelForTypes(types) {
  if (!types?.length || types.includes(0)) return IDS.channels.general;
  if (types.includes(2)) return IDS.channels.voice;
  if (types.includes(4)) return IDS.channels.catTickets;
  if (types.includes(5)) return IDS.channels.announcements;
  if (types.includes(15)) return IDS.channels.forum;
  return IDS.channels.general;
}

function defaultSelectValues(c) {
  const min = Math.max(1, c.min_values ?? 1);
  if (c.type === 3) return (c.options ?? []).slice(0, min).map((o) => o.value);
  if (c.type === 5 || c.type === 7) return [IDS.users.member];
  if (c.type === 6) return [IDS.roles.gamer];
  if (c.type === 8) return [channelForTypes(c.channel_types)];
  return [];
}

module.exports = { createHarness, generateTextValue, defaultSelectValues, channelForTypes, IDS, sleep, EPHEMERAL };
