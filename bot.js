const Discord = require('discord.js')
const logger = require('winston')
var myAuth = require('./auth.json')
const Config = require('./Config.json')
const Guilds = Config.guilds
const Bosses = Config.bosses

const versionNumber = 'v1.2.7'

// Logger configuration
logger.remove(logger.transports.Console)
logger.add(new logger.transports.Console, {
    colorize: true
})
logger.level = 'debug'

// Bot initialization 
const bot = new Discord.Client()
var newAuth = null
var secretWord = "dragondudes"   

// Layering (eww)
var numberOfLayers = 2

// Boss Initialization
Bosses.forEach(boss => { 
    boss.nextRespawnDate = []
    boss.up = []
    boss.layerId = []
})

var LastAlertMessage = undefined

// Scouting lists
var currentScoutsLists = new Map()
for (boss of Bosses) { 
    let scoutLists = []
    for (i=0; i<numberOfLayers; i++)
        scoutLists[i] = new Map()
    currentScoutsLists.set(boss.name, scoutLists) 
}

// Green Dragon Info
var GreenDragonsKilled = []
for (i=0; i< numberOfLayers; i++) {
    GreenDragonsKilled[i] = 0
}

// --------------------------------------------------------------
// Google Sheet Auth Stuff
// --------------------------------------------------------------

const fs = require('fs')
const readline = require('readline')
const { google } = require('googleapis')

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = 'token.json'

// Load client secrets from a local file.
fs.readFile('credentials.json', (err, content) => {
    if (err) return console.log('Error loading client secret file:', err)
    // Authorize a client with credentials, then call the Google Sheets API.
    authorize(JSON.parse(content), initializeBot)
})

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
    const { client_secret, client_id, redirect_uris } = credentials.installed
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

    // Check if we have previously stored a token.
    fs.readFile(TOKEN_PATH, (err, token) => {
        if (err) return getNewToken(oAuth2Client, callback)
        oAuth2Client.setCredentials(JSON.parse(token))
        callback(oAuth2Client)
    })
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback for the authorized client.
 */
function getNewToken(oAuth2Client, callback) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    })
    console.log('Authorize this app by visiting this url:', authUrl)
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })
    rl.question('Enter the code from that page here: ', (code) => {
        rl.close()
        oAuth2Client.getToken(code, (err, token) => {
            if (err) return console.error('Error while trying to retrieve access token', err)

            oAuth2Client.setCredentials(token)
            // Store the token to disk for later program executions
            fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
                if (err) return console.error(err)
                console.log('Token stored to', TOKEN_PATH)
            })
            callback(oAuth2Client)
        })
    })
}

function initializeBot(auth) {
    newAuth = auth
    bot.login(myAuth.token)
    let nextTuesday = getNextTuesday(new Date())
    let resetDuration = nextTuesday.getTime() - Date.now()

    logger.info("Sheets will be automatically reset on: " + nextTuesday.toLocaleString('en-US', Config.dateFormats.killedDateFormat) + " ("
        + (resetDuration / (1000 * 60 * 60)).toFixed(2) + " hours)")

    setTimeout(resetSheets, nextTuesday.getTime() - Date.now())
    //resetSheets()
}


// --------------------------------------------------------------
// Loot Functions
// --------------------------------------------------------------

// Reference to the most recently killed boss
var LastKilledBoss = undefined

// Reference to the current Message in the loot channel.
// This allows for the same message to be update, reducing spam.
var lootAttendanceMessage = undefined

/**
 * Resets all loot attendance variables for each
 * participating guild. In addition, the reference
 * to the last loot ranges message (if any) is
 * lost. This will cause a new message to be
 * created upon next usage of loot attendance
 * feature.
 * 
 * @param {any} message
 */
function resetLootVariables(message) {
    logger.info("command: resetLoot")

    Guilds.forEach((value, key, map) => {
        value.lootAttendance = undefined
        logger.info("    (resetLootVariables) - reset lootAttendance for " + value.tag)
    })

    message.channel.send({
        embed:
        {
            title: "Loot Reset",
            description: "Attendance numbers for all guilds has been reset",
            color: getGuildFromDisplayName(message.member.displayName).color,
        }
    })

    // Remove reference to loot message
    lootAttendanceMessage = undefined

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })
}

/**
 * Updates the guild's attendance information and displays a message 
 * containing the loot ranges for each participating guild. Only one 
 * of these messages is displayed at a time. If a loot range message 
 * was previously sent (tracked via lootAttendanceMessage), it is 
 * updated with the most recent information.
 * 
 * @param {any} message
 * @param {guild} guild The guild with the new information
 * @param {Number} amount The number of people said guild had attending the kill
 */
function setGuildLootAttendance(message, guild, amount) {
    logger.info("command: setGuildLootAttendance")
    let bossName = LastKilledBoss != undefined ? LastKilledBoss.name : "the boss"
    guild.lootAttendance = amount == 0 ? undefined : amount
    logger.info("    (setGuildLootAttendance) - " + guild.tag + " has " + amount + " people at " + bossName)

    let guildsList = ""
    let lootRange = 1
    let participatingGuilds = []

    // Get participation info for each guild
    Guilds.forEach((value, key, map) => {
        if (value.lootAttendance != undefined) {
            guildsList += "\n\t\t" + "**<" + value.tag + ">** - " + value.lootAttendance + " people"
            lootRange += value.lootAttendance
            participatingGuilds.push(value)
        }
    })

    // Add participation info to message
    let msgFields = []
    msgFields.push({
        name: "" + participatingGuilds.length + (participatingGuilds.length == 1 ? " guild" : " guilds") + " participated in " + bossName + " kill:",
        value: guildsList,
        inline: false
    })

    // Mix up order of guilds so as to improve randomness
    let shuffledGuilds = shuffle(participatingGuilds)
    logger.info("    (getLootRange) - Found " + shuffledGuilds.length + " guilds participating in kill")
    let tempLootRange = 1

    // Add loot range for each participating guild
    shuffledGuilds.forEach((value, key, map) => {
        logger.info("    (getLootRange) - writing out " + value.tag)
        msgFields.push({
            name: value.tag,
            value: value.lootAttendance == 1
                ? tempLootRange
                : tempLootRange + " - " + (tempLootRange + value.lootAttendance - 1),
            inline: true
        })
        //guildRanges += "\n\t\t- **<" + value.tag + ">**: " + tempLootRange + " - " + (tempLootRange + value.lootAttendance)
        tempLootRange += value.lootAttendance
    })

    msgFields.push({
        value: "Loot Range (1 - " + (lootRange - 1) + ")",
        name: "------------------------------------------",
        inline: false
    })

    // Remove old loot message 
    if (lootAttendanceMessage != undefined) {
        lootAttendanceMessage.delete()
            .catch(e => { logger.error("    (getLootRange) - Error deleting old lootAttendanceMessage... (" + e + ")") })
    }

    // Send new message
    const lootTitle = "Loot range for " + bossName + " kill (1 - " + (lootRange - 1) + ")"
    message.channel.send({
        embed: {
            title: lootTitle,
            color: getGuildFromDisplayName(message.member.displayName).color,
            fields: msgFields,
            timestamp: new Date()
        }
    }).then(newMessage => { lootAttendanceMessage = newMessage })

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })
}

/**
 * Shows the help menu for loot commands.
 * 
 * @param {any} message
 * @param {Boolean} showAllCommands Verbose mode, showing all variations for each command
 */
function showLootHelp(message, showAllCommands) {
    logger.info("command: showLootHelp")

    let helpText = "The following is a list of commands that can be used to generate the loot ranges for each guild after a successful boss kill.\n"
        + "\n** " + Config.identifier + " <Guild> <Number of Players>**"
        + "```Sets the number of players present at the time of the boss kill for the given guild.\n\n (Example: !" + Guilds[0].tag + " 12)```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.bossLoot.reset) : Config.identifier + Config.commands.bossLoot.reset[0]) + "**"
        + "```Clears all attendance numbers used to determine loot ranges. ```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.bossLoot.help) : Config.identifier + Config.commands.bossLoot.help[0]) + "**"
        + "```Shows this list of commands.```"
    //+ "\n**" + (showAllCommands ? listAllVariations(Config.bossLoot.commands.loot) : Config.identifier + Config.bossLoot.commands.loot[0]) + "**"
    //    + "```Gets the loot range for all guilds who participated in the boss kill.```"

    message.channel.send({
        embed: {
            title: "---- Loot Commands for " + Config.botName + " ----",
            color: getGuildFromDisplayName(message.member.displayName).color,
            description: helpText
        }
    })

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })
}

// --------------------------------------------------------------
// Notification Functions
// --------------------------------------------------------------

// -------------------------- Error Functions

/**
 * Notifies the user that the date they tried to
 * append to the end of a command was invalid.
 * Also shows them the current acceptable formats
 * for a date.
 * 
 * @param {Message} message 
 */
function notifyInvalidDate(message)
{
    message.channel.send('<@' + message.author.id + '>\nInvalid date entered. Please try again by either omitting the date or using one of the following formats:'
        + '\n``MM/DD/YYYY HH:MM AM/PM\nHH:MM AM/PM``')
}

function notifyDiscordBotError(message, errormessage) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    message.author.send(':warning: <@' + message.author.id + '> :warning: ' + errormessage)
}

/**
 * Notifies the user that the current boss is not
 * available for scouting right now.
 * 
 * @param {any} message
 * @param {any} boss
 * @param {Number} layer
 */
function notifyBossNotScoutable(message, boss, layer) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    message.author.send('<@' + message.author.id + '>\n' + boss.name + ' was killed ' + (numberOfLayers > 1 ? ("on layer " + layer + " at ") : ("at ") ) + boss.killedAt.toLocaleString("en-US", Config.dateFormats.killedDateFormat) 
        + '__. \nNo scouts are needed ' + (numberOfLayers > 1 ? "on this layer until " : "until ")
        + (getNextRespawnTime(boss.killedAt[layer-1], boss)).toLocaleString("en-US", Config.dateFormats.killedDateFormat) + '**__.\n'
        + "**__TIP:__**\n> To start scouting on a different layer, add `layer=<layer number>` to the command.\n> For Example: `" + Config.identifier + Config.commands.normal.beginShift[0] + "layer=2`"
        + '\n-----------------------------------------------------------------------------------------')
}

/**
 * 
 * @param {*} message 
 * @param {Scout} scout 
 * @param {Boss} boss 
 * @param {Number} layer 
 */
function notifyUserAlreadyScouting(message, scout, boss, layer) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })
    
    message.author.send('You are already scouting ' + boss.name + (numberOfLayers > 1 ? (" on layer " + layer + "! ") : "! ") +
        'You have been scouting since `' + scout.startTime.toLocaleString("en-US", Config.dateFormats.killedDateFormat) +
        '`. If you believe this is in error, type `' + Config.identifier + Config.commands.normal.endShift[0] + 
        '` and ask one of the admins to update the attendance sheet manually. Then type `' + Config.identifier + Config.commands.normal.beginShift[0] + 
        '` to begin your shift.'
        + '\n-----------------------------------------------------------------------------------------')
}

function notifyUserNotScouting(message, layer) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    message.author.send('I don\'t have a record of you ever clocking in ' + (numberOfLayers > 1 ? (" on layer " + layer) : "") 
        + '! If you believe this is in error, please contact ' + Config.botOwner + '.'
        + "\n\nPlease Note: If the boss you were scout was registered as killed, you are automatically clocked out. No need to manually stop your shift!"
        + '\n-----------------------------------------------------------------------------------------')
}

function notifyUserHasInvalidGuildTag(message) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    const displayName = message.member.displayName
    const guildName = displayName.substring(1, displayName.indexOf('>'))
    //logger.info('guildName = ' + guildName)

    if (guildName == 'Fury') {
        logger.info('WE FOUND A SPY')
        message.channel.send(Config.spicyQuotes.fury[getRandomInt(0, Config.spicyQuotes.fury.length - 1)])
    }
    else {
        //todo - Notify user that they have invalid guild tag
        logger.info('Caught a user with an invalid tag! (' + message.member.displayName + ')')
        message.author.send('A proper guild name is required to use this bot. Please change your display name to include your guild. The proper format would be:\n\t`<Guild Name> CharacterName`.'
            + ' The bot currently knows about the following guilds: ' + getListOfGuilds()
            + '\n-----------------------------------------------------------------------------------------')
    }
}

// -------------------------- Boss Functions

/**
 * This function is used whenever one wants to determine
 * if the boss has been killed on all layers.
 * 
 * @param {Boss} boss 
 */
function bossKilledOnAllLayers(boss) {
    let deadOnAllLayers = true
    for (i=0; i<numberOfLayers; i++)
        if (boss.dead[i] == undefined)
            deadOnAllLayers = false

    return deadOnAllLayers
}

/**
 * Sends a notification to every Green Dragon scouting channel and the World Boss
 * channel notifying people that all green dragons have been killed, and that 
 * they can start spawning again at the given time.
 * 
 * @param {Date} nextRespawnWindow The date at which bosses can start spawning again
 * @param {Number} layer The layer the boss was killed on
 */
function notifyAllGreenDragonsDead(nextRespawnWindow, layer) {
    logger.info("    (notifyAllGreenDragonsDead) - Notifying that all Green Dragons have been killed on layer " + layer)
    const titleStr = 'All Green Dragons have been killed' + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!"))
    const headerStr = "The respawn cooldown period has begun."
    const bodyStr = "Next respawn window " + (numberOfLayers > 1 ? (" for layer " + layer) : ("")) +": **" + nextRespawnWindow.toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "**"
    Bosses.forEach(boss => {
        if (boss.type == "Green Dragon") {
            bot.channels.find(c => c.id == boss.channelId).send({
                embed: {
                    title: titleStr,
                    color: Config.alertColor,
                    fields: [{
                        name: headerStr,
                        value: bodyStr
                    }]
                }
            })
        }
    })

    bot.channels.find(c => c.id == Config.worldBossAlertChannelId).send({
        embed: {
            title: titleStr,
            color: Config.alertColor,
            fields: [{
                name: headerStr,
                value: bodyStr
            }]
        }
    })
}

/**
 * This function is used whenever a boss becomes spawnable again.
 * This can occur after a server reset or a boss's respawn CD expires.
 * 
 * @param {any} bossChannelId The channel id for the given boss
 */
function notifyBossRespawn(bossChannelId) {
    const boss = Bosses.find(b => b.channelId == bossChannelId)
    if (boss == undefined) {
        logger.error('(notifyBossRespawn) - no boss found for channelId: ' + bossChannelId)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }
    const channel = bot.channels.find(c => c.id == bossChannelId)
    if (channel == undefined) return logger.error('(notifyBossRespawn) - no channel found for channelId: ' + bossChannelId)

    channel.send('@everyone', {
        embed: {
            title: '' + boss.name + ' will soon be able to spawn!',
            color: Config.alertColor,
            fields: [{
                name: 'Please begin scouting for the boss by typing ' + Config.identifier + Config.commands.normal.beginShift[0]
                    + '. Bot commands are pinned, and ' + Config.identifier + Config.commands.normal.listCommands[0] + ' will display them if you need a list.',
                value: 'You can sign up for future scout shifts by using the `' + Config.identifier + Config.commands.normal.signUp[0] + '` command.\nOr on the google sheet (' 
                    + Config.signupSheetURL + boss.signupSheetURL + ')',
                inline: true
            }],
            timestamp: new Date()
        },
    })
}

/**
 * Similar to notifyBossRespawn(), this function is used to remind people
 * that a boss is about to come off cooldown. This can occur right before
 * a boss's respawn CD expires, or manually via an admin.
 * 
 * @param {Number} bossChannelId The channel id for the given boss
 */
function notifyBossRespawnSoon(bossChannelId) {
    const boss = Bosses.find(b => b.channelId == bossChannelId)
    if (boss == undefined) {
        logger.error('(notifyBossRespawnSoon) - no boss found for channelId: ' + bossChannelId)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    const channel = bot.channels.find(c => c.id == bossChannelId)
    if (channel == undefined) {
        logger.error('(notifyBossRespawnSoon) - no channel found for channelId: ' + bossChannelId)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    const nextRespawnDate = getNextRespawnTime(boss.killedAt, boss)
    if (nextRespawnDate == undefined) {
        logger.error("(notifyBossRespawnSoon) - couldn't get nextRespawn date for " + boss.name)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    logger.info('    (notifyBossRespawnSoon) - nextRespawn: ' + nextRespawnDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    channel.send('@everyone', {
        embed: {
            title: '' + boss.name + ' will be able to spawn soon! (' + nextRespawnDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat) + ' server time)',
            color: Config.alertColor,
            fields: [{
                name: 'Please start signing up for at least one 30-minute scouting shift. To sign up for a shift, use the `' + Config.identifier + Config.commands.normal.signUp[0] + '` command.',
                value: 'Alernatively, you can manually sign up on the google sheet (' + Config.signupSheetURL +  boss.signupSheetURL + ').'
            }]
        }
    })
}

/**
 * This function is used whenever a boss is reported dead.
 * 
 * @param {*} message 
 * @param {Boss} boss The killed boss
 * @param {Date} nextRespawn The date when the boss will be spawnable again
 * @param {Boolean} sendMessageInWorldBoss Whether to send an arlert in World Boss channel
 * @param {Number} layer The layer the boss was killed on
 */
function notifyBossKilled(message, boss, nextRespawn, sendMessageInWorldBoss, layer) {
    logger.info("    (notifyBossKilled) - dead on all layers: " + bossKilledOnAllLayers(boss))
    let respawnString = nextRespawn == undefined ? "Waiting on other green dragons to be killed." : ("Respawns: " + nextRespawn.toLocaleString("en-US", Config.dateFormats.killedDateFormat) + " server")

    // If boss is dead on all known layers, we can be pretty sure we don't need to prioritize scouting
    if (!bossKilledOnAllLayers(boss))
        respawnString += "\n\n:exclamation: **" + (boss.type == "Green Dragon" ? ("Green Dragons are") : (boss.name + " is")) +  " still alive on other layers! Scouts are still needed in " + boss.location + ".** :exclamation:"

    const killedAtString = boss.killedAt[layer-1].toLocaleString("en-US", Config.dateFormats.killedDateFormat)
    //const respawnTime = new Date(getNextRespawnTime(boss.killedAt, boss).getTime() + (3600000 * Config.utc_offset * -1)).toLocaleString("en-US", Config.dateFormats.killedDateFormat)
    //logger.info("    (notifyBossKilled) - respawnTime: " + respawnString)
    logger.info("    (notifyBossKilled) - killedAt: " + killedAtString)

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    if (Config.debug.notifications.disableBossKilled) return logger.info("    (notifyBossKilled) - DEBUG: suppressing notification")


    let titleStr = (boss.type == "Green Dragon" ? ("A Green Dragon was killed in " + boss.location) : (boss.name + " was killed")) + (numberOfLayers > 1 ? (" on layer " + layer + "!") : "!")
    message.channel.send({
        embed: {
            title: titleStr,
            color: getGuildFromDisplayName(message.member.displayName).color,
            fields: [{
                name: 'Killed: ' + killedAtString + ' server',
                value: respawnString,
                inline: true
            }],
            timestamp: new Date()
        },
    })
    if (sendMessageInWorldBoss) {
        bot.channels.find(val => val.id == Config.worldBossAlertChannelId).send({
            embed: {
                title: titleStr,
                color: getGuildFromDisplayName(message.member.displayName).color,
                fields: [{
                    name: 'Killed: ' + killedAtString + ' server',
                    value: respawnString,
                    inline: true
                }],
                timestamp: new Date()
            },
        })
    }
    else
        logger.info("    (notifyBossKilled) - skipping WorldBossAlert channel...")
}

/**
 * This function is used whenever a scout signals that a boss has spawned.
 * 
 * @param {message} message 
 * @param {String} characterName The name of the character people should whisper ingame
 */
function notifyBossUp(message, characterName) {
    //const player = characterName == undefined ? getCharacterNameFromDisplayName(message.member.displayName) : characterName
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    const title = ':exclamation:' + boss.name.toUpperCase() + ' HAS SPAWNED :exclamation:'
    const fieldValue = characterName == undefined ? "--------------------------" : 'Type `/w ' + characterName + ' ' + secretWord + '` ingame for an invite!'
    const fieldTitle = boss.spawnText != undefined ? boss.spawnText : 'Please begin flying here immediately. DO NOT WAIT FOR A SUMMON!\n---------------------------------------------------------------------------'

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    if (Config.debug.notifications.disableBossUp)
        return logger.info("    (notifyBossUp) - DEBUG: suppressing notification")

    message.channel.send('@everyone @everyone @everyone', {
        embed: {
            title: title,
            color: getGuildFromDisplayName(message.member.displayName).color,
            fields: [{
                name: fieldTitle,
                value: fieldValue,
                inline: true
            }],
            timestamp: message.createdAt
        },
    })
    const worldBossAlertChannel = bot.channels.find(val => val.id == Config.worldBossAlertChannelId)
    if (worldBossAlertChannel != undefined) {
        worldBossAlertChannel.send('@everyone')
        worldBossAlertChannel.send('@everyone')
        worldBossAlertChannel.send('@everyone', {
            embed: {
                title: title,
                color: getGuildFromDisplayName(message.member.displayName).color,
                fields: [{
                    name: fieldTitle,
                    value: fieldValue,
                    inline: true
                }],
                timestamp: message.createdAt
            },
        })
    }
    else
        logger.error('(notifyBossUp) - couldn\'t find world boss channel...');
}


// -------------------------- Scout Functions

/**
 * This function is called whenever a user adds a new summoner location.
 * 
 * @param {Message} message 
 * @param {String} summonerLocation 
 */
function notifySummonerInfoSet(message, summonerLocation)
{
    message.delete().catch(e => { })

    message.channel.send({
        embed: {
            title: 'Summoner location set',
            color: getGuildFromDisplayName(message.member.displayName).color,
            fields: [{
                name: message.member.displayName + ' has a summoner at the following world boss locations:',
                value: summonerLocation,
                inline: true
            }]
        }
    })
}

/**
 * This function is called 30 minutes before a user's shift is about to begin.
 * This reminder only occurs if the user signed up for a future shift using
 * the !signUp command.
 * 
 * @param {User} user 
 * @param {Boss} boss 
 */
function remindUserOfScoutTime(user, boss)
{
    const message = "This is a friendly reminder that you are scheduled to scout " + boss.name + " in approximately 30 minutes! If your plans have changed, please post in the discord channel immediately and try to find someone to cover your shift.\n\n"
        + "You can view the sign up sheet here: " + Config.signupSheetURL + boss.signupSheetURL
        
    user.send(message)
}

/**
 * This function is used to send a channel message
 * notifying that the user has stopped scouting.
 * 
 * @param {Message} message 
 * @param {String} displayName 
 * @param {Boss} bossName 
 * @param {Map<String, Scout} scoutList 
 */
function notifyScoutLeaving(message, scout, bossName, scoutList)
{
    const title = scout.displayName + ' is leaving ' + bossName + '.'

    let otherScoutsTitle = ''
    let otherScouts = ''
    if (scoutList.size > 0) {
        otherScoutsTitle = scoutList.size + ' other ' + (scoutList.size > 1 ? 'players' : 'player') + ' scouting:'
        for (const scoutKey of scoutList.keys()) {
            let s = scoutList.get(scoutKey)
            otherScouts += '\n\t\t- ' + s.displayName + ' (since ' + s.startTime.toLocaleString("en-US", Config.dateFormats.scoutDateFormat) + ')'
        }
    } else {
        otherScoutsTitle = 'WARNING: NO REPLACEMENT IS ASSIGNED!'
        otherScouts = ':exclamation::exclamation::exclamation: ' + bossName.toUpperCase() + ' IS  UNATTENDED :exclamation::exclamation::exclamation: '
    }

    message.channel.send({
        embed: {
            title: title,
            color: getGuildFromDisplayName(scout.displayName).color,
            fields: [{
                name: otherScoutsTitle,
                value: otherScouts,
                inline: true
            }],
            timestamp: message.createdAt
        },
    })
}

/**
 * This function is used whenever a user begins scouting.
 * 
 * @param {message} message 
 * @param {String} displayName 
 * @param {Boss} boss 
 * @param {Number} layer
 */
function notifyNewScout(message, displayName, boss, layer) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    const scoutListAllLayers = getScoutListFromChannelId(message.channel.id)
    const scoutGuild = getGuildFromDisplayName(displayName)
    if (scoutGuild == undefined) return logger.error("(notifyNewScout) - unable to find guild for " + displayName)

    let title = scoutGuild.sayings != undefined
        ? scoutGuild.sayings[getRandomInt(0, scoutGuild.sayings.length - 1)].replace("%s", displayName).replace("%b", boss.name + (numberOfLayers > 1 ? (" on layer " + layer + ".") :  "."))
        : displayName + ' started scouting ' + boss.name + (numberOfLayers > 1 ? (" on layer " + layer + ".") : ".")

    let otherScoutsTitle = ''
    let otherScouts = ''

    if (numberOfLayers > 1) {
        otherScoutsTitle = 
        showBossStatus(title, boss, scoutGuild.color)
    } else {
        const scoutList = scoutListAllLayers[layer-1]
        if (scoutList.size > 0) {
            let moreThanOne = scoutList.size > 1
            otherScoutsTitle = scoutList.size + ' other ' + (moreThanOne ? 'players' : 'player') + ' scouting:'
            otherScouts = ''
            for (const scoutKey of scoutList.keys()) {
                let scout = scoutList.get(scoutKey)
                otherScouts += '\n\t\t- ' + scout.displayName + ' (since ' + scout.startTime.toLocaleString(undefined, Config.dateFormats.scoutDateFormat) + ')'
            }
        }
        else {
            otherScoutsTitle = 'No other players are helping scout.'
            otherScouts = '\n----------------------------------------'
        }
    
        otherScouts += "\n\nView the sign up sheet at: " + Config.signupSheetURL + boss.signupSheetURL

        message.channel.send({
            embed: {
                title: title,
                color: scoutGuild.color,
                fields: [{
                    name: otherScoutsTitle,
                    value: otherScouts,
                    inline: true
                }],
                timestamp: message.createdAt
            },
        })
    }
}

function showAllBossStatus(title) {
    const worldBossAlertChannel = bot.channels.find(c => c.id == Config.worldBossAlertChannelId)

    let msgFields = []

    Bosses.forEach(boss => {
        let layersStatus = ""
        if (numberOfLayers > 1) {
            for (i=0; i<numberOfLayers; i++) {
                layersStatus += "__Layer " + (i+1) + ":__ "
                layersStatus += boss.dead[i] 
                    ? ("*---- DEAD ----*\n> (Killed on: *" + boss.killedAt[i].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "*)" 
                        + (boss.type == "Green Dragon" && GreenDragonsKilled[i] != 4 
                            ? ("\n> **(Waiting on other green dragons to be killed.)**")
                            : ("\n> (Can respwn after: **" + boss.nextRespawnDate[i].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "**)")))
                    : boss.up[i] != undefined 
                        ? "***--- ALIVE ---*** (first reported: **" + boss.up[i].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "**)"
                        : "*--- Spawnable ---*"
                layersStatus += "\n"
            }
        } else {
            layersStatus = boss.dead[0] 
                ? ("*---- DEAD ----*\n> (Killed on: *" + boss.killedAt[0].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "*)" 
                    + (boss.type == "Green Dragon" && GreenDragonsKilled[0] != 4 
                        ? ("\n> **(Waiting on other green dragons to be killed.)**\n")
                        : ("\n> (Can respwn after: **" + boss.nextRespawnDate[0].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "**)")))
                : boss.up[i] != undefined 
                    ? "***--- ALIVE ---*** (first reported: **" + boss.up[i].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "**)"
                    : "*--- Spawnable ---*"
        }
        msgFields.push({
            name: "" + boss.name + " status:",
            value: layersStatus,
        })
    })

    if (LastAlertMessage != undefined) {
        LastAlertMessage.delete().catch(e => { })
        LastAlertMessage = undefined
    }

    worldBossAlertChannel.send({
        embed: {
            title: "Latest: " + title,
            color: Config.alertColor,
            fields: msgFields
        }
    }).then(newMessage => { LastAlertMessage = newMessage })
}

function showBossStatus(title, boss, color) {
    const scoutListAllLayers = getScoutListFromChannelId(boss.channelId)
    const channel = bot.channels.find(c => c.id == boss.channelId)

    const embededTitle = "There " + (numberOfLayers > 1 ? "are" : "is" ) + " currently " + numberOfLayers + " layer" + (numberOfLayers > 1 ? "s." : ".")
    let embededMessage = ""

    // For each layer, print 1 of 3 things:
    //    1. Boss Dead - When the boss will respawn on this layer
    //    2. No Scouts - NONE
    //    3. Scouts - List of scout(s) and the time(s) they started scouting
    for (i = 0; i<numberOfLayers; i++) {
        //logger.info("    (showBossStatus) - Length of scout list on layer " + (i+1) + ": " + scoutListAllLayers[i].size)
        embededMessage += "\n\n__Scouts on **Layer " + (i+1) + "**__" + (boss.layerId[i] != undefined ? (" [zone **" + boss.layerId[i] + "**] :") : ":")
        if (boss.dead[i] != undefined) {
            embededMessage += "\n\t\t***---- DEAD ---- ***\n(Killed on: *" + boss.killedAt[i].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "*)"
            if (boss.type == "Green Dragon" && GreenDragonsKilled[i] != 4) {
                embededMessage += "\n**(Waiting on other green dragons to be killed.)**"
            } else {
                embededMessage += "\n(Can respwn after: **" + boss.nextRespawnDate[i].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + "**)"
            } 
        } else if (scoutListAllLayers[i].size == 0) {
            embededMessage += "\n\t\t- :exclamation::exclamation: ***NONE*** :exclamation::exclamation:\n"
        } else {
            scoutListAllLayers[i].forEach(scout => { 
                embededMessage += '\n\t\t- ' + scout.displayName + ' (since ' + scout.startTime.toLocaleString(undefined, Config.dateFormats.scoutDateFormat) + ')'
            })
        }
    }
    embededMessage += "\n\n " + "You can view the sign up sheet here: " + Config.signupSheetURL + boss.signupSheetURL
    embededMessage += "\n\n For a list a commands type ``" + Config.identifier + Config.commands.normal.listCommands[0] + "``" + " or check the ***Pinned Messages***"

    if (boss.statusMessage != undefined) {
        boss.statusMessage.delete().catch(e => { })
        boss.statusMessage = undefined
    }

    channel.send({
        embed: {
            title: title,
            color: color,
            fields: [{
                name: embededTitle,
                value: embededMessage,
                inline: true
            }],
            timestamp: new Date()
        },
    }).then(newMessage => { boss.statusMessage = newMessage })
}

/**
 * This function is used when a user requests an up-to-date
 * list of all people currently scouting the boss associated
 * with the channel.
 * 
 * @param {Message} message 
 * @param {Boss} boss
 * @param {Boolean} showAll
 */
function showCurrentScouts(message, boss, showAll) {
    logger.info("Command: showCurrentScouts")

    message.delete().catch(e => {})

    if (showAll) {
        logger.info("    (showCurrentScouts) - updating boss status for all bosses")
        Bosses.forEach(b => {
            showBossStatus("Current Scout for " + b.name + ":", b, getGuildFromDisplayName(message.member.displayName).color)
        })
    } else {
        logger.info("    (showCurrentScouts) - updating boss status for " + boss.name)
        showBossStatus("Current Scout for " + boss.name + ":", boss, getGuildFromDisplayName(message.member.displayName).color)
    }
}


// -------------------------- Misc Functions

/**
 * This function shows a list of all the commands for 
 * the bot. Handy!
 * 
 * @param {Message} message 
 * @param {Boolean} showAllCommands show verbose
 * @param {Boolean} showToChannel Whether to send message to channel or DM
 */
function showScoutingCommands(message, showAllCommands, showToChannel) {
    logger.info('Command: showScoutingCommands')

    const title = '---- Commands for ' + Config.botName + ' ----'
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        loggger.error('(showScoutingCommands) - unknown boss with channelId: ' + message.channel.id)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    logger.info("    (showScoutingCommands) - boss type: " + boss.type)

    const helpText = "**" + (showAllCommands ? listAllVariations(Config.commands.normal.beginShift) : Config.identifier + Config.commands.normal.beginShift[0]) + (numberOfLayers > 1 ? (" layer=<layer number> ") : ("")) + "**"
        + "```Register the start of your shift" + (numberOfLayers > 1 ? (' on the given layer.') : ('.')) + " \n\nYou can manually set the starting time by adding it to the end of the command in one of these formats: \n\t\'MM/DD/YYYY HH:MM "
        + 'AM/PM\' \n\t\'HH:MM AM/PM\'```\n\n```(Example: \'' + Config.identifier + Config.commands.normal.beginShift[0] + (numberOfLayers > 1 ? (' layer=2 ') : ('')) + ' 12/18/2020 5:45 PM\')```'
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.normal.endShift) : Config.identifier + Config.commands.normal.endShift[0]) + (numberOfLayers > 1 ? (" layer=<layer number> ") : ("")) + "**"
        + '```Register the end of your shift' + (numberOfLayers > 1 ? (' on the given layer.') : ('.')) + ' \n\nYou can manually set the ending time by adding it to the end of the command in one of these formats: \n\t\'MM/DD/YYYY HH:MM '
        + 'AM/PM\' \n\t\'HH:MM AM/PM\'```\n\n```(Example: \'' + Config.identifier + Config.commands.normal.endShift[0] + (numberOfLayers > 1 ? (' layer=2 ') : ('')) + ' 12/18/2020 5:45 PM\')```'
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.normal.bossSpotted) : Config.identifier + Config.commands.normal.bossSpotted[0]) + " <Character Name>**"
        + '```Notify players that ' + boss.name + ' was spotted. \n\nYou must add a character name to the end of the command, notifying players who they should whisper for an invite.```\n\n```(Example: \''
        + Config.identifier + Config.commands.normal.bossSpotted[0] + ' raidleader\')```'
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.normal.bossKilled) : Config.identifier + Config.commands.normal.bossKilled[0]) + (numberOfLayers > 1 ? (" layer=<layer number> ") : (""))  + /*(boss.type == "Green Dragon" ? " <Dragon Name>" : "") +*/ "**"
        + '```Register that ' + boss.name + ' was killed' + (numberOfLayers > 1 ? (' on the given layer.') : ('.')) +'\n\nYou can manually set the time of death by adding it to the end of the command in one of these formats: \n\t\'MM/DD/YYYY HH:MM '
        + 'AM/PM\' \n\t\'HH:MM AM/PM\'```\n\n```(Example: \'' + Config.identifier + Config.commands.normal.bossKilled[0] + ' 12/18/2020 5:45 PM\')```'
        + '\n**' + (showAllCommands ? listAllVariations(Config.commands.normal.resetBossRespawn) : Config.identifier + Config.commands.normal.resetBossRespawn[0]) + (numberOfLayers > 1 ? (" layer=<layer number> ") : ("")) + '**'
        + '```Resets ' + boss.name + '\'s respawn timer ' + (numberOfLayers > 1 ? (' on the given layer,') : (',')) +' signifying that an unexpected server restart has occurred. ' + boss.name + ' will immediately be available for scouting.```'
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.normal.signUp) : Config.identifier + Config.commands.normal.signUp[0]) + " <Start Date> <End Date>**"
        + "```Signs up for a scouting shift for " + boss.name + " from Start Date until End Date. \n\nDates must be in one of these formats: \n\t'MM/DD/YYYY HH:MM AM/PM' "
        + "\n\t'HH:MM AM/PM'```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.normal.setSummonerLocation) : Config.identifier + Config.commands.normal.setSummonerLocation[0]) + "**"
        + "```Registers a summoner at " + boss.location + ".```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.normal.removeScoutFromList) : Config.identifier + Config.commands.normal.removeSummonerLocation[0]) + "**"
        + "```Removes " + boss.location + " from the list of places you have a summoner at.```"
        + '\n**' + (showAllCommands ? listAllVariations(Config.commands.normal.listCommands) : Config.identifier + Config.commands.normal.listCommands[0]) + '**'
        + '```Show a list of valid commands for the bot.```'

    if (Config.hideCommandMessage) message.delete().catch(e => { })

    if (showToChannel) {
        message.channel.send({
            embed: {
                title: title,
                color: getGuildFromDisplayName(message.member.displayName).color,
                description: helpText
            }
        })
    } else {
        message.author.send({
            embed: {
                title: title,
                color: getGuildFromDisplayName(message.member.displayName).color,
                description: helpText
            }
        })
    }
}


// "**" + (showAllCommands ? listAllVariations(Config.commands.master.changeKeyword) : Config.identifier + Config.commands.master.changeKeyword[0]) + " <newKeyword>**"
//         + "```Changes the secret keyword used for auto-invites. \n\nYou can manually set the starting time by adding it to the end of the command in one of these formats: \n\t\'MM/DD/YYYY HH:MM "
//         + 'AM/PM\' \n\t\'HH:MM AM/PM\'\n\n(Example: \'' + Config.identifier + Config.commands.normal.beginShift[0] + ' 12/18/2020 5:45 PM\')```'

/**
 * This function shows a list of all the master commands
 * for the bot. These are commands available only to
 * admins.
 * 
 * @param {Message} message 
 * @param {Boolean} showAllCommands show verbose
 */
function showMasterCommands(message, showAllCommands) {
    const title = '---- Master Commands for ' + Config.botName + ' ----'
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        loggger.error('(showMasterCommands) - unknown boss with channelId: ' + message.channel.id)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    const helpText = "**" + (showAllCommands ? listAllVariations(Config.commands.master.changeKeyword) : Config.identifier + Config.commands.master.changeKeyword[0]) + " <newKeyword>**"
        + "```Changes the secret keyword used for auto-invites. ```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.master.beginUserShift) : Config.identifier + Config.commands.master.beginUserShift[0])
        + " <id> username: \"<username>\" displayName: \"<displayName>\"**" + "```Begins a shift for the given user (based on Id, username, and displayName). This "
        + "command must be used exactly as shown above (including the quotes).\n\n(Example: '" + Config.identifier + Config.commands.master.beginUserShift[0]
        + " 123456 username: \"someUsername\" displayName: \"someDisplayName\" ')```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.master.endAllShifts) : Config.identifier + Config.commands.master.endAllShifts[0]) + "**"
        + "```Immediately ends all scouting shifts for " + boss.name + " and logs their hours in the attendance sheet.```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.master.endUserShift) : Config.identifier + Config.commands.master.endUserShift[0]) + " <user Id>**"
        + "```Stops the user's (based on Id) shift. \n\nYou can optionally add '" + Config.commands.parameters.silent + "' to the end of the command to suppress the channel message."
        + '\n\nYou can manually set the ending time by adding it to the end of the command in one of these formats: \n\t\'MM/DD/YYYY HH:MM '
        + 'AM/PM\' \n\t\'HH:MM AM/PM\'\n\n(Example: \'' + Config.identifier + Config.commands.master.endUserShift[0] + ' 12/18/2020 5:45 PM\')```'
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.master.resetCalendar) : Config.identifier + Config.commands.master.resetCalendar[0]) + "**"
        + "```Resets the signup calendar for " + boss.name + ". \n\nYou can optionally add '" + Config.commands.parameters.all + "' to the end of the command to reset all boss signup calendars. "
        + "\n\n (Example: ' " + Config.identifier + Config.commands.master.resetCalendar[0] + " " + Config.commands.parameters.all +  "')```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.master.remindRespawn) : Config.identifier + Config.commands.master.remindRespawn[0]) + "**"
        + "```Sends out a reminder that " + boss.name + " will respawn soon.\n\nWARNING: THIS WILL PING EVERYONE```"
        + "\n**" + (showAllCommands ? listAllVariations(Config.commands.master.silentBossKilled) : Config.identifier + Config.commands.master.silentBossKilled[0]) + "**"
        + "```Silently notifies the bot that " + boss.name + " was killed. Use this command if you wish to register a boss kill without sending channel notifications."
        + '\n\nYou can manually set the time of death by adding it to the end of the command in one of these formats: \n\t\'MM/DD/YYYY HH:MM '
        + 'AM/PM\' \n\t\'HH:MM AM/PM\'\n\n(Example: \'' + Config.identifier + Config.commands.master.silentBossKilled[0] + ' 12/18/2020 5:45 PM\')```'

    if (Config.hideCommandMessage) message.delete().catch(e => { })

    message.author.send({
        embed: {
            title: title,
            color: getGuildFromDisplayName(message.member.displayName).color,
            description: helpText
        }
    })
}

// --------------------------------------------------------------
// Google Sheets Functions
// --------------------------------------------------------------

// -------------------------- Calendar Sign Up Functions

const CAL_HEADER_LENGTH = 7
const BOTTOM_CELL = 47 + CAL_HEADER_LENGTH

function getCalendarCell(time, week) {
    //logger.info('    (getCalendarCell) - hours = ' + time.getHours())
    //logger.info('    (getCalendarCell) - minutes = ' + time.getMinutes())

    var cellNumber = getCellNumber(time)

    var cellRow = ""
    switch (time.getDay()) {
        // Sunday
        case 0:
            cellRow = week == 1 ? "G" : "N"
            break
        // Monday
        case 1:
            cellRow = week == 1 ? "H" : "0"
            break
        // Tuesday
        case 2:
            cellRow = week == 1 ? "B" : "I"
            break
        // Wednesday
        case 3:
            cellRow = week == 1 ? "C" : "J"
            break
        // Thursday
        case 4:
            cellRow = week == 1 ? "D" : "K"
            break
        // Friday
        case 5:
            cellRow = week == 1 ? "E" : "L"
            break
        // Saturday
        case 6:
            cellRow = week == 1 ? "F" : "M"
            break
    }

    return cellRow + cellNumber
}

/**
 * Blacks out the boss calendar, indicating that the world boss
 * does not need to be scouted during the black out period.
 * 
 * @param {String} sheetName Name of boss's signup sheet
 * @param {Date} killedDate Date the boss was killed
 * @param {Date} nextRespawnDate Date the boss is expected to be spawnable again 
 */
function blackOutCalendar(sheetName, killedDate, nextRespawnDate) {
    const startCellNumber = getCellNumber(killedDate)
    const endOfWeekOne = getNextTuesday(new Date()).getTime() - 60 * 60 * 7 * 1000
    const startCell = getCalendarCell(killedDate, killedDate.getTime() >= endOfWeekOne ? 2 : 1)
    const endCellNumber = getCellNumber(nextRespawnDate)
    const endCell = getCalendarCell(nextRespawnDate, nextRespawnDate.getTime() >= endOfWeekOne ? 2 : 1)


    if (startCell.charAt(0) != endCell.charAt(0)) {
        //logger.info('    (blackOutCalendar) - Spans over multiple columns... ' + startCell.charAt(0) + ' to ' + endCell.charAt(0))
        blackOutCells(sheetName, startCell, startCell.charAt(0) + BOTTOM_CELL, BOTTOM_CELL - startCellNumber + 1)

        let colLetter = String.fromCharCode(startCell.charCodeAt(0) + 1)
        while (colLetter.charCodeAt(0) < endCell.charCodeAt(0)) {
            //logger.info('    (blackOutCalendar) - Blacking out column ' + colLetter)
            blackOutCells(sheetName, colLetter + '' + CAL_HEADER_LENGTH, colLetter + BOTTOM_CELL, BOTTOM_CELL - CAL_HEADER_LENGTH + 1)
            colLetter = String.fromCharCode(colLetter.charCodeAt(0) + 1)
        }

        blackOutCells(sheetName, endCell.charAt(0) + '' + CAL_HEADER_LENGTH, endCell, endCellNumber - CAL_HEADER_LENGTH + 1)
    } else {
        blackOutCells(sheetName, startCell, endCell, endCellNumber - startCellNumber + 1)
    }
}

/**
 * Helper Function
 * 
 * Blacks out all cells for the given sheet between the
 * startingCell and the endingCell (based on blackoutPeriod)
 * 
 * @param {String} sheetName Name of sheet to black out
 * @param {String} startingCell Begininng of black out period
 * @param {String} endingCell End of black out period
 * @param {Number} blackoutPeriod The number of cells between startingCell
 *  and endingCell. This should match up, logically, to the number of cells
 *  between the former paramters.
 */
function blackOutCells(sheetName, startingCell, endingCell, blackoutPeriod) {
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const sheetRange = sheetName + '!' + startingCell + ':' + endingCell

    logger.info('    (blackOutCells) - blacking out ' + startingCell + ' to ' + endingCell)

    const newCellValues = []
    for (i = 0; i < blackoutPeriod; i++) {
        newCellValues.push(["- DEAD -"])
    }

    sheets.spreadsheets.values.update({
        spreadsheetId: Config.sheets.calendarSheet.id,
        range: sheetRange,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: newCellValues
        },
    }, (err, res) => {
        if (err) return logger.error('(blackOutCalendar) - ERROR: update returned: ' + err)
    })
}

/**
 * Helper Function
 * 
 * Appends the scout to the signup sheet for the given cell(s).
 * 
 * @param {String} sheetName Name of boss's signup sheet
 * @param {String} startingCell 
 * @param {String} endingCell
 * @param {Number} scoutingPeriod
 * @param {String} displayName
 */
async function addCalendarShift(sheetName, startingCell, endingCell, scoutingPeriod, displayName) {
    const sheetRange = sheetName + '!' + startingCell + ':' + endingCell
    const sheets = google.sheets({ version: 'v4', auth: newAuth })

    sheets.spreadsheets.values.get({
        spreadsheetId: Config.sheets.calendarSheet.id,
        range: sheetRange,
    }, (err, res) => {
        if (err) return logger.error('(addCalendarShift) - The get request returned an error: ' + err)

        // update cellValues with username
        let newCellValues = []
        const cellValues = res.data.values
        const separator = Config.sheets.calendarSheet.separator

        //const scoutingPeriod = getCellNumber(endTime) - getCellNumber(scout.startTime) + 1

        // Get updated cell values during entire shift
        for (i = 0; i < scoutingPeriod; i++) {
            if (cellValues != undefined && cellValues[i] != undefined) {
                const row = cellValues[i]
                if (row[0] == undefined) {
                    //logger.info('    (addCalendarShift) - Adding a new scout!')
                    newCellValues.push([displayName])
                } else {
                    const scoutsInCell = row[0].split(separator)
                    if (scoutsInCell.includes(displayName)) {
                        //logger.info('    (addCalendarShift) - Is already included!')
                        newCellValues.push([row[0]])
                    } else {
                        //logger.info('    (addCalendarShift) - appending... now ' + newVal)
                        newCellValues.push([
                            row[0].concat(row[0].length > 0 ? separator + displayName : displayName)
                        ])
                        //logger.info('    (addCalendarShift) - now: ' + newCellValues[newCellValues.length - 1])
                    }
                }
            } else {
                newCellValues.push([displayName])
            }
        }

        // send update request
        sheets.spreadsheets.values.update({
            spreadsheetId: Config.sheets.calendarSheet.id,
            range: sheetRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: newCellValues
            },
        }, (err, res) => {
            if (err) return console.log('(addCalendarShift) - The update request returned an error: ' + err)
        })
    })
}

/**
 * Adds the user to the sign up calendar for all slots within
 * passedStartDate and passedEndDate. This function can be used
 * for both current scouts and future sign ups.
 * 
 * @param {Scout} scout The scout being added
 * @param {Boss} boss The boss the user is/wil be scouting
 * @param {Date} passedStartDate (optional) beginning of the player's scouting period.
 *  If undefined, the current time is assumed.
 * @param {Date} passedEndDate (optional) end of the player's scouting period.
 *  If undefined, the current time is assumed.
 * @param {Boolean} startInterval Whether or not to start a reoccuring interval
 *  that will automatically add the player to the calendar for every 30 minutes
 *  scouting. 
 */
function addScoutToCalendar(scout, boss, passedStartDate, passedEndDate, startInterval) {
    const startDate = passedStartDate == undefined ? new Date() : passedStartDate
    const endDate = passedEndDate == undefined ? new Date() : passedEndDate

    const endOfWeekOne = getNextTuesday(new Date()).getTime() - 60 * 60 * 7 * 1000
    const startWeek = startDate.getTime() >= endOfWeekOne ? 2 : 1
    const endWeek = endDate.getTime() >= endOfWeekOne ? 2 : 1
        
    const startCellNumber = getCellNumber(getServerDate(startDate))
    const startCell = getCalendarCell(getServerDate(startDate), startWeek)
    const endCellNumber = getCellNumber(getServerDate(endDate))
    const endCell = getCalendarCell(getServerDate(endDate), endWeek)

    if (startCell.charAt(0) != endCell.charAt(0)) {
        //logger.info('    (addShiftToSheet) - Need to split shift into two requests...')

        addCalendarShift(boss.sheetName, startCell, startCell.charAt(0) + '51', 51 - startCellNumber + 1, scout.displayName)
        addCalendarShift(boss.sheetName, endCell.charAt(0) + '' + CAL_HEADER_LENGTH, endCell, endCellNumber - CAL_HEADER_LENGTH + 1, scout.displayName)                    //todo - replace this line with recursive implementation
    } else {
        //logger.info('    (addShiftToSheet) - Updating sheet in one request...')
        addCalendarShift(boss.sheetName, startCell, endCell, endCellNumber - startCellNumber + 1, scout.displayName)
    }


    logger.info("    (addScoutToCalendar) - added " + scout.displayName + " (" + scout.userId + ") to scouting calendar for " + boss.name
        + " (cells " + startCell + " - " + endCell + ")")

    // Update every 30 minutes - ensures user gets put into next calendar block
    const intervalTime = 30 * 60 * 1000
    if (startInterval && scout != undefined)
        scout.calendarId = setTimeout(addScoutToCalendar, intervalTime, scout, boss, undefined, undefined, true)
}

/**
 * Resets the sign up calendar for the given boss. Also applies
 * the new week ranges text at the top.
 * 
 * @param {Boss} boss 
 * @param {String} firstWeekText Date range for first week
 * @param {String} secondWeekText Date range for second week
 */
function resetCalendar(boss, firstWeekText, secondWeekText) {
    const sheets = google.sheets({ version: 'v4', auth: newAuth })

    sheets.spreadsheets.values.get({
        spreadsheetId: Config.sheets.calendarSheet.id,
        range: boss.sheetName + '!I' + CAL_HEADER_LENGTH + ':O' + (CAL_HEADER_LENGTH + 47)
    }, (err, res) => {
        if (err) return logger.error('    (resetCalendar) - The get request returned an error: ' + err)

        // Update Spawn Window Text
        updateCalendarRespawnWindowText(boss, new Date(0))

        // Update Week Date Texts
        logger.info("    (resetCalendar) - updating " + boss.sheetName + "'s week texts to (" + firstWeekText + ") (" + secondWeekText + ")")
        sheets.spreadsheets.values.update({
            spreadsheetId: Config.sheets.calendarSheet.id,
            range: boss.sheetName + "!B5:I5",
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[firstWeekText, '', '', '', '', '', '', secondWeekText]]
            }
        }, (err, res) => {
            if (err) return logger.error("    (resetCalendar) - The week date update request returned an error: " + err)
        })

        // Reset Calendar Cells 
        let signupWeek2Rows = res.data.values
        if (signupWeek2Rows == undefined) {
            //logger.info('    (resetCalendar) - no input found for week 2 of ' + boss.sheetName)
            signupWeek2Rows = []
            for (i = 0; i < 47; i++)
                signupWeek2Rows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', ''])
        } else {
            logger.info('    (resetCalendar) - weeek2 rows length = ' + signupWeek2Rows.length)
            let rowIndex = 0
            for (row of signupWeek2Rows) {
                for (i = 0; i < row.length; i++) {
                    if (row[i] == '- DEAD -' && (i > 0 || rowIndex > 14))
                        row[i] = ''
                }
                row.push('', '', '', '', '', '', '')
                rowIndex++
            }
        }

        const sheetRange = boss.sheetName + '!B' + CAL_HEADER_LENGTH + ':O' + (CAL_HEADER_LENGTH + 47)
        logger.info("    (resetCalendar) - clearing " + sheetRange)
        sheets.spreadsheets.values.clear({
            spreadsheetId: Config.sheets.calendarSheet.id,
            range: sheetRange
        }, (err, res) => {
            if (err) return logger.error("    (resetCalendar) - The clear request returned an error: " + err)

            // send update request
            sheets.spreadsheets.values.update({
                spreadsheetId: Config.sheets.calendarSheet.id,
                range: sheetRange,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: signupWeek2Rows
                }
            }, (err, res) => {
                if (err) return logger.error('    (resetCalendar) - The update request returned an error: ' + err)
            })
        })
    })
}

/**
 * Updates the "Can spawn at " text in the given boss's
 * sign up calendar.
 * 
 * @param {Boss} boss 
 * @param {Date} nextRespawn 
 */
function updateCalendarRespawnWindowText(boss, nextRespawn) {
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const spawnWindowText = nextRespawn < new Date()
        ? "Can Spawn!"
        : nextRespawn.toLocaleString("en-US", Config.sheets.calendarSheet.spawnWindowFormat)
    sheets.spreadsheets.values.update({
        spreadsheetId: Config.sheets.calendarSheet.id,
        range: boss.sheetName + "!B4",
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[spawnWindowText]]
        },
    }, (err, res) => {
        if (err) return logger.error('(updateCalendarRespawnWindowText) - ERROR: update returned: ' + err)
    })

}

/**
 * Resets the sign up calendars for all Bosses.
 */
function resetCalendars() {
    logger.info('    (resetCalendars) - reseting ' + (Bosses.length + 1) + ' signup sheets')
    let weekTexts = getWeekTexts()
    const clearedRows = []
    for (i = 0; i < 47; i++)
        clearedRows.push(['', '', '', '', '', '', '', '', '', '', '', '', '', ''])

    for (boss of Bosses) {
        resetCalendar(boss, weekTexts[0], weekTexts[1])
    }
}

// -------------------------- Attendance Sheet Functions

const TOTAL_HOURS_HEADER = 3
const LAST_WEEKS_HEADER = 2
/**
 * Resets the weekly hours for guilds on the attendance sheet.
 */
function resetAttendanceSheet() {
    logger.info('    (resetAttendanceSheet) - reseting attendace hours for the week. (' + Guilds.length + ' guilds found)')
    const attendanceSheet = Config.sheets.attendanceSheet

    // Get total scouting hours
    const totalHoursRangeStart = attendanceSheet.headerRows + TOTAL_HOURS_HEADER + Guilds.length * 2 // 3 + 3 + 6*2 = 18
    const totalHoursRange = attendanceSheet.name + "!B" + totalHoursRangeStart + ":B" + (totalHoursRangeStart + Guilds.length - 1)
    logger.info("    (resetAttendanceSheet) - totalHoursRange: " + totalHoursRange)

    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    sheets.spreadsheets.values.get({
        spreadsheetId: attendanceSheet.id,
        range: totalHoursRange,
    }, (err, res) => {
        if (err) return logger.error('(resetAttendanceSheet) - Total Hours get request returned an error: ' + err)

        const totalHoursRows = res.data.values

        // Get this week's hours
        const thisWeeksHoursRange = attendanceSheet.name + "!B" + (attendanceSheet.headerRows + 1) + ":B" + (attendanceSheet.headerRows + Guilds.length)
        sheets.spreadsheets.values.get({
            spreadsheetId: attendanceSheet.id,
            range: thisWeeksHoursRange
        }, (err, res) => {
            if (err) return logger.error('(resetAttendanceSheet) - This Week\'s Hours get request returned an error: ' + err)

            const thisWeeksHoursRows = res.data.values
            if (thisWeeksHoursRows == undefined)
                return logger.error('(resetAttendanceSheet) - couldn\'t fetch This Week\'s Hours...')

            // Copy this week's hours to last week's hours
            let lastWeeksRangeStart = Guilds.length + attendanceSheet.headerRows + LAST_WEEKS_HEADER // 7 + 3 + 2 = 11
            const lastWeeksHoursRange = attendanceSheet.name + "!B" + lastWeeksRangeStart + ":B" + (lastWeeksRangeStart + Guilds.length - 1) // 11 + 7 - 1 = 16
            logger.info("    (resetAttendanceSheet) - lastWeeksHoursRange: " + lastWeeksHoursRange)
            sheets.spreadsheets.values.update({
                spreadsheetId: attendanceSheet.id,
                range: lastWeeksHoursRange,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: thisWeeksHoursRows
                }
            })
        })

        // Copy total hours into previous hours
        const prevHoursRange = attendanceSheet.name + "!B52:" + "B" + (51 + Guilds.length)
        sheets.spreadsheets.values.update({
            spreadsheetId: attendanceSheet.id,
            range: prevHoursRange,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: totalHoursRows
            }
        }, (err, res) => {
            if (err) return logger.error('(resetAttendanceSheet) - Last week\'s update request returned an error: ' + err)
        })
    })
}

/**
 * Gets a list of all attendance info from 'Attendance' sheet and populates a list of scouting info
 * for the guild corresponding to guildNumber. This info is used to keep track of everyone's
 * hours spent scouting world Bosses. It also shows which players have summoning alts at
 * each world boss.
 * 
 * @param {Number} guildNumber Guild position in config array.
 * @param {([[]]) => {}} onComplete Function to run after done fetching guild info.
 */
async function fetchGuildScoutingHours(guildNumber, onComplete) {
    // Constants for this guild's sheet info
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const guildPos = getGuildColumnStart(guildNumber)
    const startingCellLetter = columnToLetter(guildPos)
    const endingCellLetter = columnToLetter(guildPos + guildRowLength() - 1)
    const sheetInfo = Config.sheets.attendanceSheet
    const sheetRange = sheetInfo.name + '!' + startingCellLetter + sheetInfo.headerRows + ':' + endingCellLetter
    logger.info('    (fetchGuildScoutingHoursSync) - Getting data for guild ' + guildNumber + ' with range: ' + sheetRange)

    sheets.spreadsheets.values.get(
        {
            spreadsheetId: sheetInfo.id,
            range: sheetRange,
        }, (err, res) => {
            if (err) return logger.info('    (fetchGuildScoutingHours) - The get request returned an error ' + err)

            const rows = res.data.values
            // Check to see if there are any rows for guild
            if (rows == undefined || rows.length < 1) {
                // No sheet info found for guild
                //logger.info('    (fetchGuildScoutingHours) - Couldn\'t fetch attendance info for ' + Guilds[guildNumber].name + '... no rows found!')
                if (onComplete != undefined)
                    onComplete([])
                return undefined
            }

            // Add guild info to list
            //logger.info('Got ' + Guilds[guildNumber].name + '\'s data: ' + rows)
            onComplete(rows)
            return undefined
        }
    )
}

/**
 * Fetches the correct guild's attendance info and looks for
 * the user's row. If no row is found, the row will be undefined
 * and the rowNumber will be set to -1. If any error occurs while
 * fetching the guild attendance info, the entire result will be
 * undefined.
 * 
 * @returns An array containing the row, rowNumber, and guildPosition 
 *          OR undefined
 * 
 * @param {String} id The desired user's discord id.
 * @param {String} displayName The desired user's display name (used for finding guild tag).
 * @param {() => {}} onComplete Function to run when info is succesfully fetched
 * 
 */
async function getUserAttendanceInfo(id, displayName, onComplete) {
    // User's guild
    const guildPos = getGuildPosition(displayName)
    if (guildPos == undefined) {
        logger.info('    (getUserAttendanceInfo) - failed to get guild position...')
        if (onComplete != undefined) onComplete([])
        return undefined
    }
    // Guild sheet info
    fetchGuildScoutingHours(guildPos, (guildSheetInfo) => {
        if (guildSheetInfo == undefined) {
            logger.info('    (getUserAttendanceInfo) - didn\'t find any guild sheet info...)')
            if (onComplete != undefined) onComplete([])
            return undefined
        }
        let sheetInfo = guildSheetInfo.slice()

        // Find row - if no row exists, rowNumber will be -1 and cause row to be undefined
        const rowNumber = getUserRowNumber(id, sheetInfo)
        logger.info('    (getUserAttendanceInfo) - rowNumber = ' + rowNumber)
        const row = rowNumber == -1 ? undefined : sheetInfo[rowNumber - Config.sheets.attendanceSheet.headerRows]
        //logger.info('(getUserAttendanceInfo) - row = ' + row + ' (length = ' + (row == undefined ? 0 : row.length) + ')')

        if (onComplete != undefined)
            onComplete([row, rowNumber, guildPos, sheetInfo.length])

        return [row, rowNumber, guildPos, sheetInfo.length]
    })
}

/**
 * Creates a new row for a never-before-seen scout in the Attendance Google Sheet.
 * The guildPos determines which guild the new scout is associated with.
 * 
 * @param {Number} guildPos 
 * @param {Number} rowNumber 
 * @param {String} username 
 * @param {String} displayName 
 * @param {String} id 
 * @param {String} summonerLocations 
 */
function createNewAttendanceRow(guildPos, rowNumber, username, displayName, id, summonerLocations) {
    const attendanceSheet = Config.sheets.attendanceSheet

    var newRow = [username, displayName, id]

    for (boss of Bosses)
        newRow.push(0)

    // Create SUM cell
    const startBossColumnLetter = columnToLetter(getGuildColumnStart(guildPos) + attendanceSheet.columnsBeforeBosses)
    const endBossColumnLetter = columnToLetter(getGuildColumnStart(guildPos) + attendanceSheet.columnsBeforeBosses + Bosses.length - 1)
    newRow.push('=SUM(' + startBossColumnLetter + rowNumber + ':' + endBossColumnLetter + rowNumber + ')')

    // Create empty 'Summoner(s) Location' cell
    newRow.push(summonerLocations)

    return newRow
}

/**
 * Adds the specified number of hours to the
 * player's total hours spent scouting. If
 * no row is found for the player, a new
 * row is added.
 * 
 * @param {Scout} scout 
 * @param {Date} endTime 
 * @param {Message} message 
 * @param {() => {}} onComplete 
 */
async function logHours(scout, endTime, message, onComplete) {
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const attendanceSheet = Config.sheets.attendanceSheet
    const channelId = message.channel.id

    // Calculated time spent scouting
    const timeSpent = Math.round((Math.abs(scout.startTime - endTime) / 36e5) * 100) / 100

    logger.info("    (logHours) - logging " + timeSpent + " hours for " + scout.displayName)

    // Discord user
    bot.fetchUser(scout.userId).then(user => {
        if (user == undefined) {
            notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
            return logger.info('    (logHours) - failed to get user from userId: ' + scout.userId)
        }
    
        // Boss scouted
        const loggedBoss = Bosses.find(b => b.channelId == channelId)
        if (loggedBoss == undefined) {
            notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
            return logger.info('    (logHours) - failed to get boss from channelId: ' + channelId)
        }
    
        // Boss Position
        let bossPosition = Bosses.findIndex(b => b.name == loggedBoss.name)
        if (bossPosition == -1) {
            notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
            return logger.info('    (logHours) - failed to find boss position for ' + loggedBoss.name)
        }
    
        //logger.info('    (logHours) - User ' + scout.displayName + ' spent ' + timeSpent + ' hours scouting ' + loggedBoss.name + '.')
    
        // Attempt to get existing user's info
        getUserAttendanceInfo(scout.userId, scout.displayName, (userAttendanceInfo) => {
            logger.info('    (logHours) - userAttendanceInfo: ' + userAttendanceInfo)
    
            if (userAttendanceInfo.length == 0) {
                notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
                return logger.info('    (logHours) - failed to get guild sheet info')
            }
    
            if (userAttendanceInfo[0] == undefined) {
                // First-time user -> create new row
                logger.info("    (logHours) - no row found for " + scout.displayName + " (" + scout.userId + "). Creating a new row")
    
                rowNumber = userAttendanceInfo[3] + attendanceSheet.headerRows
                guildPos = getGuildPosition(scout.displayName)
                if (guildPos == undefined) return notifyUserHasInvalidGuildTag(message)
    
                // Create new row
                let newRow = createNewAttendanceRow(guildPos, rowNumber, user.username, scout.displayName, scout.userId, 'N/A')
    
                // Update loggedBoss's hours
                newRow[attendanceSheet.columnsBeforeBosses + bossPosition] = timeSpent
    
                // Add entire row to sheet
                const startColumnLetter = columnToLetter(getGuildColumnStart(guildPos))
                const endColumnLetter = columnToLetter(getGuildColumnStart(guildPos) + guildRowLength() - 1)
                const sheetRange = attendanceSheet.name + '!' + startColumnLetter + rowNumber + ':' + endColumnLetter + rowNumber
    
                if (Config.debug.disableAttendanceUpdates) return logger.info('    (logHours) - DEBUG: suppressing update')
    
                sheets.spreadsheets.values.update(
                    {
                        spreadsheetId: attendanceSheet.id,
                        range: sheetRange,
                        valueInputOption: 'USER_ENTERED',
                        resource: {
                            values: [newRow]
                        },
                    }, (err, res) => {
                        if (err) return logger.error('(logHours) - The update request returned an error: ' + err)
                        //logger.info('    (logHours) - Added ' + timeSpent + ' hours for ' + scout.displayName + " (" + scout.userId + ")")
                        if (onComplete != undefined)
                            onComplete()
                    })
            } else {
                // Existing user -> update existing row
                let row = userAttendanceInfo[0]
                let rowNumber = userAttendanceInfo[1]
                let guildPos = userAttendanceInfo[2]
    
                // Find cell location for loggedBoss, also get the current scouting time for loggedBoss
                let bossCellPos = attendanceSheet.columnsBeforeBosses
                let updatedTime = timeSpent
                for (i = 0; i < Bosses.length; i++) {
                    if (loggedBoss.name == Bosses[i].name) {
                        bossCellPos += i
                        let extraTime = parseFloat(row[bossCellPos])
                        updatedTime += isNaN(extraTime) ? 0 : extraTime
                        bossCellPos += getGuildColumnStart(guildPos)
                        break
                    }
                }
    
                // Get boss cell (columnLetter rowNumber)
                let bossCell = columnToLetter(bossCellPos) + rowNumber
                logger.info('    (logHours) - Updating bossCell found at ' + bossCell)
    
                if (Config.debug.disableAttendanceUpdates) return logger.info('    (logHours) - DEBUG: suppressing update')
    
                // Add new boss scouting hours to existing row
                sheets.spreadsheets.values.update(
                    {
                        spreadsheetId: attendanceSheet.id,
                        range: attendanceSheet.name + '!' + bossCell,
                        valueInputOption: 'USER_ENTERED',
                        resource: {
                            values: [[updatedTime]]
                        },
                    }, (err, res) => {
                        if (err) return logger.error('(logHours) - The update request returned an error: ' + err)
                        logger.info('    (logHours) - Changed ' + bossCell + ' scouting time to ' + updatedTime.toFixed(2) + ' hours for ' + scout.displayName + " (" + scout.userId + ")")
                        if (onComplete != undefined)
                            onComplete()
                    })
            }
        })
    })
}

// -------------------------- Boss Logs Functions

async function updateBossLogs(Time, Boss, Event, Layer) {
    logger.info('    (updateBossLogs) - adding ' + Event + ' of ' + Boss + ' at ' + Time + ' on layer ' + Layer)
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const sheetName = Config.bossLogs.sheetName
    sheets.spreadsheets.values.get(
        {
            spreadsheetId: Config.sheets.attendanceSheet.id,
            range: sheetName + "!A2:D",
        }, (err, res) => {
            if (err) return logger.error("(updateBossLogs) - The get request returned an error: " + err)

            let nextRowNumber = res.data.values != undefined ? res.data.values.length + 2 : 2

            logger.info("    (updateBossLogs) - next row number = " + nextRowNumber)

            sheets.spreadsheets.values.update(
                {
                    spreadsheetId: Config.sheets.attendanceSheet.id,
                    range: sheetName + '!A' + nextRowNumber + ":D" + nextRowNumber,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [[Time, Boss, Event, Layer]]
                    }
                }, (err, res) => {
                    if (err) return logger.error("(updateBossLogs) - The update request returned an error: " + err)
                }
            )
        })
}

// -------------------------- Generic Sheets Functions

/**
 * Resets all Google Sheets (Sign up calendars and attendance sheet).
 */
function resetSheets() {
    logger.info("command: resetSheets")

    resetCalendars()

    resetAttendanceSheet()

    // Get time for next Tuesday reset
    const nextTuesday = getNextTuesday(new Date())
    const resetDuration = nextTuesday.getTime() - Date.now()

    logger.info("    (resetSheets) - Sheets will be reset again on: " + nextTuesday.toLocaleString('en-US', Config.dateFormats.killedDateFormat) + " ("
        + (resetDuration / (1000 * 60 * 60)).toFixed(2) + " hours)")

    // Set next reset timeout
    setTimeout(resetSheets, nextTuesday.getTime() - Date.now())
}

// --------------------------------------------------------------
// Discord Action Handlers
// --------------------------------------------------------------

// -------------------------- Normal Action Handlers

 /**
  * Command: !start 
  * 
  * Registers a user has begun scouting the given boss.
  * 
  * @param {*} message 
  * @param {*} startDate Date/Time the user begun scouting
  * @param {*} scoutList The list(s) associated with the boss the user is scouting
  * @param {*} layer The layer the scout is scouting on
  */
function beginShift(message, startDate, scoutList, layer) {
    logger.info("command: beginShift")
    logger.info("    (beginShift) - " + message.member.displayName + " has begun a shift. (" + message.author.id + ")")

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
        return loggger.error('(beginShift) - unknown boss with channelId: ' + message.channel.id)
    }

    // Notify channel about new scout
    const scoutGuild = getGuildFromDisplayName(message.member.displayName)
    if (scoutGuild == undefined) return notifyDiscordBotError(message, "You must add your guild name to your Discord nickname before using this bot.")

    let title = scoutGuild.sayings != undefined
        ? scoutGuild.sayings[getRandomInt(0, scoutGuild.sayings.length - 1)].replace("%s", message.member.displayName).replace("%b", boss.name + (numberOfLayers > 1 ? (" on layer " + layer) :  "."))
        : message.member.displayName + ' started scouting ' + boss.name + (numberOfLayers > 1 ? (" on layer " + layer + ".") : ".")

    let newScout = {
        userId: message.author.id,
        displayName: message.member.displayName,
        startTime: startDate,
        nickname: undefined,
        checkInID: setInterval(checkInOnScout, Config.checkInInterval, message.author.id),
        calendarId: undefined
    }

    logger.info('    (beginShift) - ' + newScout.displayName + ' (' + newScout.userId + ') started scouting ' + boss.name + ' at ' + newScout.startTime.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    scoutList[layer-1].set(newScout.userId, newScout)

    showBossStatus(title, boss, scoutGuild.color)

    if (!Config.debug.disableSignupsUpdates)
        addScoutToCalendar(newScout, boss, startDate, new Date(), true)   
}

/**
 * Command: !stop
 * 
 * @param {Message} message 
 * @param {Scout} scout 
 * @param {Boss} boss 
 * @param {Number} layer
 * @param {Date} endTime 
 * @param {Map} scoutList 
 * @param {Boolean} doSilently 
 * @param {() => {}} onComplete 
 */
function endShift(message, scout, boss, layer, endTime, scoutList, doSilently, onComplete) {
    logger.info("command: endShift (layer " + layer + ")")

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    // Get scout user info
    bot.fetchUser(scout.userId).then(user => {
        if (user == undefined) {
            notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
            return logger.error("(endShift) - ERROR: couldn't find user with id " + scout.userId)
        }
    
        // Check for valid range
        if (scout.startTime > endTime) {
            logger.error('(endShift) - ERROR: player ' + scout.displayName + ' (' + scout.userId + ') has a startTime that was greater than the endTime!')
            if (!doSilently)
                return notifyInvalidDate(message)
            else
                return
        }
    
        logger.info("    (endShift) - " + scout.displayName + " has ended their shift at " + endTime.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    
        logger.info("scoutList.size = " + scoutList.size)
        // Attendance Sheet Logic
        if (!Config.debug.disableAttendanceUpdates)
            logHours(scout, endTime, message, () => {
                logger.info("    (endShift) - clearing up scout " + scout.displayName)
                removeScoutFromList(message, boss, layer, scout, scoutList, doSilently, onComplete)
            })
        else {
            logger.info("    (endShift) - DEBUG: ignoring attendance update")
            logger.info("    (endShift) - clearing up scout " + scout.displayName)
            removeScoutFromList(message, boss, layer, scout, scoutList, doSilently, onComplete)
        }
    
        // Sign Up Sheet Logic
        if (!Config.debug.disableSignupsUpdates) {
            addScoutToCalendar(scout, boss, endTime, endTime, false)
            clearTimeout(scout.calendarId)
            scout.calendarId = undefined
        }
        else
            logger.info('    (endShift) - DEBUG: ignoring schdule sheet')
    })
}

function removeScoutFromList(message, boss, layer, scout, scoutList, doSilently, onComplete) {
    // Remove scout
    clearInterval(scout.checkInID)
    clearInterval(scout.calendarId)
    scoutList.delete(scout.userId)

    // Notify channel about scout leaving
    if (!doSilently){
        showBossStatus(scout.displayName + ' is leaving ' + boss.name + (numberOfLayers > 1 ? (" on layer " + layer + ".") : "."), 
            boss, 
            getGuildFromDisplayName(scout.displayName).color)
    }
    if (onComplete != undefined)
        onComplete()
}


/**
 * Command: !up
 * 
 * Attempts to find a character name and warn
 * the coalition that a boss has spawned.
 * 
 * @param {any} message The message spawning this action.
 * @param {any} args Can contain the character name players
 *                   should whisper for an invite
 * @param {String} command 
 * @param {Boss} boss
 * @param {Number} layer
 */
function bossSpotted(message, args, command, boss, layer) {
    logger.info("command: bossSpotted")
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    if (boss.up[layer] == undefined)
        boss.up[layer] = message.createdAt.toLocaleString("en-US", Config.dateFormats.killedDateFormat)

    const characterName = args[0]
    if (characterName == undefined) {
        return notifyDiscordBotError(message, "I didn't understand your last command: `" + Config.identifier + command + args.join(' ')
            + "`. \n**Make sure you add the name of the character people should whisper for an invite.**\n\nExample: `"
            + Config.identifier + command + " Yournamehere`"
            + '\n-----------------------------------------------------------------------------------------')
    }

    //logger.info('character name = ' + characterName)
    notifyBossUp(message, characterName)
    showAllBossStatus(":exclamation:" + boss.name + (numberOfLayers > 1 ? (" on layer " + layer ) : "" ) + " has spawned!:exclamation:")
}

/**
 * Command: !reset
 * 
 * Resets the spawn counter for the boss associated with the
 * message's channel id.
 * 
 * @param {Boss} boss
 * @param {Boolean} suppressNotification
 * @param {Number} layer The layer of the boss that is respawning
 */
function resetBossRespawn(boss, suppressNotification, layer) {
    logger.info('command: Reset Boss Respawn')
    const bossChannel = bot.channels.find(c => c.id == boss.channelId)
    const worldBossAlertChannel = bot.channels.find(c => c.id == Config.worldBossAlertChannelId)

    const shouldNotify = bossKilledOnAllLayers(boss)

    boss.killedAt[layer-1] = undefined
    boss.dead[layer-1] = undefined
    if (boss.respawnTimer[layer-1] != undefined)
        clearTimeout(boss.respawnTimer[layer-1])
    boss.respawnTimer[layer-1] = undefined

    if (boss.type == "Green Dragon") {
        GreenDragonsKilled[layer-1] -= 1
        if (GreenDragonsKilled[layer-1] < 0) {
            logger.error("(resetBossRespawn) - GreenDragonsKilled on layer " + layer + " was set to a value below 0! (" + GreenDragonsKilled[layer-1] + ")")
            GreenDragonsKilled = 0 
        }
    }

    if (!Config.debug.disableBossLogsUpdates)
        updateBossLogs(new Date(Date.now() + 3600000 * Config.utc_offset).format(Config.bossLogs.datePattern), boss.name, "RESPAWN", layer)

    let respawnTitle = boss.name + " can spawn " + (numberOfLayers > 1 ? ("on layer " + layer + "!") : ("!"))

    if (!Config.debug.notifications.disableBossReset && !suppressNotification && shouldNotify){
        bossChannel.send('@here').then(newMessage => { showBossStatus(respawnTitle, boss, Config.alertColor) })
        worldBossAlertChannel.send('@here').then(newMessage => { showAllBossStatus(respawnTitle) })
    }
    
    else {
        showBossStatus(respawnTitle, boss, Config.alertColor)
        showAllBossStatus(respawnTitle)  
    }
        

    if (!Config.debug.disableSignupsUpdates)
        updateCalendarRespawnWindowText(boss, new Date(0))
}

 /**
  * Command: !killed
  * 
  * Notifies the bot that the boss associated with the
  * message's channel id has been killed.
  * 
  * @param {*} message 
  * @param {String[]} args 
  * @param {Boolean} doSilently 
  * @param {Boolean} updateBossKillsLog 
  * @param {Boolean} forceKillUpdate 
  * @param {Map} scoutingList 
  * @param {Number} layer 
  */
function bossKilled(message, args, doSilently, updateBossKillsLog, forceKillUpdate, scoutingList, layer) {
    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    // Determining layer
    let layerIndex = layer-1

    // get boss
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        logger.error("(bossKilled) - Unabled to find boss for channel " + message.channel.id)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    if (boss.dead[layerIndex] != undefined && !forceKillUpdate) {
        notifyDiscordBotError(message, "\n**" + boss.name + "** was already registered as killed on *layer " + layer + "* at **" + boss.killedAt[layerIndex].toLocaleString("en-US", Config.dateFormats.killedDateFormat) 
            + "**. If you believe this is in error, please try the command again by adding `" + Config.commands.parameters.force + "` to the *beginning of the command*.\n\nFor example: ` "
            + Config.identifier + Config.commands.normal.bossKilled[0] + " " + Config.commands.parameters.force + " " + args.join(' ') + "`")
        return logger.info("    (bossKilled) - " + boss.name + " was already registered as killed on layer " + layer + ". (killed at: " + boss.killedAt[layerIndex].toLocaleString("en-US", Config.dateFormats.killedDateFormat) + ")")
    }
        

    // concatenate arguments to form killed time date string
    const killedTimeParam = args.join(' ')
    if (killedTimeParam == undefined) {
        logger.info('    (bossKilled) - error: killedTimeParam was undefined')
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    // parse any user-entered date
    let killedDate = getDateFromParam(killedTimeParam)
    logger.info("    (bossKilled) - killedDate: " + killedDate.toLocaleDateString("en-US", Config.dateFormats.killedDateFormat))

    // set killedDate to right now if no date was given in command params
    if (killedDate == undefined && killedTimeParam != '')
        if (killedTimeParam != '')
            return notifyInvalidDate(message)
        else
            killedDate = new Date()

    // set dead
    LastKilledBoss = boss
    boss.killedAt[layerIndex] = killedDate
    boss.up[layerIndex] = undefined
    boss.dead[layerIndex] = true
    logger.info('    (bossKilled) - killed at: ' + boss.killedAt[layerIndex].toLocaleString("en-US", Config.dateFormats.killedDateFormat))

    // find next respawn time
    let nextRespawn = undefined
    let respawnTimerMilis = 0
    
    // end scouting shifts for all scouts that were scouting at the time of the boss kill
    endAllShifts(message, scoutingList, boss, layer, true)

    // Handle green dragon kill
    if (boss.type == "Green Dragon") {
        // Only start respawn cd if all dragons have been killed
        GreenDragonsKilled[layerIndex] += 1
        if (GreenDragonsKilled[layerIndex] == 4) {
            nextRespawn = getNextRespawnTime(killedDate, boss)
            respawnTimerMilis = nextRespawn.getTime() - Date.now() - Config.respawnGracePeriod

            logger.info("    (bossKilled) - All Green Dragons have been killed on layer " + layer)

            Bosses.forEach(b => {
                if (b.type == "Green Dragon") {
                    b.respawnTimer[layerIndex] = setTimeout(resetBossRespawn, respawnTimerMilis, b, doSilently, layerIndex+1)
                    b.nextRespawnDate[layerIndex] = nextRespawn

                    logger.info("    (bossKilled) - Updating status for " + boss.name + " on layer " + layerIndex)
                    showBossStatus(":exclamation: All Green Dragons are dead" + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!")) + " :exclamation:", 
                        b, 
                        getGuildFromDisplayName(message.member.displayName).color)
                }
            })

            showAllBossStatus(boss.name + " was killed" + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!")))
        } 
        // Simply notify that a dragon was killed if not told to do silently
        else {
            showBossStatus(boss.name + " was killed" + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!")),
                boss,
                getGuildFromDisplayName(message.member.displayName).color
            )
            showAllBossStatus(boss.name + " was killed" + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!")))
        }  
    } 
    // Handle normal boss kill
    else {
        nextRespawn = getNextRespawnTime(killedDate, boss)
        respawnTimerMilis = nextRespawn.getTime() - Date.now() - Config.respawnGracePeriod
        logger.info("    (bossKilled) - can respawn on layer " + (layerIndex+1) + " at: " + (new Date(respawnTimerMilis + Date.now())).toLocaleString("en-US", Config.dateFormats.killedDateFormat)
            + " ( " + (respawnTimerMilis / (1000 * 60 * 60)).toFixed(2) + " hours ).")

        // subtract 30 minutes to allow people to start scouting just before it comes off respawn
        boss.respawnTimer[layerIndex] = setTimeout(resetBossRespawn, respawnTimerMilis, boss, doSilently, layerIndex+1)
        boss.nextRespawnDate[layerIndex] = nextRespawn

        showBossStatus(boss.name + " was killed" + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!")), 
            boss, 
            getGuildFromDisplayName(message.member.displayName).color)

        showAllBossStatus(boss.name + " was killed" + (numberOfLayers > 1 ? (" on layer " + layer + "!") : ("!")))
    }

    if (!Config.debug.disableBossLogsUpdates && updateBossKillsLog)
        updateBossLogs(new Date(killedDate.getTime() + 3600000 * Config.utc_offset).format(Config.bossLogs.datePattern), boss.name, "KILLED", layer)
    else
        logger.info("    (bossKilled) - Skipping boss logs update...")

    // update spawn window text on calendar
    if (!Config.debug.disableSignupsUpdates && nextRespawn != undefined && bossKilledOnAllLayers(boss)) {
        updateCalendarRespawnWindowText(boss, nextRespawn)
        let soonestLayer = getLayerOffCooldownSoonest(boss)
        blackOutCalendar(boss.sheetName, boss.killedAt[soonestLayer-1], boss.nextRespawnDate[soonestLayer-1])
    } else
        logger.info("    (bossKilled) - Skipping calendar updates...")
}

function getLayerOffCooldownSoonest(boss) {
    let soonestLayer = 0

    for (i=0; i<numberOfLayers; i++) {
        if (boss.nextRespawnDate[soonestLayer] > boss.nextRespawnDate[i])
            soonestLayer = i
    }

    return soonestLayer+1
}

const errsignUpFormat = ' I didn\'t understand that command. \nThe following shows the proper format for sign up commands. (Note that words wrapped in *`[]`* are optional while words wrapped in *`<>`* are required): \n'
const errsignUpTimes = ' `<Start Date>` `[until, to, -]` `<End Date>` `[-noReminder]` \n* Dates can be in the following formats: **mm/dd/yyyy HH:MM AM/PM** or **HH:MM AM/PM**'
const errSignUpStartDate = 'You can only sign up for times later than 30 minutes from now. If you would like to sign up for right now, simply start a shift the the `' + Config.identifier + Config.commands.normal.beginShift[0] + '` command.'

/**
 * Command: !signup
 * 
 * Registers the user for scouting sometime in the future.
 * 
 * @param {Message} message 
 * @param {String[]} args 
 */
function signUp(message, args) {
    logger.info("command: signUp")

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        logger.error('(signUp) - couldn\'t find boss for channel ' + message.channel.id)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }

    // Command Structure is 'signUp [`startDate`] [to, until, -] <`endDate`]> [-noReminder]'

    // [startDate]
    let blStartDateMilis = parseDateFromArgs(args)
    if (blStartDateMilis == -1) {
        logger.info('    (signUp) - couldn\'t parse date ' + args.join())
        return notifyDiscordBotError(message, errsignUpFormat + '`' + Config.identifier + Config.commands.normal.signUp[0] + errsignUpTimes)
    }
    logger.info("    (signUp) - startDate: " + new Date(blStartDateMilis).toLocaleString("en-US", Config.dateFormats.killedDateFormat))

    // [to, until, -]
    if (args[0] == "to" || args[0] == "until" || args[0] == "-")
        args.shift()

    // [endDate]
    let blEndDateMilis = parseDateFromArgs(args)
    if (blEndDateMilis == -1) {
        return notifyDiscordBotError(message, errsignUpFormat + '`' + Config.identifier + Config.commands.normal.signUp[0] + errsignUpTimes)
    }
    logger.info("    (signUp) - endDate: " + new Date(blEndDateMilis).toLocaleString("en-US", Config.dateFormats.killedDateFormat))

    // sendReminder
    let noReminder = getArg(args, '-noReminder')
    if (noReminder == undefined)
        noReminder = getArg(args, '-noreminder')

    // Invalid start and end dates
    if (blStartDateMilis > blEndDateMilis || blStartDateMilis <= Date.now())
        return notifyDiscordBotError(message, errsignUpFormat + '`' + Config.identifier + Config.commands.normal.signUp[0] + errsignUpTimes)
    if (blStartDateMilis <= Date.now() + (30 * 60 * 1000))
        return notifyDiscordBotError(message, errSignUpStartDate)

    // Add scout to calendar
    if (!Config.debug.disableSignupsUpdates) {
        let newScout = {
            userId: message.author.id,
            displayName: message.member.displayName,
            startTime: undefined,
            nickname: undefined,
            calendarId: undefined,
            checkInID: 0
        }

        addScoutToCalendar(newScout, boss, new Date(blStartDateMilis), new Date(blEndDateMilis), false)
    }

    // Schedule reminder unless specified not to
    if (noReminder == undefined)
        setTimeout(remindUserOfScoutTime, blStartDateMilis - Date.now() - (30 * 60 * 1000), message.author, boss)

    const confirmationMessage = "You have signed up to scout `" + boss.name + "` from `" + new Date(blStartDateMilis).toLocaleString("en-US", Config.dateFormats.killedDateFormat)
        + "` until `" + new Date(blEndDateMilis).toLocaleString("en-US", Config.dateFormats.killedDateFormat) + (noReminder == undefined ? "`. I'll send you a reminder 30 minutes before your shift starts!" : "`.")
        + "\n\n " + "You can view the sign up sheet here: " + Config.signupSheetURL + boss.signupSheetURL

    message.author.send(confirmationMessage)
}

/**
 * Command: !removeSummoner
 * 
 * Reemoves the location of the boss associated with the given 
 * message's channel from the list of places the user has
 * a summoner bot at.
 * 
 * @param {Message} message 
 */
function removeSummonerLocation(message) {
    logger.info("Command: removeSummonerLocation")
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        logger.error('(removeSummonerLocation) - couldn\'t find boss for channel ' + message.channel.id)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }
    const guildPos = getGuildPosition(message.member.displayName)
    if (guildPos == undefined) {
        logger.error('(removeSummonerLocation) - couldn\'t find boss for channel ' + message.channel.id)
        return notifyUserHasInvalidGuildTag(message)
    }
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const location = boss.location

        // Fetch User attendance info so that any existing info can be updated
        getUserAttendanceInfo(message.author.id, message.member.displayName, (userAttendanceInfo) => {
            if (userAttendanceInfo == undefined || userAttendanceInfo[0] == undefined) {
                // Create new row - No exisiting user info was found!
                const rowNumber = userAttendanceInfo[3]
                if (rowNumber == undefined) return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
        
                let newRow = createNewAttendanceRow(guildPos, rowNumber, message.author.username, message.member.displayName, message.author.id, 'N/A')
    
                // Add entire row to sheet
                const startColumnLetter = columnToLetter(getGuildColumnStart(guildPos))
                const endColumnLetter = columnToLetter(getGuildColumnStart(guildPos) + guildRowLength() - 1)
                const sheetRange = Config.sheets.attendanceSheet.name + '!' + startColumnLetter + rowNumber + ':' + endColumnLetter + rowNumber
    
                sheets.spreadsheets.values.update(
                    {
                        spreadsheetId: Config.sheets.attendanceSheet.id,
                        range: sheetRange,
                        valueInputOption: 'USER_ENTERED',
                        resource: {
                            values: [newRow]
                        },
                    }, (err, res) => {
                        if (err) return logger.error('(removeSummonerLocation) <new row> - The update request returned an error: ' + err)
                        //logger.info('    (removeSummonerLocation) - Added row for ' + scout.user.username)
                        // Notify user of update
                        notifySummonerInfoSet(message, '')
                    })
            } else {
                // Update existing user info
                const userInfo = userAttendanceInfo[0]
                const rowNumber = userAttendanceInfo[1]
                let existingLocations = userInfo[userInfo.length - 1].split(',')
    
                // Remove location if it exists
                for (i = 0; i < existingLocations.length; i++) { 
                    if (existingLocations[i] == location)
                        existingLocations.splice(i, 1)
                }

                // If empty summoner cell should contain 'N/A'
                if (existingLocations.length == 0)
                    existingLocations.push('N/A')
    
                // Update just summoner locations cell
                const cell = columnToLetter(getGuildColumnStart(guildPos) + guildRowLength() - 1) + rowNumber
                const updatedLocations = existingLocations.join(',')
                sheets.spreadsheets.values.update(
                    {
                        spreadsheetId: Config.sheets.attendanceSheet.id,
                        range: Config.sheets.attendanceSheet.name + '!' + cell,
                        valueInputOption: 'USER_ENTERED',
                        resource: {
                            values: [[updatedLocations]]
                        },
                    }, (err, res) => {
                        if (err) return logger.error('(removeSummonerLocation) <update row> - The update request returned an error: ' + err)
                        //logger.info('    (removeSummonerLocation) - Added summoner locations for ' + message.author.username)
                        // Notify user of update
                        notifySummonerInfoSet(message, updatedLocations)
                    })
            }
        })
    
        if (Config.hideCommandMessage)
            message.delete().catch(() => {})
}

/**
 * Command: !summonerAt
 * 
 * Adds the location of the boss associated with the given 
 * message's channel to the list of places the user has
 * a summoner bot at.
 * 
 * @param {Message} message 
 */
function setSummonerLocation(message) {
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined) {
        logger.error('(setSummonerLocation) - couldn\'t find boss for channel ' + message.channel.id)
        return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    }
    const guildPos = getGuildPosition(message.member.displayName)
    if (guildPos == undefined) {
        logger.error('(setSummonerLocation) - couldn\'t find boss for channel ' + message.channel.id)
        return notifyUserHasInvalidGuildTag(message)
    }
    const sheets = google.sheets({ version: 'v4', auth: newAuth })
    const location = boss.location

    // Fetch User attendance info so that any existing info can be updated
    getUserAttendanceInfo(message.author.id, message.member.displayName, (userAttendanceInfo) => {
        if (userAttendanceInfo == undefined || userAttendanceInfo[0] == undefined) {
            logger.info("    (setSummonerLocation) - Creating new user row")
            // Create new row - No exisiting user info was found!

            const rowNumber = userAttendanceInfo[3] + Config.sheets.attendanceSheet.headerRows
            logger.info("    (setSummonerLocation) - Row number: " + rowNumber)
            if (rowNumber == undefined) return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
    
            let newRow = createNewAttendanceRow(guildPos, rowNumber, message.author.username, message.member.displayName, message.author.id, location)

            // Add entire row to sheet
            const startColumnLetter = columnToLetter(getGuildColumnStart(guildPos))
            const endColumnLetter = columnToLetter(getGuildColumnStart(guildPos) + guildRowLength() - 1)
            const sheetRange = Config.sheets.attendanceSheet.name + '!' + startColumnLetter + rowNumber + ':' + endColumnLetter + rowNumber

            sheets.spreadsheets.values.update(
                {
                    spreadsheetId: Config.sheets.attendanceSheet.id,
                    range: sheetRange,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [newRow]
                    },
                }, (err, res) => {
                    if (err) return logger.error('(setSummonerLocation) <new row> - The update request returned an error: ' + err)
                    //logger.info('    (setSummonerLocation) - Added row for ' + scout.user.username)
                    // Notify user of update
                    notifySummonerInfoSet(message, location)
                })
        } else {
            logger.info("    (setSummonerLocation) - Updating existing user row")
            // Update existing user info
            const userInfo = userAttendanceInfo[0]
            const rowNumber = userAttendanceInfo[1]
            let existingLocations = userInfo[userInfo.length - 1].split(',')

            // Remove N/A if it exists
            for (i = 0; i < existingLocations.length; i++) { 
                if (existingLocations[i] == 'N/A')
                    existingLocations.splice(i, 1)
            }

            // Add new location if it's not already in the list
            if (!existingLocations.includes(location))
                existingLocations.push(location)

            // Sort the list alphabetically
            existingLocations.sort()

            // Update just summoner locations cell
            const cell = columnToLetter(getGuildColumnStart(guildPos) + guildRowLength() - 1) + rowNumber
            const updatedLocations = existingLocations.join(', ')
            sheets.spreadsheets.values.update(
                {
                    spreadsheetId: Config.sheets.attendanceSheet.id,
                    range: Config.sheets.attendanceSheet.name + '!' + cell,
                    valueInputOption: 'USER_ENTERED',
                    resource: {
                        values: [[updatedLocations]]
                    },
                }, (err, res) => {
                    if (err) return logger.error('(setSummonerLocation) <update row> - The update request returned an error: ' + err)
                    //logger.info('    (setSummonerLocation) - Added summoner locations for ' + message.author.username)
                    // Notify user of update
                    notifySummonerInfoSet(message, updatedLocations)
                })
        }
    })

    if (Config.hideCommandMessage)
        message.delete().catch(() => {})
}

// -------------------------- Master Action Handlers

/**
 * Changes the keyword people should use to join groups.
 * 
 * @param {any} message
 * @param {String} newKeyword
 */
function changeKeyword(message, newKeyword) {
    logger.info("command: changeKeyword")

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    if (newKeyword == undefined) {
        logger.info("    (changeKeyword) - invalid keyword given: " + newKeyword)
        return notifyDiscordBotError(meesage, "An invalid keyword was given. Please try again.")
    }

    logger.info("    (changeKeyword) - keyword was changed to " + newKeyword)
    secretWord = newKeyword

    message.channel.send({
        embed: {
            title: 'Keyword has changed!',
            color: getGuildFromDisplayName(message.member.displayName).color,
            fields: [{
                name: 'A new keyword has been set. Please update your auto-invite tool and join the custom channel:',
                value: newKeyword,
                inline: true
            }],
            timestamp: new Date()
        },
    })
}

/**
 * Sets the current projected number of layers 
 * for the server. 
 * 
 * @param {Message} message
 * @param {Number} amount 
 * @param {Boss} boss
 * @param {Number[]} layerIds
 */
function setLayerCount(message, amount, boss, layerIds) {
    logger.info("command: setLayerCount (master command)")

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    numberOfLayers = amount < 1 ? 1 : amount

    // Initialize layered variables
    for (i=0; i<numberOfLayers; i++) {
        if (GreenDragonsKilled[i] == undefined)
            GreenDragonsKilled[i] = 0
        currentScoutsLists.forEach(scoutList => {
            if (scoutList[i] == undefined)
                scoutList[i] = new Map()
        })
        boss.layerId[i] = layerIds[i]
    }

    let embededMessage = "Number of layers predicted: " + amount

    message.channel.send({
        embed: {
            title: 'Number of layers has changed!',
            color: getGuildFromDisplayName(message.member.displayName).color,
            fields: [{
                name: 'The number of layers has been changed. The bot will recalculate the number of instances each boss can appear based on the new number.',
                value: embededMessage,
                inline: true
            }],
            timestamp: new Date()
        },
    })
}

/**
 * Command: !mbus
 * 
 * Registers the beginning of a shift for a specified
 * player. This can differ from the player who entered
 * the command (found in message).
 * 
 * 
 * Command Structure: !mbus <id> username: "<username>" displayName: "<displayName>"
 * 
 * @param {any} message The message spawning this action.
 * @param {[]} args Must contain user Id, username, displayName and, optionally, the end date
 * @param {Number} layer The layer the user is scouting
 */
function beginUserShift(message, args, layer) {
    logger.info("command: beginUserShift (master command)")

    if (Config.hideCommandMessage)
        message.delete().catch(e => { })

    // Fetch User
    const userId = args[0]
    bot.fetchUser(userId).then(user => {
        if (user == undefined) return logger.error("(beginUserShift) - unabled to find user with id: " + args[0])
        args.shift()
    
        // Parse username
        if (args[0] != "username:" || !args[1].startsWith('"')) return logger.error("(beginUserShift) - invalid params 1")
        args.shift()
        let usernameArray = []
        if (args[0].endsWith('"')) {
            usernameArray.push(args[0].substring(1, args[0].length - 1))
            args.shift()
        } else {
            usernameArray.push(args[0].substring(1))
            args.shift()
            while (!args[0].endsWith('"')) {
                usernameArray.push(args[0].substring(0, args[0].length - 1))
                args.shift()
            }
        }
        user.username = usernameArray.join(' ')
    
        // Parse displayName
        if (args[0] != "displayName:" || !args[1].startsWith('"')) return logger.error("(beginUserShift) - invalid params 2")
        args.shift()
    
        let displayNameArray = []
        if (args[0].endsWith('"')) {
            displayNameArray.push(args[0].substring(1, args[0].length - 1))
            args.shift()
        } else {
            displayNameArray.push(args[0].substring(1))
            args.shift()
            while (!args[0].endsWith('"')) {
                displayNameArray.push(args[0].substring(0, args[0].length - 1))
                args.shift()
            }
            if (args[0] != undefined)
                displayNameArray.push(args[0].substring(0, args[0].length - 1))
        }
    
        // Check scout list
        let scoutList = getScoutListFromChannelId(message.channel.id)
        if (scoutList[layer-1].get(user.id) != undefined) {
            userAlreadyScouting(message)
            return
        }
    
        // Check boss
        let boss = Bosses.find(b => b.channelId == message.channel.id)
        if (boss == undefined) {
            logger.error('(beginUserShift) - Unable to find boss with channelId ' + message.channel.id)
            return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
        }
    
        if (boss.dead == numberOfLayers) return bossNotScoutable(message, boss)
    
        // Get starting date
        let startDate = getDateFromParam(args.join(' '))
        if (startDate == undefined)
            startDate = new Date()
    

        let scoutDisplayName = displayNameArray.join(' ')

        // Add new scout
        let newScout = {
            userId: userId,
            displayName: scoutDisplayName,
            startTime: startDate,
            nickname: undefined,
            checkInID: setInterval(checkInOnScout, Config.checkInInterval, userId)
        }
    
        logger.info('    (beginUserShift) - ' + newScout.displayName + ' (' + newScout.userId + ') started scouting '
            + boss.name + ' at ' + newScout.startTime.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
        scoutList[layer-1].set(newScout.userId, newScout)


        const scoutGuild = getGuildFromDisplayName()
        if (scoutGuild == undefined) return notifyDiscordBotError(message, "You must add your guild name to your Discord nickname before using this bot.")
    
        let title = scoutGuild.sayings != undefined
            ? scoutGuild.sayings[getRandomInt(0, scoutGuild.sayings.length - 1)].replace("%s", scoutDisplayName).replace("%b", boss.name + (numberOfLayers > 1 ? (" on layer " + layer) :  "."))
            : scoutDisplayName + ' started scouting ' + boss.name + (numberOfLayers > 1 ? (" on layer " + layer + ".") : ".")

        showBossStatus(title, boss, scoutGuild.color)
    })
}

/**
 * Command: !meas
 * 
 * Ends all scouting shifts for the given boss.
 * Recursively calls endShift() until the scoutingList
 * has been completely emptied.
 * 
 * @param {Message} message 
 * @param {Map} scoutingList 
 * @param {Boss} boss 
 * @param {Number} layer
 * @param {Boolean} doSilently
 */
function endAllShifts(message, scoutingList, boss, layer, doSilently) {
    let key = scoutingList.keys().next().value
    if (key != undefined) {
        logger.info("    (endAllShifts) - ending shift for " + key)
        endShift(message, scoutingList.get(key), boss, layer,  new Date(), scoutingList, doSilently, () => {
            endAllShifts(message, scoutingList, boss, doSilently)
        })
    } else {
        logger.info("    (endAllShifts) - Ended all shifts for " + boss.name)
    }
}

// --------------------------------------------------------------
// Parsing Functions
// --------------------------------------------------------------

bot.on('shardError',  error => {
    logger.error("A websocket connection encountered an error:" + error)
})

bot.on('error', error => {
    logger.error("An error has occured: " + error)
})

bot.on('ready', () => {
    logger.info('Connected')
    //logger.info('Logged in as: ' + bot.user.tag + ' - (' + bot.user.id + ')')
    logger.info("------------------------------------------------------")
    logger.info(Config.botName + ' ' + versionNumber + (Config.debug.enableDebugCommands ? " (Debug Commands Enabled)" : " (Debug Commands Disabled)"))
    logger.info("------------------------------------------------------")
})

bot.on('message', async message => {
    // Ignore other bot messages
    if (message.author.bot) return

    // Ignore non-command messages
    if (!message.content.startsWith(Config.identifier)) return

    // Ignore messages not in proper channels
    logger.info("Received message on channel " + message.channel.name + " (" + message.channel.id + ") from user " + message.author.username + " (" + message.member.id + ")")
    const boss = Bosses.find(b => b.channelId == message.channel.id)
    if (boss == undefined
        && message.channel.id != Config.bossLogs.channelId
        && message.channel.id != Config.bossLoot.channelId
    ) return

    // Check that user has proper guild tag
    if (Config.checkGuildTag && !hasValidGuildTag(message.member.displayName)) {
        notifyUserHasInvalidGuildTag(message)
        return
    }

    // Splice command message
    const args = message.content.slice(1).trim().split(/ +/g)
    const command = args.shift().toLowerCase()

    // BOSS LOGS COMMANDS
    // if (message.channel.id == Config.bossLogs.channelId)
    //     return parseBossLogsCommand(message, command, args)

    // BOSS LOOT COMMANDS
    if (message.channel.id == Config.bossLoot.channelId)
        return parseBossLootCommand(message, command, args)

    const scoutList = getScoutListFromChannelId(message.channel.id)
    if (scoutList == undefined) {
        notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
        return loggger.error('(parseMessage) - failed to get scoutList for channel: ' + message.channel.id)
    }

    // Parse layer from command
    let layer = getLayerFromParams(args, message)
    if (layer == -1)
        return logger.info("Skipping command: " + command)

    try {
        // Check command keyword against known commands (defined in Config.commands JSON)
        
        // Begin Shift
        if (Config.commands.normal.beginShift.map(strToLower).includes(command)) {

            // Ensure boss is scoutable
            if (boss.dead[layer-1] != undefined) return notifyBossNotScoutable(message, boss, layer)

            // Ensure user isn't already scouting
            let scout = scoutList[layer-1].get(message.author.id)
            if (scout != undefined) {
                notifyUserAlreadyScouting(message, scout, boss, layer)
                return logger.info('    (parseBeginShift) - caught user trying to sign up while already scouting! (' + message.author.username + ")")
            }

            let startDate = getDateFromParam(args.join(' '))
            if (startDate == undefined)
                startDate = new Date()

            return beginShift(message, startDate, scoutList, layer)
        }

        // End Shift
        if (Config.commands.normal.endShift.map(strToLower).includes(command)) {
            // Check if doing command silently
            let doSilently = false
            if (args[0] == Config.commands.parameters.silent) {
                doSilently = true
                args.shift()
            }

            // Find scout
            let scout = scoutList[layer-1].get(message.author.id)
            if (scout == undefined) {
                logger.info("    (parseEndShift) - trying to determine which layer the user was on...")
                for (i=0; i<numberOfLayers; i++) {
                    scout = scoutList[i].get(message.author.id)
                    if (scout != undefined){
                        layer = i+1
                        break
                    }
                    scout = scoutList[i].get(message.author.id)
                }
                if (scout == undefined) {
                    logger.info('    (parseEndShift) - caught user trying to end shift but they never signed up! (' + message.member.displayName + ")")
                    notifyUserNotScouting(message, layer)
                    return
                }
            }

            let endTime = getDateFromParam(args.join(' '))
            if (endTime == undefined)
                endTime = new Date()

            return endShift(message, scout, boss, layer, endTime, scoutList[layer-1], doSilently, () => { })
        }

        // Boss Spotted
        if (Config.commands.normal.bossSpotted.map(strToLower).includes(command)) return bossSpotted(message, args, command, boss, layer)

        // Show Current Scouts
        if (Config.commands.normal.showCurrentScouts.map(strToLower).includes(command)) return showCurrentScouts(message, boss, getArg(args, Config.commands.parameters.all) != undefined)

        // Boss Killed
        if (Config.commands.normal.bossKilled.map(strToLower).includes(command)) {
            logger.info('command: Boss Killed')

            // Determine if forcing update
            let forceKillUpdate = false
            if (args[0] == Config.commands.parameters.force) {
                logger.info("    (bossKilled) - Forcing boss kill update")
                args.shift()
                forceKillUpdate = true
            }

            return bossKilled(message, args, getArg(args, Config.commands.parameters.silent) != undefined, true, forceKillUpdate, scoutList[layer-1], layer)
        }

        // Reset Boss Timers
        if (Config.commands.normal.resetBossRespawn.map(strToLower).includes(command)) {
            message.delete().catch(e => { })
            return resetBossRespawn(boss, getArg(args, Config.commands.parameters.silent) != undefined, layer)
        }

        // Set Summoner Location
         if (Config.commands.normal.setSummonerLocation.map(strToLower).includes(command)) return setSummonerLocation(message)

        // Remove Summoner Location
        if (Config.commands.normal.removeSummonerLocation.map(strToLower).includes(command)) return removeSummonerLocation(message)

        // Sign Up For Scouting
        if (Config.commands.normal.signUp.map(strToLower).includes(command)) return signUp(message, args)

        // Help 
        if (Config.commands.normal.listCommands.map(strToLower).includes(command)) {
            let wantsMasterCommands = getArg(args, Config.commands.parameters.master) != undefined
            let showVerbose = getArg(args, Config.commands.parameters.verbose) != undefined
            let showToChannel = getArg(args, "-showToChannel") != undefined
            if (wantsMasterCommands && Config.admins.includes(message.member.id))
                return showMasterCommands(message, showVerbose)
            else
                return showScoutingCommands(message, showVerbose, showToChannel)
        }

        // MASTER COMMANDS

        if (Config.admins.includes(message.member.id)) {
            // Set Layer Count
            if (Config.commands.master.setLayerCount.map(strToLower).includes(command)) {
                let amount = parseInt(args[0])
                if (Object.is(NaN, amount)) {
                    return notifyDiscordBotError(message, "Unknown amount entered. Please try again by adding the number of layers to the end of the command.")
                }
                let layerIds = []
                for (i=0; i<amount; i++)
                    layerIds[i] = args[i+1] == "_" ? undefined : args[i+1]
                
                return setLayerCount(message, amount, boss, layerIds)
            }

            // Boss Respawn Reminder
            if (Config.commands.master.remindRespawn.map(strToLower).includes(command)) return notifyBossRespawnSoon(message.channel.id)

            // Reset Calendars
            if (Config.commands.master.resetCalendar.map(strToLower).includes(command)) {
                message.delete().catch(e => { })
                let resetAll = getArg(args, Config.commands.parameters.all) != undefined

                if (resetAll)
                    return resetCalendars()
                else {
                    let weekTexts = getWeekTexts()
                    return resetCalendar(boss, weekTexts[0], weekTexts[1])
                }
            }

            // Change keyword
            if (Config.commands.master.changeKeyword.map(strToLower).includes(command)) return changeKeyword(message, args.join(' '))

            // End All Shifts
            if (Config.commands.master.endAllShifts.map(strToLower).includes(command))
                return endAllShifts(message, scoutList[layer-1], boss, getArg(args, Config.commands.parameters.silent) != undefined)

            // Add User to Scout List
            if (Config.commands.master.beginUserShift.map(strToLower).includes(command)) return beginUserShift(message, args, true)

            // End User Shift
            if (Config.commands.master.endUserShift.map(strToLower).includes(command)) {
                // Command structure: !meus <userId> -s [end date]
                message.delete().catch(e => { })

                // Get userId
                const userId = args[0]
                args.shift()

                // Check if doing command silently
                let doSilently = false
                if (args[0] == Config.commands.parameters.silent) {
                    doSilently = true
                    args.shift()
                }

                // Get scout
                const scout = scoutList[layer-1].get(message.author.id)
                if (scout == undefined) {
                    logger.info('    (parseEndShift) - caught user trying to end shift but they never signed up! (' + message.member.displayName + ")")
                    userNotScouting(message)
                    return
                }

                // Get optional end time
                let endTime = getDateFromParam(args.join(' '))
                if (endTime == undefined)
                    endTime = new Date()

                return endShift(message, scout, boss, layer, endTime, scoutList[layer-1], doSilently, () => { })
            }

            // Silently notify bot of boss kill
            if (Config.commands.master.silentBossKilled.map(strToLower).includes(command)) {
                logger.info("Command: Silent Boss Killed (Master)")
                const updateBossKillsLog = args[0] == '-update_logs'
                if (updateBossKillsLog)
                    args.pop()

                message.delete().catch(e => { })

                // Determine if forcing update
                let forceKillUpdate = false
                if (args[0] == Config.commands.parameters.force) {
                    args.shift()
                    forceKillUpdate = true
                }

                bossKilled(message, args, true, updateBossKillsLog, forceKillUpdate, scoutList[layer-1], layer)
            }

        }

        // DEBUG COMMANDS

        if (Config.debug.enableDebugCommands) {

            // if (command == "testgetbossname") {
            //     let bossName = determineBossName(bosses[2], args)
            //     logger.info("TEST: bossName = " + bossName)
            //     logger.info("TEST: timeKilled = " + args.join(' '))

            //     return undefined
            // }

            if (command == "scoutingtest") return testScouting(message, args)

            // Test GetDateFromParam()
            if (command == "testdate") return getDateFromParam(args.join(' '))

            // Test ResetSheets()
            if (command == "testresetsheets") return resetSheets()

            if (command == 'testgetnexttuesday') return logger.info('DEBUG: Next tuesday: ' + getNextTuesday(getDateFromParam(args.join(' '))).toLocaleString('en-US', Config.dateFormats.killedDateFormat))

            if (command == "testrespawn") return notifyBossRespawn(message.channel.id)

            if (command == "testresetcals") return resetCalendars()

            if (command == "testresetcal") {
                const nextTuesday = getNextTuesday(new Date())
                const endOfWeekOne = nextTuesday.getTime() - 60 * 60 * 7 * 1000

                const firstWeekText = new Date().format(Config.sheets.calendarSheet.datePattern) + " - " + new Date(endOfWeekOne - 60 * 60 * 24 * 1000).format(Config.sheets.calendarSheet.datePattern)
                const secondWeekText = new Date(endOfWeekOne).format(Config.sheets.calendarSheet.datePattern) + " - " + new Date(endOfWeekOne + (60 * 60 * 24 * 6 * 1000)).format(Config.sheets.calendarSheet.datePattern)

                return resetCalendar(Bosses.find(val => val.name == args[0]), firstWeekText, secondWeekText)
            }

            if (command == "testcalspawn") return updateCalendarRespawnWindowText(Config.bosses[0], new Date())
        }

        // BING BONG, TOP OF MORNING

        if (command == "bing")
            return message.channel.send("Bong!")

        if (command == "bong")
            return message.channel.send("Bing!")

    } catch (e) {
        logger.error('Message parsing returned an error: ' + e + '(' + message.content + ')')
        return logger.error(e.stack)
    }

    message.delete().catch(e => { })

    return logger.info('    - Not a valid command: ' + command)
})

/**
 * Parses input against all loot commands.
 * 
 * @param {any} message
 * @param {String} command Command input
 * @param {String} args Command arguments
 */
function parseBossLootCommand(message, command, args) {
    try {
        // Reset Loot Variables
        if (Config.commands.bossLoot.reset.map(strToLower).includes(command)) return resetLootVariables(message)
        // Show Loot Help
        if (Config.commands.bossLoot.help.map(strToLower).includes(command)) return showLootHelp(message, getArg(args, '-v') != undefined)
        // Set Guild Attendance

        let amount = parseInt(args.pop())
        let guildName = (command + (args.length > 0 ? (" " + args.join(' ')) : "")).toLowerCase()
        let tempGuild = Guilds.find(g => g.name.toLowerCase() == guildName || g.tag.toLowerCase() == guildName)

        if (tempGuild != undefined) {
            if (Object.is(NaN, amount)) {
                notifyDiscordBotError(message, "No value was given for the # of people present during boss kill. " +
                    "\n\n\tThe following shows the proper format for this command:\n\t\t`" + Config.identifier + command + " 10`")
                return logger.info("    (parseBossLootCommand) - No amount was given for setGuildLootAttendance command!")
            }
            return setGuildLootAttendance(message, tempGuild, amount)
        } else {
            logger.info("    (parseBossLootCommand) - Unknown guild name: " + command)

            notifyDiscordBotError(message, "I didn't recognize that guild. Please try the command again using one of the following guilds:" + getListOfGuilds())
        }

    } catch (e) {
        return logger.error('    (parseBossLootCommand) - Message parsing returned an error: ' + e + ' (' + message.content + ')')
    }
}


// --------------------------------------------------------------
// Generic Helper Functions
// --------------------------------------------------------------

// -------------------------- Parsing Functions

/**
 * Tries to parse the layer from the first parameter.
 * If a layer is parsed, the first param is popped off the
 * array.
 * 
 * If no layer is parsed, layer 1 is assumed and returned.
 * 
 * If an error occurs, -1 is returned.
 * 
 * @param {String[]} args 
 */
function getLayerFromParams(args, message) {
    let layer = 1
    if (args[0] != undefined && args[0].includes("layer=")) {
        layer = parseInt(args[0].substr(args[0].indexOf("=") + 1))
        args.shift()
        if (Object.is(NaN, layer) || layer < 1) {
            logger.info("    (getLayerFromParams) - caught invalid layer number")
            notifyDiscordBotError(message, "Invalid layer was enter. Please specify the layer by adding `layer=<Layer Number>` to the *beginning of the command*. \n\nFor example: `" 
                + Config.identifier + Config.commands.normal.bossKilled[0] + " layer=1`")
            return -1
        }
        logger.info("    (getLayerFromParams) - Layer was set to " + layer)
    }

    if (layer > numberOfLayers) {
        let boss = Bosses.find(b => b.channelId == message.channel.id)
        if (boss == undefined) {
            logger.error("(getLayerFromParams) - Couldn't find boss for channel id: " + message.channel.i)
            return layer
        }
            
        logger.info("    (getLayerFromParams) - user enetered a layer that was higher than the predicted number of layers. Readjusting layer count from " + numberOfLayers + " to " + layer)
        setLayerCount(message, layer, boss, boss.layerId)
    }

    return layer
}

/**
 * Parses a date string and returns the time (in millis).
 * If an error occurs, -1 is returned.
 * 
 * @param {any} args The date string
 */
function parseDateFromArgs(args) {
    if (args != undefined && args[0] != undefined && args[0] != "") {
        let dateString = ""

        while (args[0] != undefined && args[0].toUpperCase() != "AM" && args[0].toUpperCase() != "PM") {
            //logger.info("    (parseDateFromArgs) - checking " + args[0])
            dateString += " " + args[0]
            args.shift()
        }
        if (args[0] != undefined) {
            dateString += " " + args[0]
            args.shift()
        }
        //logger.info("    (parseDateFromArgs) - dateString: " + dateString.trim())
        const date = getDateFromParam(dateString)
        if (date == undefined)
            return -1

        return date.getTime()
    }

    return -1
}


// -------------------------- Date and Time Functions

function getWeekTexts() {
    const nextTuesday = getNextTuesday(new Date())
    const endOfWeekOne = nextTuesday.getTime() - 60 * 60 * 7 * 1000

    const firstWeekText = new Date().format(Config.sheets.calendarSheet.datePattern) + " - " + new Date(endOfWeekOne - 60 * 60 * 24 * 1000).format(Config.sheets.calendarSheet.datePattern)
    const secondWeekText = new Date(endOfWeekOne).format(Config.sheets.calendarSheet.datePattern) + " - " + new Date(endOfWeekOne + (60 * 60 * 24 * 6 * 1000)).format(Config.sheets.calendarSheet.datePattern)

    return [firstWeekText, secondWeekText]
}

function getServerDate(date) {
    let newDate = new Date(date.getTime() + (3600000 * Config.utc_offset))
    //logger.info("    (getServerDate) - converting \'" + date + "\' to \'" + newDate + "\'")
    return newDate
}

/**
 * Attempts to parse a Date from the param.
 * 
 * @param {String} param 
 */
function getDateFromParam(param) {
    //logger.info('    (getDateFromParam) - param: ' + param)
    let now = new Date()
    let fixedParam = param

    // Check for 'month/day' without a year
    if (param != undefined) {
        if (param.indexOf('/') != -1) {
            let firstSlashIndex = param.indexOf('/')
            if (param.indexOf('/', firstSlashIndex + 1) == -1) {
                // Need to append year
                let endOfDateIndex = firstSlashIndex + 1
                while (param.charAt(endOfDateIndex) >= '0' && param.charAt(endOfDateIndex) <= '9')
                    endOfDateIndex++
                fixedParam = param.slice(0, endOfDateIndex) + '/' + now.getFullYear() + param.slice(endOfDateIndex)
                //logger.info('    (getDateFromParam) - fixedParam: ' + fixedParam)
            }
        }

        //logger.info('    (getDateFromParam) - fixedParam1: ' + fixedParam)
    }

    if (new Date(fixedParam).toString() != "Invalid Date")
        fixedParam += Config.serverTimezone

    //logger.info("    (getDateFromParam) - fixedParam with timezone: " + fixedParam)

    // Attempt to parse date from param
    let newDate = new Date(Date.parse(fixedParam))

    // Failed to parse, need to attempt a fix
    if (newDate.toString() == 'Invalid Date') {
        //logger.info("    (getDateFromParam) - InvalidDate... ")
        let fixedDateStr = param.trim()

        if (fixedDateStr != '') {
            const refDate = new Date(Date.now() + (Config.utc_offset * 60 * 60 * 1000))
            //logger.info("    (getDateFromParam) - refDate: " + refDate.toLocaleDateString())
            const fixedDate = new Date((refDate.getMonth() + 1) + "/" + refDate.getDate() + "/" + refDate.getFullYear() + ", " + param)
            if (fixedDate.toString() != 'Invalid Date') {
                fixedDateStr = fixedDate.toLocaleString() + Config.serverTimezone
            } else {
                fixedDateStr = now.toLocaleString()
            }
        }
        else {
            fixedDateStr = now.toLocaleString()
        }

        //logger.info('    (getDateFromParam) - fix attempt: ' + fixedDateStr)
        newDate = new Date(fixedDateStr)
        if (newDate.toString() == 'Invalid Date') {
            //logger.info('    (getDateFromParam) - Invalid date... couldn\'t be parsed: ' + param)
            return undefined
        }
    }

    //logger.info('    (getDateFromParam) - newDate: ' + newDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    return newDate.toString() == 'Invalid Date' ? undefined : newDate
}

/**
 * Returns a Date of the next Tuesday.
 * 
 * @param {Date} currentDate 
 */
function getNextTuesday(currentDate) {
    // Checks to see if it died just after server reset
    let daysTilTuesday = (currentDate.getDay() == 2
        ? currentDate.getHours() >= (7 - Config.utc_offset)
            ? 9
            : 2
        : currentDate.getDay() > 2
            ? 9
            : 2)
        - currentDate.getDay()
    //logger.info("    (getNextTuesday) - days til tuesday: " + daysTilTuesday)
    let tilTuesdayMiliseconds = daysTilTuesday * 86400 * 1000
    tilTuesdayMiliseconds -= (currentDate.getHours() * 3600 * 1000)
    tilTuesdayMiliseconds -= (currentDate.getMinutes() * 60 * 1000)

    // Add 7 hours, since maintenance happens around 7AM 
    tilTuesdayMiliseconds += (3600 * 1000 * 7)

    // Add account for utc_offset
    tilTuesdayMiliseconds -= Config.utc_offset * 3600 * 1000
    const tilTuesdayRespawn = currentDate.getTime() + tilTuesdayMiliseconds
    //logger.info("    (getNextTuesday) - next Tuesday: " + new Date(tilTuesdayRespawn).toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    return new Date(tilTuesdayRespawn)
}

/**
 * Returns the Date the boss can spawn again, bassed on killedDate.
 * 
 * If something goes wrong, undefined is returned instead.
 * 
 * @param {Date} killedDate 
 * @param {Boss} boss 
 */
function getNextRespawnTime(killedDate, boss) {
    //logger.info("    (getNextRespawnTime) killedDate - " + killedDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    if (killedDate == undefined || killedDate.toString() == "Invalid Date" || boss == undefined) return undefined

    //logger.info('    (getNextRespawnTime) - killedDate: ' + killedDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat))

    // The respawn date, assuming server reset doesn't happen first
    const fullRespawnDate = new Date(killedDate.getTime() + boss.respawnCD)

    // The date of the next server reset
    const nextTuesdayDate = getNextTuesday(killedDate)

    //logger.info("    (getNextRespawnTime) - Next tuesday: " + nextTuesdayDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat))
    //logger.info('    (getNextRespawnTime) - \'' + fullRespawnDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat) + '\' (72 hr offset) ' +
    //    'vs \'' + nextTuesdayDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat) + '\' (Tuesday Reset)')


    const realRespawnDate = fullRespawnDate > nextTuesdayDate ? nextTuesdayDate : fullRespawnDate
    //logger.info('    (getNextRespawnTime) - next respawn is: \'' + realRespawnDate.toLocaleString("en-US", Config.dateFormats.killedDateFormat) + '\'')

    return realRespawnDate
}

// -------------------------- Discord Manipulation Functions

function listAllVariations(commandsList) {
    var listStr = ''

    for (command of commandsList) {
        listStr += '!' + command + ', '
    }

    return listStr.substring(0, listStr.length - 2)
}

function getArg(argList, desiredArg) {
    return argList.find(val => val == desiredArg)
}

function getScoutListFromChannelId(channelId) {
    const boss = Bosses.find(b => b.channelId == channelId)

    return boss == undefined ? undefined : currentScoutsLists.get(boss.name)
}

/**
 * Determines if the displayName adheres to guild tag
 * protocols. This means it must have an open and close
 * carrot with some predfined tag in between.
 * Example: <Contempt>
 * 
 * If a new guild is added to the Coalition, it MUST
 * be added to Guilds. Otherwise this method
 * will incorrectly return false.
 * 
 */
function hasValidGuildTag(displayName) {
    const startIndex = displayName.indexOf('<')
    const endIndex = displayName.indexOf('>')
    const properTagFormat = startIndex < endIndex
        && startIndex == 0
        && endIndex - startIndex > 1
    if (!properTagFormat) return false

    const tag = displayName.substring(1, endIndex)

    return Guilds.some(guild => guild.tag === tag)
}

/**
 * Returns guild data from a verified tag name.
 * This function assumes the tag name is valid (i.e. something like 
 * '<Contempt>')
 */
function getGuildFromDisplayName(displayName) {
    const tag = displayName.substring(1, displayName.indexOf('>'))
    for (const guild of Guilds) {
        if (guild.tag == tag)
            return guild
    }

    logger.error('(getGuildFromDisplayName) - No guild found with tag ' + tag)
    return undefined
}

// -------------------------- Google Sheet-Related Functions

function getUserRowNumber(id, sheet) {
    //logger.info("Checking rows of size " + sheet.length)
    for (i = 0; i < sheet.length; i++) {
        //logger.info("CHECKING: " + sheet[i][2])
        if (id == sheet[i][2])
            return i + Config.sheets.attendanceSheet.headerRows
    }

    return -1
}

function getGuildColumnStart(guildPosition) {
    const rowLen = guildRowLength()
    return rowLen * guildPosition + 1 + Config.sheets.attendanceSheet.startColumn
}

function guildRowLength() { return Config.sheets.attendanceSheet.columnsBeforeBosses + Config.sheets.attendanceSheet.columnsAfterBosses + Bosses.length }

function getGuildPosition(displayName) {
    let tag = displayName.substring(1, displayName.indexOf('>'))
    if (tag == undefined) {
        logger.error('    (getGuildPosition) - failed to find guild')
        return undefined
    }
    for (var i = 0; i < Guilds.length; i++) {
        if (Guilds[i].tag == tag)
            return i
    }

    return undefined
}

/** 
 * @param {Date} time 
 */
function getCellNumber(time) {
    let cellNumber = (time.getHours() * 2) + CAL_HEADER_LENGTH

    return time.getMinutes() < 30 ? cellNumber : cellNumber + 1
}

/**
 * @param {Number} column 
 */
function columnToLetter(column) {
    let temp, letter = '';
    while (column > 0) {
        temp = (column - 1) % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        column = (column - temp - 1) / 26;
    }
    return letter;
}

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 * The value is no lower than min (or the next integer greater than min
 * if min isn't an integer) and no greater than max (or the next integer
 * lower than max if max isn't an integer).
 * Using Math.round() will give you a non-uniform distribution!
 * 
 * @param {Number} min 
 * @param {Number} max 
 */
function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// -------------------------- Misc Functions

async function sleep(msec) { return new Promise(resolve => setTimeout(resolve, msec)); }

/**
 * Returns the tags of all guilds the bot currently recognizes.
 */
function getListOfGuilds() {
    let listOfGuilds = ""
    Guilds.map(guild => { listOfGuilds += "\n\t" + guild.tag })
    listOfGuilds += ""

    return listOfGuilds
}

/**
 * Simple shuffle algorithm used to randomize the order
 * of the guild ranges.
 * 
 * @param {any} array List of guilds to shuffle
 */
function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    let temporaryValue = undefined

    // While there remain elements to shuffle...
    while (0 !== currentIndex) {

        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;

        // And swap it with the current element.
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}

/**
 * Used in mapping functions to change Strings to their
 * lowercase equivalent.
 * 
 * @param {String} str 
 */
function strToLower(str) { return str.toLowerCase() }



// --------------------------------------------------------------
// Date Format
// --------------------------------------------------------------


/*
 * Date Format 1.2.3
 * (c) 2007-2009 Steven Levithan <stevenlevithan.com>
 * MIT license
 *
 * Includes enhancements by Scott Trenda <scott.trenda.net>
 * and Kris Kowal <cixar.com/~kris.kowal/>
 *
 * Accepts a date, a mask, or a date and a mask.
 * Returns a formatted version of the given date.
 * The date defaults to the current date/time.
 * The mask defaults to dateFormat.masks.default.
 */

var dateFormat = function () {
    var token = /d{1,4}|m{1,4}|yy(?:yy)?|([HhMsTt])\1?|[LloSZ]|"[^"]*"|'[^']*'/g,
        timezone = /\b(?:[PMCEA][SDP]T|(?:Pacific|Mountain|Central|Eastern|Atlantic) (?:Standard|Daylight|Prevailing) Time|(?:GMT|UTC)(?:[-+]\d{4})?)\b/g,
        timezoneClip = /[^-+\dA-Z]/g,
        pad = function (val, len) {
            val = String(val);
            len = len || 2;
            while (val.length < len) val = "0" + val;
            return val;
        };

    // Regexes and supporting functions are cached through closure
    return function (date, mask, utc) {
        var dF = dateFormat;

        // You can't provide utc if you skip other args (use the "UTC:" mask prefix)
        if (arguments.length == 1 && Object.prototype.toString.call(date) == "[object String]" && !/\d/.test(date)) {
            mask = date;
            date = undefined;
        }

        // Passing date through Date applies Date.parse, if necessary
        date = date ? new Date(date) : new Date;
        if (isNaN(date)) throw SyntaxError("invalid date");

        mask = String(dF.masks[mask] || mask || dF.masks["default"]);

        // Allow setting the utc argument via the mask
        if (mask.slice(0, 4) == "UTC:") {
            mask = mask.slice(4);
            utc = true;
        }

        var _ = utc ? "getUTC" : "get",
            d = date[_ + "Date"](),
            D = date[_ + "Day"](),
            m = date[_ + "Month"](),
            y = date[_ + "FullYear"](),
            H = date[_ + "Hours"](),
            M = date[_ + "Minutes"](),
            s = date[_ + "Seconds"](),
            L = date[_ + "Milliseconds"](),
            o = utc ? 0 : date.getTimezoneOffset(),
            flags = {
                d: d,
                dd: pad(d),
                ddd: dF.i18n.dayNames[D],
                dddd: dF.i18n.dayNames[D + 7],
                m: m + 1,
                mm: pad(m + 1),
                mmm: dF.i18n.monthNames[m],
                mmmm: dF.i18n.monthNames[m + 12],
                yy: String(y).slice(2),
                yyyy: y,
                h: H % 12 || 12,
                hh: pad(H % 12 || 12),
                H: H,
                HH: pad(H),
                M: M,
                MM: pad(M),
                s: s,
                ss: pad(s),
                l: pad(L, 3),
                L: pad(L > 99 ? Math.round(L / 10) : L),
                t: H < 12 ? "a" : "p",
                tt: H < 12 ? "am" : "pm",
                T: H < 12 ? "A" : "P",
                TT: H < 12 ? "AM" : "PM",
                Z: utc ? "UTC" : (String(date).match(timezone) || [""]).pop().replace(timezoneClip, ""),
                o: (o > 0 ? "-" : "+") + pad(Math.floor(Math.abs(o) / 60) * 100 + Math.abs(o) % 60, 4),
                S: ["th", "st", "nd", "rd"][d % 10 > 3 ? 0 : (d % 100 - d % 10 != 10) * d % 10]
            };

        return mask.replace(token, function ($0) {
            return $0 in flags ? flags[$0] : $0.slice(1, $0.length - 1);
        });
    };
}();

// Some common format strings
dateFormat.masks = {
    "default": "ddd mmm dd yyyy HH:MM:ss",
    shortDate: "m/d/yy",
    mediumDate: "mmm d, yyyy",
    longDate: "mmmm d, yyyy",
    fullDate: "dddd, mmmm d, yyyy",
    shortTime: "h:MM TT",
    mediumTime: "h:MM:ss TT",
    longTime: "h:MM:ss TT Z",
    isoDate: "yyyy-mm-dd",
    isoTime: "HH:MM:ss",
    isoDateTime: "yyyy-mm-dd'T'HH:MM:ss",
    isoUtcDateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss'Z'"
};

// Internationalization strings
dateFormat.i18n = {
    dayNames: [
        "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat",
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
    ],
    monthNames: [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"
    ]
};

// For convenience...
Date.prototype.format = function (mask, utc) {
    return dateFormat(this, mask, utc);
};

// --------------------------------------------------------------
// DEBUG Test Functions
// --------------------------------------------------------------

// async function testScouting(message, args) {
//     let scoutList = getScoutListFromChannelId(message.channel.id)
//     if (scoutList.get(message.author.id) != undefined) {
//         userAlreadyScouting(message)
//         return logger.info('    (parseBeginShift) - caught user trying to sign up while already scouting! (' + message.author.username + ")")
//     }

//     let boss = Bosses.find(b => b.channelId == message.channel.id)
//     if (boss == undefined) {
//         logger.error('(parseBeginShift) - Unable to find boss with channelId ' + message.channel.id)
//         return notifyDiscordBotError(message, Config.genericErrorMessages[getRandomInt(0, Config.genericErrorMessages.length)])
//     }


//     if (boss.dead == numberOfLayers) return bossNotScoutable(message, boss)

//     const doSilently = getArg(args, Config.commands.parameters.silent) != undefined

//     beginShift(message, new Date(Date.now() - (60 * 60 * 1000)), doSilently)
//     await sleep(500)
//     beginShift(message, boss, new Date(Date.now() - (2 * 60 * 60 * 1000)), doSilently)
//     await sleep(500)
//     beginShift(message, boss, new Date(Date.now() - (3 * 60 * 60 * 1000)), doSilently)
//     await sleep(500)
//     beginShift(message, boss, new Date(Date.now() - (4 * 60 * 60 * 1000)), doSilently)
//     await sleep(500)
//     beginShift(message, boss, new Date(Date.now() - (5 * 60 * 60 * 1000)), doSilently)

//     await sleep(3000)

//     endAllShifts(message, scoutList, boss, doSilently)

//     //endShiftV2(message, scoutList.get("Wing"), boss, new Date(), scoutList, getArg(args, Config.commands.parameters.silent))
//     //await sleep(2000)
//     //endShiftV2(message, scoutList.get("Wing2"), boss, new Date(), scoutList, getArg(args, Config.commands.parameters.silent))
//     //await sleep(2000)
//     //endShiftV2(message, scoutList.get("Wing3"), boss, new Date(), scoutList, getArg(args, Config.commands.parameters.silent))
//     //await sleep(2000)
//     //endShiftV2(message, scoutList.get("Wing4"), boss, new Date(), scoutList, getArg(args, Config.commands.parameters.silent))
//     //await sleep(2000)
//     //endShiftV2(message, scoutList.get("Wing5"), boss, new Date(), scoutList, getArg(args, Config.commands.parameters.silent))
// }