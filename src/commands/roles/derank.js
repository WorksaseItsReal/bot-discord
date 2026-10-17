'use strict';

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { listOrMore, truncate } = require('../../utils/embeds');
const { card, field, wide, ICONS, userLine, status } = require('../../utils/ui');
const { assertCanModerate } = require('../../utils/permissions');
const { confirm } = require('../../utils/confirmation');
const { UserError } = require('../../core/errors');
const { isSensitiveRole } = require('../../utils/secur');

module.exports = {
  category: 'roles',
  data: new SlashCommandBuilder()
    .setName('derank')
    .setDescription('Retire tous les rôles d\'un membre.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption((o) => o.setName('membre').setDescription('Membre à qui retirer tous les rôles').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du derank (visible dans les logs)').setMaxLength(512)),

  async execute(interaction, client) {
    const user = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError('Membre introuvable.');
    assertCanModerate(interaction.member, member, interaction.guild.members.me, { action: 'dérank' });

    // Le rôle Muted n'est jamais retiré : un derank ne doit pas lever un mute. Le rôle de
    // vérification non plus : retiré, le « non vérifié » (mode retrait) donnerait l'accès
    // complet, et le « vérifié » (mode ajout) serait repris par « Me vérifier » avec les rôles
    // automatiques — le derank serait annulé par le membre lui-même.
    const mutedId = client?.services?.moderation?.mutedRole?.(interaction.guild)?.id ?? null;
    const verification = client?.services?.config?.get(interaction.guild.id)?.welcome?.verification;
    const verifyId = verification?.enabled ? verification.roleId ?? null : null;
    const roles = member.roles.cache.filter((r) => r.id !== interaction.guild.id && r.id !== mutedId && r.id !== verifyId);
    const removable = roles.filter((r) => r.editable);
    const kept = roles.filter((r) => !r.editable);
    if (!removable.size) {
      return interaction.reply({ embeds: [status.note(`${user} n'a aucun rôle que je puisse retirer.`, 'Rien à retirer')], ephemeral: true });
    }
    // Retrait d'un rôle SENSIBLE (staff : permission dangereuse, whitelist, niveau ≥ 2) signé par le
    // bot : pré-contrôlé au nom de l'auteur (refus d'emblée au seuil), avant la confirmation puis
    // juste avant le retrait, et rapporté après succès.
    const cfg = client?.services?.config?.get(interaction.guild.id) ?? {};
    const perms = client?.services?.permissions;
    const levelOf = typeof perms?.levelOf === 'function' ? (g, r) => perms.levelOf(g, r) : undefined;
    const sensitiveIds = [...removable.filter((r) => isSensitiveRole(r, cfg, { levelOf })).keys()];
    const sensitive = sensitiveIds.length > 0;
    const preCheck = () => client?.services?.secur?.assertAllowed?.(interaction, 'roleRemove', { count: 1 });
    if (sensitive) preCheck();
    if (client?.services?.config?.get(interaction.guild.id)?.moderation?.confirmDangerous) {
      const ok = await confirm(interaction, {
        description: `Retirer **${removable.size}** rôle${removable.size > 1 ? 's' : ''} à ${user} ?`,
        confirmLabel: 'Dérank',
      });
      if (!ok) return undefined;
      if (sensitive) preCheck();
    }
    // Raison du journal d'audit : 512 caractères au plus (au-delà, Discord refuse la requête).
    await member.roles.remove(removable, truncate(reason || `Derank par ${interaction.user.tag}`, 500));
    // Rôles temporaires retirés : leur ligne est close (sinon rendus au retour du membre).
    for (const roleId of removable.keys()) client?.services?.tempRoles?.closeManual?.(interaction.guild.id, member.id, roleId);

    const mentions = [...removable.sort((a, b) => b.position - a.position).values()].map((r) => `${r}`);
    const fields = [
      field(ICONS.user, 'Membre', userLine(user)),
      field(ICONS.moderator, 'Modérateur', `${interaction.user}`),
      field(ICONS.count, 'Rôles retirés', `**${removable.size}**`),
      wide(ICONS.role, 'Rôles retirés', listOrMore(mentions, 25, ' ')),
      kept.size ? wide(ICONS.lock, 'Conservés (trop hauts ou gérés)', listOrMore([...kept.values()].map((r) => `${r}`), 15, ' ')) : null,
      wide(ICONS.reason, 'Raison', reason ? truncate(reason, 1024) : '*Aucune raison fournie*'),
    ];
    const embed = (section) => card({
      tone: 'caution',
      section,
      icon: '📉',
      title: 'Membre dérank',
      description: `${user} a perdu **${removable.size}** rôle${removable.size > 1 ? 's' : ''}.`,
      fields,
      thumbnail: member.displayAvatarURL?.({ size: 128 }) ?? null,
    });
    const payload = { embeds: [embed('roles')] };
    // Après confirmation, la carte remplace la demande (éphémère). Réponse d'abord (délai de 3 s), log ensuite.
    const response = interaction.replied || interaction.deferred ? await interaction.editReply(payload) : await interaction.reply(payload);
    // Rôles sensibles retirés transmis : Secur peut les rendre si un incident s'ouvre ensuite.
    if (sensitive) await client?.services?.moderation?.reportDestructiveAction?.(interaction.guild, interaction.user, 'roleRemove', { count: 1, targetId: member.id, record: { roles: sensitiveIds } })?.catch?.(() => {});
    await client?.services?.logging?.send?.(interaction.guild.id, 'moderation', embed('moderation'), undefined, { event: 'sanction' })?.catch?.(() => {});
    return response;
  },
};
