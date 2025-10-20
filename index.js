// Dépendances de base (necessite 'discord.js' et 'axios')
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');

// --- INITIALISATION DU BOT & TOKEN ---

// *** ⚠️ ATTENTION: REMPLACER PAR TON JETON RÉEL ⚠️ ***
const TOKEN = "MTQxMjA0NTM0MzExMzM1MTI2OQ.GiN5bZ.n-Fnf-KwQUgPmM5jIbYayOZlmxP9yhaXSTNEhM"; 
// *** REMPLACER PAR TON ID UTILISATEUR DISCORD (pour /admin) ***
const OWNER_ID = "736906288453386261"; 

let notificationChannelId = null;
let dmNotificationsEnabled = false;

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
    ] 
});

// --- LOGIQUE ASYNCHRONE DE FETCH (EPIC GAMES) ---

async function fetchEpicGamesFreeGames() {
    const URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
    try {
        const response = await axios.get(URL);
        const elements = response.data.data.Catalog.searchStore.elements;

        const freeGames = elements
            .filter(game => game.promotions && game.promotions.promotionalOffers.length > 0)
            .map(game => {
                const offer = game.promotions.promotionalOffers[0].promotionalOffers[0];
                return {
                    title: game.title,
                    url: `https://store.epicgames.com/fr/p/${game.productSlug || game.urlSlug}`,
                    price: offer.originalPrice,
                    discount: offer.discountSetting.discountPercentage,
                };
            })
            .filter(game => game.discount === 0 && game.promotions.promotionalOffers[0].promotionalOffers[0].endDate);

        return freeGames;
    } catch (error) {
        console.error("Erreur lors de la récupération des jeux Epic Games :", error.message);
        return [];
    }
}

// Fonction utilitaire pour envoyer le message final
async function sendFreeGames(interaction, games, channelId, dmEnabled) {
    if (games.length === 0) {
        return interaction.reply({ content: "Aucun jeu gratuit disponible actuellement.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setTitle('🎮 Jeux Gratuits Epic Games !')
        .setColor(0x0078F2)
        .setTimestamp();

    games.forEach(game => {
        embed.addFields({ name: game.title, value: `[Récupérer le jeu](${game.url})` });
    });

    const promises = [];
    
    // 1. Envoi en DM
    if (dmEnabled && interaction.user) {
        promises.push(interaction.user.send({ embeds: [embed] }).catch(() => console.log('Impossible d\'envoyer le DM.')));
    }

    // 2. Envoi dans un channel
    if (channelId) {
        const channel = client.channels.cache.get(channelId);
        if (channel) {
            promises.push(channel.send({ embeds: [embed] }));
        }
    }

    await Promise.all(promises);

    interaction.reply({ content: "Affichage terminé !", ephemeral: true });
}


// --- DÉFINITION DES SLASH COMMANDS ---

const commands = [
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('Affiche les informations et le ping du bot.'),

    new SlashCommandBuilder()
        .setName('gratuit')
        .setDescription('Affiche immédiatement les jeux gratuits Epic Games disponibles.'),

    new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configure les notifications de jeux gratuits.')
        .addChannelOption(option => 
            option.setName('channel')
                  .setDescription('Canal pour les notifications automatiques.')
                  .setRequired(false))
        .addBooleanOption(option => 
            option.setName('dm_active')
                  .setDescription('Recevoir les notifications en DM (True/False).')
                  .setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Commandes d\'administration du bot.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('logs')
                .setDescription('Affiche l\'état du bot.'))
];

// --- GESTION DES ÉVÉNEMENTS DU BOT ---

client.on('ready', () => {
    console.log(`Bot connecté en tant que ${client.user.tag}`);
    
    // Déploiement des Slash Commands
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    (async () => {
        try {
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands },
            );
            console.log('Slash Commands enregistrées avec succès.');
        } catch (error) {
            console.error(error);
        }
    })();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    
    let games;
    if (commandName === 'gratuit' || commandName === 'config') {
        games = await fetchEpicGamesFreeGames();
    }


    // Commande /info
    if (commandName === 'info') {
        const ping = Math.round(client.ws.ping);
        const embed = new EmbedBuilder()
            .setTitle(`🤖 Informations sur ${client.user.username}`)
            .setColor(0x3498DB)
            .addFields(
                { name: 'Latence Discord', value: `${ping}ms`, inline: true },
                { name: 'Uptime (PM2)', value: 'Vérifiez pm2 list', inline: true },
                { name: 'Serveurs', value: `${client.guilds.cache.size}`, inline: true },
            );
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Commande /gratuit
    else if (commandName === 'gratuit') {
        await sendFreeGames(interaction, games, interaction.channelId, false);
    }
    
    // Commande /config
    else if (commandName === 'config') {
        const channelOption = interaction.options.getChannel('channel');
        const dmOption = interaction.options.getBoolean('dm_active');
        
        if (channelOption) {
            notificationChannelId = channelOption.id;
            interaction.channel.send(`Le canal de notification a été défini sur **${channelOption.name}**.`);
        }

        if (dmOption !== null) {
            dmNotificationsEnabled = dmOption;
            interaction.channel.send(`Les notifications en DM sont maintenant **${dmOption ? 'activées' : 'désactivées'}** globalement.`);
        }
        
        // Envoi immédiat des jeux aux canaux/DM configurés
        await sendFreeGames(interaction, games, notificationChannelId, dmNotificationsEnabled);
    }
    
    // Commande /admin
    else if (commandName === 'admin') {
        if (interaction.user.id !== OWNER_ID) {
            return interaction.reply({ content: "Accès refusé. Seul le propriétaire du bot peut utiliser cette commande.", ephemeral: true });
        }

        const subCommand = interaction.options.getSubcommand();
        
        if (subCommand === 'logs') {
            const embed = new EmbedBuilder()
                .setTitle("⚙️ Statut du Bot & Admin Info")
                .setColor(0xFFA500)
                .setDescription("L'exécution est gérée par PM2 sur AWS.")
                .addFields(
                    { name: 'Canal Configuré', value: notificationChannelId ? client.channels.cache.get(notificationChannelId).name : 'Aucun', inline: true },
                    { name: 'DM Activés', value: dmNotificationsEnabled ? 'Oui' : 'Non', inline: true },
                    { name: 'Logs Détaillés', value: 'Utilisez `pm2 logs EpicBot` sur le serveur.', inline: false }
                );
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
});


// --- DÉMARRAGE ET CONNEXION ---
client.login(TOKEN);
