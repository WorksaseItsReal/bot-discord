'use strict';

/**
 * Revue n° 6, AntiRaid, bout en bout (vrai discord.js, faux Discord) : raid de comptes récents,
 * alertes perdues, whitelist, suppressions faites via le bot, auteur parti, journal des réglages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, IDS } = require('./harness');

const botMessages = (h, mark, pred = () => true) => h.fake.messageLog.slice(mark).map((id) => h.message(id)).filter((m) => m && m.author?.id === h.client.user.id && pred(m));
const titled = (re) => (m) => (m.embeds ?? []).some((e) => re.test(e.title ?? ''));
/** Cartes de l'AntiRaid liées aux arrivées (hors log « Nouveau membre » des logs Membres). */
const ALERTS = /Nouveau membre (banni|expulsé)|Vague d'arrivées|Raid en cours|Sanction automatique impossible/;

/** Raid de `n` comptes créés il y a quelques heures (préréglage « Strict », salon d'alerte distinct des logs). */
async function freshRaid(h, n) {
  for (let i = 0; i < n; i += 1) {
    const u = h.addUser(`Frais${i}`, { ageDays: 0.2 });
    h.fake.members.set(u.id, { user: u, roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0, pending: false });
    h.fake.dispatchNow('GUILD_MEMBER_ADD', { ...h.fake.members.get(u.id), guild_id: h.guild.id }, `raider ${i}`);
  }
  await h.settle({ timeout: 30_000 });
}

async function strictRaidHarness() {
  const h = await createHarness();
  h.configureAll();
  h.configure({ antiraid: { enabled: true, action: 'lockdown', joinThreshold: 6, joinWindowSeconds: 10, minAccountAgeDays: 7, antiBot: true, newAccountAction: 'ban', alertChannel: IDS.channels.staff } });
  return h;
}

test('R29 : raid de comptes récents bannis → vague détectée, lockdown, alertes regroupées', async () => {
  const h = await strictRaidHarness();
  try {
    const mark = h.fake.messageLog.length;
    await freshRaid(h, 40);
    const raiders = [...h.fake.members.values()].filter((m) => /^frais/.test(m.user?.username ?? ''));
    assert.equal(raiders.length, 0, 'raiders encore présents');
    const alerts = botMessages(h, mark, titled(ALERTS));
    assert.ok(alerts.length <= 12, `une alerte par arrivant : ${alerts.length} messages`);
    assert.ok(botMessages(h, mark, titled(/Vague d'arrivées détectée/)).length >= 1, 'vague jamais détectée');
    assert.ok(h.client.services.lockdown.status(h.guild) > 0, 'aucun lockdown');
    // Bannissements regroupés : annoncés dans l'alerte de vague ou dans la carte récapitulative de la minute.
    await h.client.services.antiraid.flushDigest(h.guild.id);
    await h.settle();
    // Comptées dans le salon d'alerte (chaque carte est aussi copiée dans les logs sécurité).
    const inAlerts = (m) => m.channel_id === IDS.channels.staff;
    const cards = botMessages(h, mark, titled(/Vague d'arrivées détectée|récapitulatif/)).filter(inAlerts);
    const grouped = cards.flatMap((m) => m.embeds[0].fields ?? []).filter((f) => /Comptes récents/.test(f.name))
      .reduce((n, f) => n + Number(/\*\*(\d+)\*\* banni/.exec(f.value)?.[1] ?? 0), 0);
    const single = botMessages(h, mark, titled(/Nouveau membre banni/)).filter(inAlerts).length;
    assert.equal(grouped + single, 40, `bannissements annoncés : ${single} un par un + ${grouped} regroupés`);
    assert.equal(h.problemCount(), 0, h.formatProblems());
  } finally {
    await h.close();
  }
});

test('R29 : raid de comptes récents dont le bannissement échoue → alerte d\'échec, vague et lockdown', async () => {
  const h = await strictRaidHarness();
  try {
    h.fake.inject({ method: 'PUT', route: /\/bans\// }, { status: 403, code: 50013, times: 10_000 });
    const mark = h.fake.messageLog.length;
    await freshRaid(h, 40);
    assert.ok(botMessages(h, mark, titled(/Sanction automatique impossible/)).length >= 1, 'échec silencieux');
    assert.ok(botMessages(h, mark, titled(/Vague d'arrivées détectée/)).length >= 1, 'vague jamais détectée');
    assert.ok(h.client.services.lockdown.status(h.guild) > 0, 'raiders présents sans lockdown');
    assert.ok(botMessages(h, mark, titled(ALERTS)).length <= 12, 'alertes non regroupées');
  } finally {
    await h.close();
  }
});
