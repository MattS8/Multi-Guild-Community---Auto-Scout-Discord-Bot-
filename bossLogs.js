var winston = require('winston')
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logfile.log' })
    ]
});
var myAuth = require('./auth.json')
var config = require('./config.json')
var bossLogs = require('./bossLogs.json')
bossLogs = bossLogs.sort(compareLogs)
var bosses = config.bosses

function compareLogs(log1, log2) {
    const killedDate1 = new Date(Date.parse(log1.Time + config.serverTimezone))
    const killedDate2 = new Date(Date.parse(log2.Time + config.serverTimezone))

    return killedDate1.getTime() > killedDate2.getTime()
        ? 1
        : killedDate2.getTime() > killedDate1.getTime()
            ? -1
            : 0
}

/**
 * Sifts through bossLogs for unique boss spawns.
 * Starts by sifting through all log events and filtering out non SPAWN/KILLED events.
 * Then it checks to see if there was a SPAWN event without a subsequent KILLED event.
 *
 * Each boss loop removes log events for that boss, making subsequent loops shorter.
 *
 */
function getKilledTimes() {
    for (const boss of bosses) {
        var prevLog = undefined
        for (const log of bossLogs) {
            if (log.Boss == boss.name.toUpperCase()) {
                if (log.Event == "KILLED" || log.Event == "SPAWN") {
                    if (prevLog != undefined && (prevLog.Event == "KILLED" || log.Event != "KILLED")) {
                        boss.killedTimes.push(prevLog.Time)
                        //logger.info("prevLog: " + prevLog.Event + " @ " + prevLog.Time + " | log: " + log.Event + " @ " + log.Time)
                    }

                    prevLog = log
                } else if (prevLog != undefined) {
                    boss.killedTimes.push(prevLog.Time)
                    prevLog = undefined
                }
                // shift bossLogs
            }
        }
        if (prevLog != undefined)
            boss.killedTimes.push(prevLog.Time)

        logger.info("---------------------------------------------------")
        logger.info("---- Killed Times for " + boss.name + " ----")
        logger.info("---------------------------------------------------")
        for (const killedTime of boss.killedTimes)
            logger.info(new Date(Date.parse(killedTime + config.serverTimezone)).toLocaleString("en-US", config.killedDateFormat))
    }
}

function getTimeBetweenSpawns() {
    for (const boss of bosses) {
        logger.info("--------------------------------------------------------")
        logger.info("---- Time between spawns for " + boss.name + " ----")
        logger.info("--------------------------------------------------------")
        var totalTimeHours = 0;
        for (var i = 0; i < boss.killedTimes.length; i++) {
            var firstTime = boss.killedTimes[i]
            var secondTime = boss.killedTimes[i + 1]
            if (secondTime == undefined)
                break

            const firstDate = new Date(Date.parse(firstTime + config.serverTimezone))
            const secondDate = new Date(Date.parse(secondTime + config.serverTimezone))
            var timeBetween = (secondDate - firstDate) / (3600 * 1000)
            totalTimeHours += timeBetween
            var str = formatStr(firstDate.toLocaleString("en-US", config.killedDateFormat), 27) + " -> " + formatStr(secondDate.toLocaleString("en-US", config.killedDateFormat), 27)

            logger.info(formatStr(str, 55) + " (" + timeBetween.toFixed(2) + " hours)")
        }
        logger.info("Average time between kills for " + boss.name + ": " + (totalTimeHours / boss.killedTimes.length).toFixed(2))
    }
}

function formatStr(theStr, len) {
    while (theStr.length < len) {
        theStr += ' '
    }

    return theStr
}

function compareKilledTimes(killedTime1, killedTime2) {
    const killedDate1 = new Date(Date.parse(killedTime1 + config.serverTimezone))
    const killedDate2 = new Date(Date.parse(killedTime2 + config.serverTimezone))

    return killedDate1.getTime() > killedDate2.getTime()
        ? 1
        : killedDate2.getTime() > killedDate1.getTime()
            ? -1
            : 0
}

getKilledTimes()
getTimeBetweenSpawns()