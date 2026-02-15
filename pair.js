const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require('yt-search');
const ytdl = require('ytdl-core');
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const FIREBASE_URL = '..............';

const config = {
    THARUZZ_FOOTER: '> \`❝ SᕼᗩGEE ᗰᗪ ᗰIᑎI.ᗷOT ♡🕊️ ❞\`',
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['🌼', '🍬', '💝', '💗', '🎈', '🎉', '🥳', '❤️', '💕', '👨‍🔧'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/HPnEiMHsiOd2djymlbsF3u',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://i.ibb.co/hFmR4Qvg/tourl-1768288598458.jpg',
    NEWSLETTER_JID: ' 120363421350428668@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94703403671',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb6A4FQJkK7AOqqfBM17'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    // Remove GitHub, now using Firebase
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Load session data from Firebase
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
                console.log(`Deleted duplicate session file: ${sessionKeys[i]}`);
            }
        }

        // Check config file existence
        const configKey = `config_${sanitizedNumber}.json`;
        if (data[configKey]) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '+94 70 3403 671',
        `📞 Number: ${number}\n Status: Connected`,
        '> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ♡🕊️ ❞\`'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}
async function updateStoryStatus(socket) {
    const statusMessage = `> CONNECTION SUCSESS..! 🚀`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}
async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '> 𝑆𝐻𝜟Ꮹ𝛯𝛯 MD🔥'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['💛', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ♡🕊️ ❞\` '
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
    try {
    const akuru = sender
    const quot = msg
    if (quot) {
        if (quot.imageMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
            await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
        } else if (quot.videoMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
             await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
        } else if (quot.audioMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.audioMessage?.caption || "";
            let anu = await socke.downloadAndSaveMediaMessage(quot.audioMessage);
             await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        } else if (quot.viewOnceMessageV2?.message?.imageMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
             await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
            
        } else if (quot.viewOnceMessageV2?.message?.videoMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });

        } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
        
            let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        }
        }        
        } catch (error) {
      }
    }

}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
        
        const myquoted = {
    key: {
        remoteJid: 'status@broadcast',
        participant: '0@s.whatsapp.net',
        fromMe: false,
        id: createSerial(16).toUpperCase()
    },
    message: {
        contactMessage: {
            displayName: "◈𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ∞",
            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:(‧_‧?)𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ\nORG:DTZ SHAGEE;\nTEL;type=CELL;type=VOICE;waid=13135550002:13135550002\nEND:VCARD`,
            contextInfo: {
                stanzaId: createSerial(16).toUpperCase(),
                participant: "0@s.whatsapp.net",
                quotedMessage: {
                    conversation: "SHAGEE AI"
                }
            }
        }
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    status: 1,
    verifiedBizName: "Meta"
};

const type = getContentType(msg.message);
    if (!msg.message) return	
  msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
	const m = sms(socket, msg);
	const quoted =
        type == "extendedTextMessage" &&
        msg.message.extendedTextMessage.contextInfo != null
          ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
          : []
        const body = (type === 'conversation') ? msg.message.conversation 
    : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'interactiveResponseMessage') 
        ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
            && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
    : (type == 'templateButtonReplyMessage') 
        ? msg.message.templateButtonReplyMessage?.selectedId 
    : (type === 'extendedTextMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'imageMessage') && msg.message.imageMessage.caption 
        ? msg.message.imageMessage.caption 
    : (type == 'videoMessage') && msg.message.videoMessage.caption 
        ? msg.message.videoMessage.caption 
    : (type == 'buttonsResponseMessage') 
        ? msg.message.buttonsResponseMessage?.selectedButtonId 
    : (type == 'listResponseMessage') 
        ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
    : (type == 'messageContextInfo') 
        ? (msg.message.buttonsResponseMessage?.selectedButtonId 
            || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            || msg.text) 
    : (type === 'viewOnceMessage') 
        ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
    : (type === "viewOnceMessageV2") 
        ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
    : '';
	 	let sender = msg.key.remoteJid;
	  const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid)
          const senderNumber = nowsender.split('@')[0]
          const developers = `${config.OWNER_NUMBER}`;
          const botNumber = socket.user.id.split(':')[0]
          const isbot = botNumber.includes(senderNumber)
          const isOwner = isbot ? isbot : developers.includes(senderNumber)
          var prefix = config.PREFIX
	  var isCmd = body.startsWith(prefix)
    	  const from = msg.key.remoteJid;
          const isGroup = from.endsWith("@g.us")
	      const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
          var args = body.trim().split(/ +/).slice(1)
socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
                let quoted = message.msg ? message.msg : message
                let mime = (message.msg || message).mimetype || ''
                let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
                const stream = await downloadContentFromMessage(quoted, messageType)
                let buffer = Buffer.from([])
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk])
                }
                let type = await FileType.fromBuffer(buffer)
                trueFileName = attachExtension ? (filename + '.' + type.ext) : filename
                await fs.writeFileSync(trueFileName, buffer)
                return trueFileName
}
        if (!command) return;

        try {
            switch (command) {
              
   case 'alive': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const captionText = `
❲ *𝐻𝛯𝑌 𝛣𝜟𝛣𝑌 𝐼𝛭 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ* ❳

║▻ ❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ♡🕊️ ❞ ◅║

╭────◅●💗●▻────◈
♠️  𝛣ᴏᴛ びᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
♠️  𝛣ᴏᴛ 𝜟ᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
♠️  𝛭ɪɴɪ 𝛶ᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
♠️  𝐷ᴇᴘʟᴏʏ 𝛲ʟᴀᴛꜰʀᴏᴍ ➟ RENDER ❲ PREMIUM ❳ ⚡
♠️  𝛣ᴏᴛ 𝐷ᴇᴠᴇʟᴏᴘᴇʀꜱ ➟ ꪶ ꜱʜᴀɢᴇᴇ & ꜱʜᴀɢᴇᴇ ꫂ ᴰ ᵀ ᶻ ⚡
╰────◅●💗●▻────◈

> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\``;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '❲ ᗰEᑎᑌ ❳' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: ' ❲ OᗯᑎEᖇ ❳' },
            type: 1,
        }, 
                    {
            buttonId: 'action',
            buttonText: {
                displayText: '❁ ᗰEᑎᑌ OᑭᑕTIOᑎ ❁'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `SᕼᗩGEE ᗰᗪ ᗰIᑎI`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🍁 ᗰEᑎᑌ 🍁',
                                    description: 'GET ᗰEᑎᑌ ᑕOᑎᑎᗩᗰᑎᗪ',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '♠️ ᗰY OᗯᑎEᖇ ♠️',
                                    description: 'ᑕOᑎTᗩᑕT ᗰY OᗯᑎEᖇ',
                                    id: `${config.PREFIX}owner`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://i.ibb.co/hFmR4Qvg/tourl-1768288598458.jpg" },
        caption: `> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ 𝐀ʟɪᴠᴇ ɴᴏᴡ..! ♡🕊️ ❞\``,
    }, { quoted: myquoted });

    break;
}

//---------------------------------------setting--------------------------------------//
case 'settings':
case 'setting': {
    const adminNumbers = [
        '94704602578', // bot owner
         '94703403671', 
    ];
    const botNumber = socket.user.id.split(':')[0];
    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
        return await socket.sendMessage(sender, { text: '❌ Only the bot or admins can use this command.' }, { quoted: msg });
    }

    // Load user config (or default)
    const userConfig = await loadUserConfig(sanitizedNumber);

    // Only show these keys, in this order:
    const keys = [
		'PREFIX',
        'AUTO_VIEW_STATUS',
        'AUTO_LIKE_STATUS',
        'AUTO_RECORDING',
        
    ];

    // Emoji map for each setting
    const emojiMap = {
		PREFIX: '🔑',
        AUTO_VIEW_STATUS: '👀',
        AUTO_LIKE_STATUS: '❤️',
        AUTO_RECORDING: '🎙️',
        AUTO_LIKE_EMOJI: '😻'
        
    };

    // Helper to format ON/OFF
    const onOff = v => v === true || v === 'true' ? '🟢 ON' : '🔴 OFF';

    // Build the settings text
    let settingsText = `╭━━━[ *🛠️ Your Settings* ]━━━⬣\n`;

    for (const key of keys) {
        let value = userConfig[key];
        if (key === 'AUTO_LIKE_EMOJI' && Array.isArray(value)) {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${value.join(' ')}\n`;
        } else if (typeof value === 'boolean' || value === 'true' || value === 'false') {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${onOff(value)}\n`;
        } else {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${value}\n`;
        }
    }

    settingsText += `╰━━━━━━━━━━━━━━━━━━⬣\n`;
	settingsText += `Usage: .set <key> <value>\nExample: .set AUTO_LIKE_STATUS true\n`;
	settingsText += `> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\``;

    await socket.sendMessage(m.chat, { react: { text: '⚙️', key: msg.key } });
    await socket.sendMessage(sender, { text: settingsText }, { quoted: myquoted });
    break;
}
case 'set': {
    // Only allow the bot number to edit configs
    const adminNumbers = [
      '94704602578', // bot owner
      '94703403671', // admin
    ];
    const botNumber = socket.user.id.split(':')[0];
    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
        return await socket.sendMessage(sender, { text: '❌ Only the bot or admins can use this command.' }, { quoted: myquoted });
    }
    if (args.length < 2) {
        return await socket.sendMessage(sender, { text: 'Usage: .set <key> <value>\nExample: .set AUTO_LIKE_STATUS true' }, { quoted: myquoted });
    }
    const key = args[0].toUpperCase();
    let value = args.slice(1).join(' ');

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(value)) value = Number(value);

    let userConfig = await loadUserConfig(sanitizedNumber);

    if (!(key in defaultUserConfig)) {
        return await socket.sendMessage(sender, { text: `Unknown setting: ${key}` }, { quoted: myquoted });
    }

    userConfig[key] = value;
    await updateUserConfig(sanitizedNumber, userConfig);
 await socket.sendMessage(m.chat, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: `✅ Setting *${key}* updated to *${value}*.` }, { quoted: myquoted });
    break;
}

                case 'menu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
❲ \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\` ❳

║▻ ᴍʏ ᴄᴏᴍᴍᴀɴᴅ ʟɪꜱᴛ  ◅║

╭────◅●❖●▻────➣
♠️ ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s
♠️ ʙᴏᴛ ᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size}
♠️ ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ
♠️ ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku ❲ ꜰʀᴇᴇ ❳
♠️ ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ ꪶ ꜱʜᴀɢᴇᴇ ꫂ ᴰ ᵀ ᶻ
╰────◅●❖●▻────➢

🛡️ A New Era of WhatsApp Bot Automation

> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\`



➟

🔧 Built With:
Node.js + JavaScript
Auto deploy and free ❕

➟

> ᴇɴᴊᴏʏ ᴀʟʟ ᴍʏ ʙᴏᴛ
`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}alive`,
            buttonText: { displayText: 'ᗩᒪIᐯE 🌿' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: 'GET OᗯᑎEᖇ 💌 •' },
            type: 1,
        },
                {
            buttonId: 'action',
            buttonText: {
                displayText: ' ◅ ᗰEᑎᑌ  ▻'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TᗩᗷS❕',
                    sections: [
                        {
                            title: `SᕼᗩGEE ᗰIᑎI `,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '💾 ᗪOᗯᑎᒪOᗪ ᗰEᑎᑌ',
                                    description: 'SᕼᗩGEE ᗰᗪ ／︿＼ ',
                                    id: `${config.PREFIX}dmenu`,
                                },
                                {
                                    title: '👑 OᗯᑎEᖇ ᑕOᗰᗰᗩᑎᗪ',
                                    description: 'SᕼᗩGEE ᗰᗪ ',
                                    id: `${config.PREFIX}ownermenu`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://i.ibb.co/hFmR4Qvg/tourl-1768288598458.jpg" },
        caption: `SᕼᗩGEE ᗰᗪ ᗰIᑎI ᑕOᗰᗰᗩᑎᗪ ᒪIST`,
    }, { quoted: myquoted });

    break;
}     
					
             case 'dmenu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
            SᕼᗩGEE ᗰᗪ ᗰIᑎI ᗷOT
            
          🔥 ᗪOᗯᑎᒪOᗪ ᑕOᗰᗰᗩᑎᗪ 🔥

 ➤ 𝐀𝐕𝐀𝐼𝐋𝐀𝐁𝐋𝛯 𝐂𝐎𝛭𝐌Ҩ𝚴𝐃𝐒
┏━━━━━━ ❍ ━━━━━━┓
🛠️ *SY𝑆TE𝛭 CO𝛭MA𝚴DS*
• 🟢 \`.alive\` — Show bot status
• 🔌 \`.system\` — Bot System
• 🧪 \`.ping\` — Check speed
• 🆔 \`.jid\` — Get your JID

🖼️ *MEDIA TOOLS*
• 👁‍🗨 \`.vv\` — View once unlock
• ⭐ \`.getdp\` — Downlode Dp
• 👀 \`.cinfo\` — Get Channel Info
• 💾 \`.save / send\` — Status saver
• 🍭 \`.yts\` — Youtube search
• 📋 \`.tiktoksearch\` — tiktoksearch

📥 *DOWNLOADERS*
• 🎧 \`.song\` — Download song
• 📂 \`.csend\` — Channel Song Send
• 🎥 \`.tiktok\` — TikTok video
• 📸 \`.facebook\`  — Video Facebook
• 🎬 \`.video\` — Video

─────────────
> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\``;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}alive`,
            buttonText: { displayText: 'ᗩᒪIᐯE 🌿' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: 'OᗯᑎEᖇ•' },
            type: 1,
        },
                {
            buttonId: 'action',
            buttonText: {
                displayText: ' ◅ ❤️👨‍🔧ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴꜱ ▻'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: '𝙏𝘼𝘽 𝙎𝙀𝘾𝙏𝙄𝙊𝙉❕',
                    sections: [
                        {
                            title: `❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞ `,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🤖 Check Bot Status',
                                    description: '❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '💬 Commands List',
                                    description: '❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞',
                                    id: `${config.PREFIX}listmenu`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://i.ibb.co/hFmR4Qvg/tourl-1768288598458.jpg" },
        caption: `❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\n\n${captionText}`,
    }, { quoted: myquoted });

    break;
}          

case 'ownermenu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
    > \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\`
            🔥 OWNER MENU 🔥

🤖  .alive       → Check if bot is online
📋  .menu        → Show full command menu
🏓  .ping        → Check bot latency
💻  .system      → System information
⚙️  .setting     → Bot settings
🎵  .csong       → Channel song Send
📢  .jid         → Jid Check
🎴  .owner       → Bot Owners 

> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\``;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}alive`,
            buttonText: { displayText: 'ᴀʟɪᴠᴇ 🌿' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: '🧿 • ʙᴏᴛ ᴏᴡɴᴇʀ •' },
            type: 1,
        },
                {
            buttonId: 'action',
            buttonText: {
                displayText: ' ◅ ❤️👨‍🔧ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴꜱ ▻'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: '𝙏𝘼𝘽 𝙎𝙀𝘾𝙏𝙄𝙊𝙉❕',
                    sections: [
                        {
                            title: `❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🤖 Check Bot Status',
                                    description: '❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '💬 Commands List',
                                    description: '❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞',
                                    id: `${config.PREFIX}listmenu`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://i.ibb.co/hFmR4Qvg/tourl-1768288598458.jpg" },
        caption: `> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\` \n\n${captionText}`,
    }, { quoted: myquoted });

    break;
}     


case 'system': {
	
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
const captionText = `
║▻ ꜱʜᴀɢᴇᴇ ᴍᴅ ᴍɪɴɪ ʙᴏᴛ◅║

╭────◅●❤️●▻────➣
💝 ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💝 ʙᴏᴛᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💝 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💝 ʀᴀᴍ ᴜꜱᴇɢᴇ ➟ 36220/3420 GB ⚡
💝 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Render⚡
💝 ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ 94703403671 ⚡
╰────◅●❤️●▻────➢
> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\``;
	
    const templateButtons = [
        {
            buttonId: `${config.PREFIX}ping`,
            buttonText: { displayText: ' 𝙿𝙸𝙽𝙶 ' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: ' 𝙼𝙴𝙽𝚄' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: ' 𝙾𝚆𝙽𝙴𝚁' },
            type: 1
        }
    ];

    await socket.sendMessage(m.chat, {
        image: { url: "https://i.ibb.co/hFmR4Qvg/tourl-1768288598458.jpg" },
        caption: captionText.trim(),
        footer: '❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞',
        buttons: templateButtons,
        headerType: 1
    }, { quoted: myquoted });

    break;
			   }
case 'ping': {
    const os = require("os")
    const start = Date.now();

    const loading = await socket.sendMessage(m.chat, {
        text: "*𝗧𝗘𝗦𝗧𝗜𝗡𝗚 𝗧𝗛𝗘 𝗕𝗢𝗧*"
    }, { quoted: myquoted });

    const stages = ["*○○○○", "**○○○", "***○○", "****○", "*****"];
    for (let stage of stages) {
        await socket.sendMessage(m.chat, { text: stage, edit: loading.key });
        await new Promise(r => setTimeout(r, 250));
    }

    const end = Date.now();
    const ping = end - start;

    await socket.sendMessage(m.chat, {
        text: `🦹‍♀️ 𝘗𝘐𝘕𝘎  ▻  \`50.001ms\`\n\n ʙᴏᴛ ɪꜱ ᴀᴄᴛɪᴠᴇ ᴛᴏ ꜱɪɢɴᴀʟ 💝👻⚡`,
        edit: loading.key
    });

    break;
			}

		        case 'owner': {
    const ownerNumber = '94703403671';
    const ownerName = 'ꪶ ꜱʜᴀɢᴇᴇꫂ ᴰ ᵀ ᶻ';
    const organization = 'ᴅᴇᴠ ꜱʜᴀɢᴇᴇ ᴍᴅ ᴏᴡɴᴇʀ';

    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${ownerName}\n` +
                  `ORG:${organization};\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                  'END:VCARD';

    try {
        // Send vCard contact
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // Then send message with reference
        await socket.sendMessage(from, {
            text: `* 𝐒𝐇𝐀𝐆𝐄𝐄 𝐌𝐃  OWNER*\n\n👨‍🔧 Name: ${ownerName}\n💭 ηυмвєя ➥ ${ownerNumber}\n\n> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\``,
            contextInfo: {
                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`],
                quotedMessageId: sent.key.id
            }
        }, { quoted: myquoted });

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Error sending owner contact.'
        }, { quoted: myquoted });
    }
				
          
        
  break;
       }
			    
case 'fancy': {
  const axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Dila`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "❌ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `🎨 Fancy Fonts Converter\n\n${fontList}\n\n \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\` 🔥_`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted:myquoted });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "⚠️ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
	}



case 'video':
case 'yt':
case 'mp4': {
    const axios = require('axios');
    const yts = require('yt-search');

    const query = text.trim();
    if (!query)
        return conn.sendMessage(
            m.chat,
            { text: "📝 Provide a YouTube URL or search query!" },
            { quoted: myquoted }
        );

    try {
        let ytUrl;
        let video;

        // 🔎 Detect URL or search
        if (/^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/.test(query)) {
            ytUrl = query;
            const searchRes = await yts(ytUrl);
            video = searchRes.videos[0];
        } else {
            const searchRes = await yts(query);
            video = searchRes.videos[0];
            ytUrl = video?.url;
        }

        if (!video || !ytUrl)
            return conn.sendMessage(
                m.chat,
                { text: "❌ Video not found!" },
                { quoted: myquoted }
            );

        // 📄 Video info
        const caption = `
🎬 *${video.title}*
👤 Channel: ${video.author.name}
⏱ Duration: ${video.timestamp}
👁 Views: ${video.views}
        `;
        await conn.sendMessage(m.chat, { text: caption }, { quoted: myquoted });

        // 🌐 Call MovaNest API
        const apiRes = await axios.get(
            "https://www.movanest.xyz/v2/dxz-ytdl",
            {
                params: {
                    input: ytUrl,
                    format: "1080p",
                    your_api_key: "movanest-keyHBMAREAFXU"
                }
            }
        );

        if (!apiRes.data.status)
            return conn.sendMessage(
                m.chat,
                { text: "❌ API Error!" },
                { quoted: m }
            );

        const results = apiRes.data.results;

        // 🎯 Get ddownr format with alternatives
        const ddownr = results.byFormat?.["1080p"]?.find(
            f => f.scraper === "ddownr" && Array.isArray(f.alternatives)
        );

        if (!ddownr)
            return conn.sendMessage(
                m.chat,
                { text: "❌ No downloadable format found!" },
                { quoted: myquoted }
            );

        // 🔗 Pick best direct URL (SSL first)
        const direct =
            ddownr.alternatives.find(a => a.has_ssl) ||
            ddownr.alternatives[0];

        if (!direct?.url)
            return conn.sendMessage(
                m.chat,
                { text: "❌ No direct download link!" },
                { quoted: myquoted }
            );

        // ⬇ Download video
        const videoRes = await axios.get(direct.url, {
            responseType: "arraybuffer",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.youtube.com"
            },
            maxRedirects: 10
        });

        // 📦 Size check (100MB)
        const size = videoRes.data.length;
        if (size > 100 * 1024 * 1024)
            return conn.sendMessage(
                m.chat,
                { text: `❌ Video too large: ${(size / 1024 / 1024).toFixed(2)} MB` },
                { quoted: myquoted }
            );

        // 📤 Send video
        await conn.sendMessage(
            m.chat,
            {
                video: Buffer.from(videoRes.data),
                mimetype: "video/mp4",
                caption: video.title
            },
            { quoted: myquoted }
        );

    } catch (e) {
        conn.sendMessage(
            m.chat,
            { text: `❌ Failed to download video!\n${e.message}` },
            { quoted: myquoted }
        );
    }
    break;
}
case 'song': {
    const yts = require('yt-search');
    const axios = require('axios');

    // Extract YT video id & normalize link (reuse from original)
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }
    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
        return input;
    }

    // get message text
    const q = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
        break;
    }

    // load bot name
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    let cfg = await loadUserConfigFromMongo(sanitized) || {};
    let botName = cfg.botName || '𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ❤️‍🩹';

    // fake contact for quoted card
    const botMention = {
        key: {
            remoteJid: "status@broadcast",
            participant: "0@s.whatsapp.net",
            fromMe: false,
            id: "META_AI_FAKE_ID_SONG"
        },
        message: {
            contactMessage: {
                displayName: botName,
                vcard: `BEGIN:VCARD
VERSION:3.0
N:𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♠️;;;;
FN:𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♠️
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
            }
        }
    };

    try {
        // Determine video URL: if q contains YT id/url, use it; otherwise search by title
        let videoUrl = null;
        const maybeLink = convertYouTubeLink(q.trim());
        if (extractYouTubeId(q.trim())) {
            videoUrl = maybeLink;
        } else {
            // search by title
            const search = await yts(q.trim());
            const first = (search?.videos || [])[0];
            if (!first) {
                await socket.sendMessage(sender, { text: '*`No results found for that title`*' }, { quoted: botMention });
                break;
            }
            videoUrl = first.url;
        }

        // call your mp3 API (the one you provided)
        const apiUrl = `https://api.srihub.store/download/ytmp3?apikey=dew_hFjyfoUDx5IFFLDMU9ljc3DEaDCCC9niVbWG78KU&url=${encodeURIComponent(videoUrl)}`;
        const apiRes = await axios.get(apiUrl, { timeout: 15000 }).then(r => r.data).catch(e => null);

        if (!apiRes || (!apiRes.downloadUrl && !apiRes.result?.download?.url && !apiRes.result?.url)) {
            await socket.sendMessage(sender, { text: '*`MP3 API returned no download link`*' }, { quoted: botMention });
            break;
        }

        // Normalize download URL and metadata
        const downloadUrl = apiRes.downloadUrl || apiRes.result?.download?.url || apiRes.result?.url;
        const title = apiRes.title || apiRes.result?.title || 'Unknown title';
        const thumb = apiRes.thumbnail || apiRes.result?.thumbnail || null;
        const duration = apiRes.duration || apiRes.result?.duration || null;
        const quality = apiRes.quality || apiRes.result?.quality || '128';

        const caption = `🎵 *Title:* ${title}
⏱️ *Duration:* ${duration || 'N/A'}
🔊 *Quality:* ${quality}
🔗 *Source:* ${videoUrl}

*Reply to this message (quote it) with a number to choose format:*
1️⃣. 📄 MP3 as Document
2️⃣. 🎧 MP3 as Audio
3️⃣. 🎙 MP3 as Voice Note (PTT)

> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ♡🕊️ ❞\``;

        // send thumbnail card if available
        const sendOpts = { quoted: botMention };
        const media = thumb ? { image: { url: thumb }, caption } : { text: caption };
        const resMsg = await socket.sendMessage(sender, media, sendOpts);

        // handler waits for quoted reply from same sender
        const handler = async (msgUpdate) => {
            try {
                const received = msgUpdate.messages && msgUpdate.messages[0];
                if (!received) return;

                const fromId = received.key.remoteJid || received.key.participant || (received.key.fromMe && sender);
                if (fromId !== sender) return;

                const text = received.message?.conversation || received.message?.extendedTextMessage?.text;
                if (!text) return;

                // ensure they quoted our card
                const quotedId = received.message?.extendedTextMessage?.contextInfo?.stanzaId ||
                    received.message?.extendedTextMessage?.contextInfo?.quotedMessage?.key?.id;
                if (!quotedId || quotedId !== resMsg.key.id) return;

                const choice = text.toString().trim().split(/\s+/)[0];

                await socket.sendMessage(sender, { react: { text: "📥", key: received.key } });

                switch (choice) {
                    case "1":
                        await socket.sendMessage(sender, {
                            document: { url: downloadUrl },
                            mimetype: "audio/mpeg",
                            fileName: `${title}.mp3`
                        }, { quoted: received });
                        break;
                    case "2":
                        await socket.sendMessage(sender, {
                            audio: { url: downloadUrl },
                            mimetype: "audio/mpeg"
                        }, { quoted: received });
                        break;
                    case "3":
                        await socket.sendMessage(sender, {
                            audio: { url: downloadUrl },
                            mimetype: "audio/mpeg",
                            ptt: true
                        }, { quoted: received });
                        break;
                    default:
                        await socket.sendMessage(sender, { text: "*Invalid option. Reply with 1, 2 or 3 (quote the card).*" }, { quoted: received });
                        return;
                }

                // cleanup listener after successful send
                socket.ev.off('messages.upsert', handler);
            } catch (err) {
                console.error("Song handler error:", err);
                try { socket.ev.off('messages.upsert', handler); } catch (e) {}
            }
        };

        socket.ev.on('messages.upsert', handler);

        // auto-remove handler after 60s
        setTimeout(() => {
            try { socket.ev.off('messages.upsert', handler); } catch (e) {}
        }, 60 * 1000);

        // react to original command
        await socket.sendMessage(sender, { react: { text: '🔎', key: msg.key } });

    } catch (err) {
        console.error('Song case error:', err);
        await socket.sendMessage(sender, { text: "*`Error occurred while processing song request`*" }, { quoted: botMention });
    }

    break;
}



//=========


case 'facebook':
case 'fb': {
    const axios = require("axios");

    const query = text.trim();
    if (!query)
        return conn.sendMessage(
            m.chat,
            { text: "📝 Provide a Facebook post URL!" },
            { quoted: m }
        );

    try {
        const fbUrl = query;

        // 🌐 Call MovaNest FB API
        const apiRes = await axios.get("https://www.movanest.xyz/v2/fbdown", {
            params: { url: fbUrl }
        });

        if (!apiRes.data.status)
            return conn.sendMessage(
                m.chat,
                { text: "❌ API Error!" },
                { quoted: m }
            );

        const result = apiRes.data.results?.[0];
        if (!result)
            return conn.sendMessage(
                m.chat,
                { text: "❌ No video data found!" },
                { quoted: m }
            );

        // 🎯 Pick best quality (HD → SD)
        const directUrl = result.hdQualityLink || result.normalQualityLink;
        if (!directUrl)
            return conn.sendMessage(
                m.chat,
                { text: "❌ No downloadable video URL!" },
                { quoted: m }
            );

        // ⬇ Download video
        const videoRes = await axios.get(directUrl, {
            responseType: "arraybuffer",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://www.facebook.com"
            },
            maxRedirects: 10
        });

        // 📦 Size check (100MB)
        const size = videoRes.data.length;
        if (size > 100 * 1024 * 1024)
            return conn.sendMessage(
                m.chat,
                { text: `❌ Video too large: ${(size / 1024 / 1024).toFixed(2)} MB` },
                { quoted: m }
            );

        // 📤 Send video
        await conn.sendMessage(
            m.chat,
            {
                video: Buffer.from(videoRes.data),
                mimetype: "video/mp4",
                caption: result.title || "Facebook Video"
            },
            { quoted: myquoted }
        );

    } catch (e) {
        conn.sendMessage(
            m.chat,
            { text: `❌ Failed to download Facebook video!\n${e.message}` },
            { quoted: myquoted }
        );
    }
    break;
}
			
                case 'vv':
                case 'viewonce': {
                    try {
                        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

                        if (!quotedMsg) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Please reply to a ViewOnce message!*\n\n📌 Usage: Reply to a viewonce message with `.vv`'
                            }, { quoted: myquoted });
                        }

                        await socket.sendMessage(sender, {
                            react: { text: '✨', key: msg.key }
                        });

                        let mediaData = null;
                        let mediaType = null;
                        let caption = '';

                        // Check for viewonce media
                        if (quotedMsg.imageMessage?.viewOnce) {
                            mediaData = quotedMsg.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.videoMessage?.viewOnce) {
                            mediaData = quotedMsg.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessage?.message?.imageMessage) {
                            mediaData = quotedMsg.viewOnceMessage.message.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessage?.message?.videoMessage) {
                            mediaData = quotedMsg.viewOnceMessage.message.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessageV2?.message?.imageMessage) {
                            mediaData = quotedMsg.viewOnceMessageV2.message.imageMessage;
                            mediaType = 'image';
                            caption = mediaData.caption || '';
                        } else if (quotedMsg.viewOnceMessageV2?.message?.videoMessage) {
                            mediaData = quotedMsg.viewOnceMessageV2.message.videoMessage;
                            mediaType = 'video';
                            caption = mediaData.caption || '';
                        } else {
                            return await socket.sendMessage(sender, {
                                text: '❌ *This is not a ViewOnce message or it has already been viewed!*'
                            }, { quoted: myquoted });
                        }

                        if (mediaData && mediaType) {
                            await socket.sendMessage(sender, {
                                text: '⏳ *Retrieving ViewOnce media...*'
                            }, { quoted: myquoted });

                            const buffer = await downloadAndSaveMedia(mediaData, mediaType);

                            const messageContent = caption ?
                                `✅ *ViewOnce ${mediaType} Retrieved*\n\n📝 Caption: ${caption}` :
                                `✅ *ViewOnce ${mediaType} Retrieved*`;

                            if (mediaType === 'image') {
                                await socket.sendMessage(sender, {
                                    image: buffer,
                                    caption: messageContent
                                }, { quoted: myquoted });
                            } else if (mediaType === 'video') {
                                await socket.sendMessage(sender, {
                                    video: buffer,
                                    caption: messageContent
                                }, { quoted: myquoted });
                            }

                            await socket.sendMessage(sender, {
                                react: { text: '✅', key: msg.key }
                            });

                            console.log(`✅ ViewOnce ${mediaType} retrieved for ${sender}`);
                        }

                    } catch (error) {
                        console.error('ViewOnce Error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to retrieve ViewOnce*\n\nError: ${error.message}`
                        }, { quoted: myquoted });
                    }
                    break;
                }
										case 'chr': {
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    // ❌ Remove owner check
    // if (!isOwner) return await socket.sendMessage(sender, { text: "❌ Only owner can use this command!" }, { quoted: myquoted });

    if (!q.includes(',')) return await socket.sendMessage(sender, { text: "❌ Please provide input like this:\n*chreact <link>,<reaction>*" }, { quoted: myquoted });

    const link = q.split(",")[0].trim();
    const react = q.split(",")[1].trim();

    try {
        const channelId = link.split('/')[4];
        const messageId = link.split('/')[5];

        // Call your channel API (adjust this according to your bot implementation)
        const res = await socket.newsletterMetadata("invite", channelId);
        const response = await socket.newsletterReactMessage(res.id, messageId, react);

        await socket.sendMessage(sender, { text: `✅ Reacted with "${react}" successfully!` }, { quoted: myquoted });

    } catch (e) {
        console.log(e);
        await socket.sendMessage(sender, { text: `❌ Error: ${e.message}` }, { quoted: myquoted });
    }
    break;
}
case 'xvideo': {
  await socket.sendMessage(sender, { react: { text: '🫣', key: msg.key } });
  
  const q = args.join(" ");
  
  if (!q) {
    await socket.sendMessage(sender, {text: "Please enter xvideo name !!"})
  }
  
  try {
    const xvSearchApi = await fetch(`https://saviya-kolla-api.koyeb.app/search/xvideos?query=${query}`);
    const tharuzzXvsResults = await xvSearchApi.json();
    
    const rows = tharuzzXvsResults.result.xvideos.map(item => ({
      title: item.title || "No title info",
      description: item.link || "No link info",
      id: `${config.PREFIX}xnxxdl ${item.link}`,
    }));
    
    await socket.sendMessage(from, {image: config.RCD_IMAGE_PATH, caption: `*🔞 \`XVIDEO SEARCH RESULTS.\`*\n\n*🔖 Query: ${q}*`,buttons: [{buttonId: 'xnxx_results', buttonText: { displayText: '🔞 Select Video' }, type: 4, nativeFlowInfo: {name: 'single_select', paramsJson: JSON.stringify({title: '🔍 XNXX Search Results', sections: [{ title: 'Search Results', rows }],}), }, }], headerType: 1, viewOnce: true }, {quoted: myquoted} );
    
  } catch (e) {
    console.log("❌ Xvideo command error: " + e)
  }
  break;
};

case 'xnxxdl': {
  await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
  const link = args.join(" ");
  try {
    const xnxxDlApi = await fetch(`https://saviya-kolla-api.koyeb.app/download/xvideos?url=${link}`);
    const tharuzzXnxxDl = await xnxxDlApi.json();
    
    const infoMap = tharuzzXnxxDl.result;
    const highQlink = infoMap.dl_Links?.highquality;
    const lowQlink = infoMap.dl_Links?.lowquality;
    
    const caption = `Title: ${infoMap.title}\nDuration: ${infoMap.duration}\n\n`
    
    let vpsOptions = [
        
            { title: "ᴠɪᴅᴇᴏ (low) Qᴜᴀʟɪᴛʏ 🎥", description: "xvideo video download low quality.", id: `${config.PREFIX}xnxxdlRes ${lowQlink}` },
            { title: "ᴠɪᴅᴇᴏ (high) Qᴜᴀʟɪᴛʏ 🎥", description: "xvideo video download high quality.", id: `${config.PREFIX}xnxxdlRes ${highQlink}` }
        ];

        let buttonSections = [
            {
                title: "xvideo download",
                highlight_label: "ꜱʜᴀɢᴇᴇ ᴍᴅ ᴍɪɴɪ",
                rows: vpsOptions
            }
        ];

        let buttons = [
            {
                buttonId: "action",
                buttonText: { displayText: "🔢 ꜱᴇʟᴇᴄᴛ ᴠɪᴅᴇᴏ Qᴜᴀʟɪᴛʏ" },
                type: 4,
                nativeFlowInfo: {
                    name: "single_select",
                    paramsJson: JSON.stringify({
                        title: "🔢 ꜱᴇʟᴇᴄᴛ ᴠɪᴅᴇᴏ Qᴜᴀʟɪᴛʏ",
                        sections: buttonSections
                    })
                }
            }
        ]; 
    
    await socket.sendMessage(from,{image: {url: infoMap.thumbnail}, caption: caption, buttons, headerType: 1, viewOnce: true}, {quoted: myquoted});
    
    
  } catch (e) {
    console.log("❌ Error xvideo command: " + e)
  }
  break;
};

case 'xnxxdlRes': {
  await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
  
  const q = args.join();
  
  try {
    await socket.sendMessage(from, {video: {url: q}, caption: "🔞 This is your xvideo."}, {quoted: myquoted});
  } catch (e) {
    console.log(e)
  }
  break;
};
					case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.cf 1203634191215382@newsletter'
                        });
                    }
						

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }
				

					// ABOUT STATUS COMMAND
case 'about': {
    if (args.length < 1) {
        return await socket.sendMessage(sender, {
            text: "📛 *Usage:* `.about <number>`\n📌 *Example:* `.about 94703403671*`"
        });
    }

    const targetNumber = args[0].replace(/[^0-9]/g, '');
    const targetJid = `${targetNumber}@s.whatsapp.net`;

    // Reaction
    await socket.sendMessage(sender, {
        react: {
            text: "ℹ️",
            key: msg.key
        }
    });

    try {
        const statusData = await socket.fetchStatus(targetJid);
        const about = statusData.status || 'No status available';
        const setAt = statusData.setAt
            ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss')
            : 'Unknown';

        const timeAgo = statusData.setAt
            ? moment(statusData.setAt).fromNow()
            : 'Unknown';

        // Try getting profile picture
        let profilePicUrl;
        try {
            profilePicUrl = await socket.profilePictureUrl(targetJid, 'image');
        } catch {
            profilePicUrl = null;
        }

        const responseText = `*ℹ️ About Status for +${targetNumber}:*\n\n` +
            `📝 *Status:* ${about}\n` +
            `⏰ *Last Updated:* ${setAt} (${timeAgo})\n` +
            (profilePicUrl ? `🖼 *Profile Pic:* ${profilePicUrl}` : '');

        if (profilePicUrl) {
            await socket.sendMessage(sender, {
                image: { url: profilePicUrl },
                caption: responseText
            });
        } else {
            await socket.sendMessage(sender, { text: responseText });
        }
    } catch (error) {
        console.error(`Failed to fetch status for ${targetNumber}:`, error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to get about status for ${targetNumber}. Make sure the number is valid and has WhatsApp.`
        });
    }
    break;
}
//TT DL COM

case 'tiktok':
case 'ttdl':
case 'tt':
case 'tiktokdl': {
    try {
        // 🔹 Load bot name dynamically
        const sanitized = (number || '').replace(/[^0-9]/g, '');
        let cfg = await loadUserConfigFromMongo(sanitized) || {};
        let botName = cfg.botName || 'SHAGEE MINI BOT AI';

        // 🔹 Fake contact for Meta AI mention
        const botMention = {
            key: {
                remoteJid: "status@broadcast",
                participant: "0@s.whatsapp.net",
                fromMe: false,
                id: "META_AI_FAKE_ID_TT"
            },
            message: {
                contactMessage: {
                    displayName: botName,
                    vcard: `BEGIN:VCARD
VERSION:3.0
N:𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ 💛  ;;;;
FN:𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♠️
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
                }
            }
        };

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Please provide a TikTok video link.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            }, { quoted: botMention });
            return;
        }

        if (!q.includes("tiktok.com")) {
            await socket.sendMessage(sender, { 
                text: '*🚫 Invalid TikTok link.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            }, { quoted: botMention });
            return;
        }

        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Downloading TikTok video...*' }, { quoted: botMention });

        const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(q)}`;
        const { data } = await axios.get(apiUrl);

        if (!data.status || !data.data) {
            await socket.sendMessage(sender, { 
                text: '*🚩 Failed to fetch TikTok video.*',
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ]
            }, { quoted: botMention });
            return;
        }

        const { title, like, comment, share, author, meta } = data.data;
        const videoUrl = meta.media.find(v => v.type === "video").org;

        const titleText = `*${botName} TIKTOK DOWNLOADER*`;
        const content = `┏━━━━━━━━━━━━━━━━\n` +
                        `┃👤 \`User\` : ${author.nickname} (@${author.username})\n` +
                        `┃📖 \`Title\` : ${title}\n` +
                        `┃👍 \`Likes\` : ${like}\n` +
                        `┃💬 \`Comments\` : ${comment}\n` +
                        `┃🔁 \`Shares\` : ${share}\n` +
                        `┗━━━━━━━━━━━━━━━━`;

        const footer = config.BOT_FOOTER || '> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ♡🕊️ ❞\`';
        const captionMessage = formatMessage(titleText, content, footer);

        await socket.sendMessage(sender, {
            video: { url: videoUrl },
            caption: captionMessage,
            contextInfo: { mentionedJid: [sender] },
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
            ]
        }, { quoted: botMention });

    } catch (err) {
        console.error("Error in TikTok downloader:", err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal Error. Please try again later.*',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
            ]
        });
    }
    break;
	}


// AI CHAT COMMAND
case 'ai':
case 'gpt':
case 'chat': {
    try {
        const query = args.join(' ');

        // ප්‍රශ්නයක් ඇතුළත් කර නොමැති නම්
        if (!query) {
            return await socket.sendMessage(sender, {
                text: '*❌ කරුණාකර ප්‍රශ්නයක් ඇතුළත් කරන්න.*\n\n*Usage:* .ai ඔයා කවුද?'
            }, { quoted: myquoted });
        }

        // වැඩ කරන බව පෙන්වීමට Reaction එකක් දැමීම
        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        const apiKey = "dew_hFjyfoUDx5IFFLDMU9ljc3DEaDCCC9niVbWG78KU";
        const apiUrl = `https://api.srihub.store/ai/chatgpt?apikey=${apiKey}&prompt=${encodeURIComponent(query)}`;

        const response = await axios.get(apiUrl);

        // API response එක පරීක්ෂා කිරීම
        // සටහන: ඔබේ API එකේ දත්ත ලැබෙන ආකාරය (result/data/response) අනුව පහත පේළිය වෙනස් කරන්න
        const aiReply = response.data.result || response.data.data || response.data.response;

        if (!aiReply) {
            throw new Error('Invalid API response structure');
        }

        // පිළිතුර යැවීම
        await socket.sendMessage(sender, {
            text: `*🤖 AI Response:*\n\n${aiReply}\n\n${footer}`,
            contextInfo: contextInfo // මෙය ඔබේ පද්ධතියේ කලින් නිර්වචනය කර තිබිය යුතුය
        }, { quoted: myquoted });

        // සාර්ථක වූ පසු Reaction එක වෙනස් කිරීම
        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

    } catch (error) {
        console.error('❌ AI error:', error);
        
        // Error එකක් ආවොත් user ට දැනුම් දීම
        await socket.sendMessage(sender, {
            text: `*❌ AI Error*\n\nසමාවන්න, පිළිතුර ලබාගැනීමේදී දෝෂයක් සිදුවිය. පසුව නැවත උත්සාහ කරන්න.`
        }, { quoted: myquoted });

        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}

case 'yt': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        if (videoId) {
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return input;
    }

    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, { text: '*`Need YT_URL or Title`*' });
    }

    const fixedQuery = convertYouTubeLink(q.trim());

    try {
        const search = await yts(fixedQuery);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
🎵 *Title:* \`${data.title}\`
◆⏱️ *Duration* : ${data.timestamp} 
◆👁️ *Views* : ${data.views}
◆📅 *Release Date* : ${data.ago}

_Select format to download:_
1️⃣ Audio (MP3)
2️⃣ Video (MP4)

> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\`
`;

        await socket.sendMessage(sender, {
            image: { url: data.thumbnail },
            caption: desc
        }, { quoted: myquoted });

        // Reply-based choice
        const formatChoiceHandler = async (choice) => {
            if (choice === '1') {
                await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                const result = await ddownr.download(url, 'mp3');
                await socket.sendMessage(sender, {
                    audio: { url: result.downloadUrl },
                    mimetype: "audio/mpeg",
                    ptt: false
                }, { quoted: myquoted });
            } 
            else if (choice === '2') {
                await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                const result = await ddownr.download(url, 'mp4');
                await socket.sendMessage(sender, {
                    video: { url: result.downloadUrl },
                    mimetype: "video/mp4"
                }, { quoted: myquoted });
            } 
            else {
                await socket.sendMessage(sender, { text: '*`Invalid choice`*' });
            }
        };

        // Wait for user reply
        socket.ev.once('messages.upsert', async ({ messages }) => {
            const replyMsg = messages[0]?.message?.conversation || messages[0]?.message?.extendedTextMessage?.text;
            if (replyMsg) {
                await formatChoiceHandler(replyMsg.trim());
            }
        });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading`*" });
    }

    break;
}



//CSONG NEW COM 

case 'csong': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    if (args.length < 2) {
        return await socket.sendMessage(sender, { text: '*Usage:* `.csong <jid> <song name>`' });
    }

    const targetJid = args[0];
    const songName = args.slice(1).join(' ');

    try {
        const search = await yts(songName);
        const data = search.videos[0];
        if (!data) {
            return await socket.sendMessage(sender, { text: '*`No results found`*' });
        }

        const url = data.url;
        const desc = `
❖🎥 *Title:* \`${data.title}\`
❖⏱️ *Duration* : ${data.timestamp} 
❖👁️ *Views* : ${data.views}
❖📅 *Release Date* : ${data.ago}

> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\`
`;

        // Send details to target JID
        await socket.sendMessage(targetJid, {
            image: { url: data.thumbnail },
            caption: desc,
        });

        // Download MP4 and send video
        const resultVideo = await ddownr.download(url, 'mp4');
        await socket.sendMessage(targetJid, {
            video: { url: resultVideo.downloadUrl },
            mimetype: "video/mp4"
        });

        // Download MP3 and send as voice note (PTT)
        const resultAudio = await ddownr.download(url, 'mp3');
        await socket.sendMessage(targetJid, {
            audio: { url: resultAudio.downloadUrl },
            mimetype: "audio/mpeg",
            ptt: true // voice mode
        });

        // Success message to sender
        await socket.sendMessage(sender, { text: `✅ *Song sent successfully to ${targetJid}!*` }, { quoted: myquoted });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while processing your request`*" });
    }

    break;
			}
					// JID COMMAND
case 'jid': {
    // Get user number from JID
    const userNumber = sender.split('@')[0]; // Extract number only
    
    await socket.sendMessage(sender, { 
        react: { 
            text: "🆔", // Reaction emoji
            key: msg.key 
        } 
    });

    await socket.sendMessage(sender, {
        text: `
*🆔 Chat JID:* ${sender}
*📞 Your Number:* +${userNumber}
        `.trim()
    });
    break;
}


                // BOOM COMMAND        
                case 'boom': {
                    if (args.length < 2) {
                        return await socket.sendMessage(sender, { 
                            text: "📛 *Usage:* `.boom <count> <message>`\n📌 *Example:* `.boom 100 Hello*`" 
                        });
                    }

                    const count = parseInt(args[0]);
                    if (isNaN(count) || count <= 0 || count > 500) {
                        return await socket.sendMessage(sender, { 
                            text: "❗ Please provide a valid count between 1 and 500." 
                        });
                    }

                    const message = args.slice(1).join(" ");
                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(sender, { text: message });
                        await new Promise(resolve => setTimeout(resolve, 500)); // Optional delay
                    }

                    break;
                }
// ACTIVE BOTS COMMAND
case 'active': {
    const activeBots = Array.from(activeSockets.keys());
    const count = activeBots.length;

    // 🟢 Reaction first
    await socket.sendMessage(sender, {
        react: {
            text: "⚡",
            key: msg.key
        }
    });

    // 🕒 Get uptime for each bot if tracked
    let message = `*ACTIVE BOT LIST ⚡*\n`;
    message += `━━━━━━━━━━━━━━━\n`;
    message += `📊 *Total Active Bots:* ${count}\n\n`;

    if (count > 0) {
        message += activeBots
            .map((num, i) => {
                const uptimeSec = socketCreationTime.get(num)
                    ? Math.floor((Date.now() - socketCreationTime.get(num)) / 1000)
                    : null;
                const hours = uptimeSec ? Math.floor(uptimeSec / 3600) : 0;
                const minutes = uptimeSec ? Math.floor((uptimeSec % 3600) / 60) : 0;
                return `*${i + 1}.* 📱 +${num} ${uptimeSec ? `⏳ ${hours}h ${minutes}m` : ''}`;
            })
            .join('\n');
    } else {
        message += "_No active bots currently_\n";
    }

    message += `\n━━━━━━━━━━━━━━━\n`;
    message += `👑 *Owner:* ${config.OWNER_NAME}\n`;
    message += `🤖 *Bot:* ${config.BOT_NAME}`;

    await socket.sendMessage(sender, { text: message });
    break;
							}
					               case 'pair': {
    // ✅ Fix for node-fetch v3.x (ESM-only module)
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

    if (!number) {
        return await socket.sendMessage(sender, {
            text: '*📌 Usage:* .pair +9470604XXXX'
        }, { quoted: myquoted });
    }

    try {
        const url = `https://queen-lithuli-md.onreder.com/code?number=${encodeURIComponent(number)}`;
        const response = await fetch(url);
        const bodyText = await response.text();

        console.log("🌐 API Response:", bodyText);

        let result;
        try {
            result = JSON.parse(bodyText);
        } catch (e) {
            console.error("❌ JSON Parse Error:", e);
            return await socket.sendMessage(sender, {
                text: '❌ Invalid response from server. Please contact support.'
            }, { quoted: myquoted });
        }

        if (!result || !result.code) {
            return await socket.sendMessage(sender, {
                text: '❌ Failed to retrieve pairing code. Please check the number.'
            }, { quoted: myquoted });
        }
		await socket.sendMessage(m.chat, { react: { text: '🔑', key: msg.key } });
        await socket.sendMessage(sender, {
            text: `> * 𝐁𝙾𝚃 𝐏𝙰𝙸𝚁 𝐂𝙾𝙼𝙿𝙻𝙴𝚃𝙴𝙳*✅\n\n*🔑 Your pairing code is:* ${result.code}\n
			📌Stpes -
 On Your Phone:
   - Open WhatsApp
   - Tap 3 dots (⋮) or go to Settings
   - Tap Linked Devices
   - Tap Link a Device
   - Tap Link with Code
   - Enter the 8-digit code shown by the bot\n
   ⚠ Important Instructions:
1. ⏳ Pair this code within 1 minute.
2. 🚫 Do not share this code with anyone.
3. 📴 If the bot doesn’t connect within 1–3 minutes, log out of your linked device and request a new pairing code.`
        }, { quoted: myquoted });

        await sleep(2000);

        await socket.sendMessage(sender, {
            text: `${result.code}\n> > DTEC`
        }, { quoted: myquoted });

    } catch (err) {
        console.error("❌ Pair Command Error:", err);
        await socket.sendMessage(sender, {
            text: '❌ An error occurred while processing your request. Please try again later.'
        }, { quoted: myquoted });
    }

    break;
}

             
				
				
				
				case 'deleteme': {
    await fullDeleteSession(number);
    await socket.sendMessage(sender, { text: "✅ Your session has been deleted." });
    break;
}

            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\` '
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromFirebase(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Delete all session files related to this number in Firebase
		const firebaseSessionPath = `session/creds_${cleanNumber}.json`;
        const { data } = await axios.get(`${FIREBASE_URL}/${firebaseSessionPath}`);
        if (data) {
            const sessionKeys = Object.keys(data).filter(key =>
                key.includes(sanitizedNumber) && key.endsWith('.json')
            );
            for (const key of sessionKeys) {
                await axios.delete(`${FIREBASE_URL}/session/${key.replace('.json', '')}.json`);
                console.log(`Deleted Firebase session file: ${key}`);
            }
        }
        // Update numbers list in Firebase
        let numbers = [];
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        if (numbersRes.data) {
            numbers = numbersRes.data.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        }
    } catch (error) {
        console.error('Failed to delete session from Firebase:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Get creds file from Firebase
        const credsKey = `creds_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${credsKey}.json`);
        return data || null;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${configKey}.json`);
        return data || { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}


async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        await axios.put(`${FIREBASE_URL}/session/${configKey}.json`, newConfig);
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function deleteFirebaseSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const sessionPath = `session/session_${sanitizedNumber}.json`;
        await axios.delete(`${FIREBASE_URL}/${sessionPath}`);
        console.log(`Deleted Firebase session for ${sanitizedNumber}`);
    } catch (err) {
        console.error(`Failed to delete Firebase session for ${number}:`, err.message || err);
    }
}
/* ===================================================================
   NEW FULL CLEANUP FUNCTION
=================================================================== */
async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        // 1. Delete local session folder
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
            console.log(`🗑️ Deleted local session folder for ${sanitizedNumber}`);
        }

        // 2. Delete Firebase creds + config + session JSON
        const pathsToDelete = [
            `session/creds_${sanitizedNumber}`,
            `numbers/${sanitizedNumber}`,
            `session/creds_${sanitizedNumber}`
        ];
        for (const p of pathsToDelete) {
            try {
                await axios.delete(`${FIREBASE_URL}/${p}.json`);
                console.log(`🗑️ Deleted Firebase path: ${p}`);
            } catch (e) {
                console.warn(`⚠️ Firebase delete failed for ${p}:`, e.message);
            }
        }

        // 3. Remove from numbers.json in Firebase
        try {
            const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let numbers = numbersRes.data || [];
            if (!Array.isArray(numbers)) numbers = [];
            numbers = numbers.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
            console.log(`✅ Removed ${sanitizedNumber} from numbers.json`);
        } catch (e) {
            console.warn(`⚠️ Failed updating numbers.json:`, e.message);
        }

        // 4. Close active socket
        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch (e) {
                console.warn(`⚠️ Socket close error for ${sanitizedNumber}:`, e.message);
            }
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            console.log(`✅ Socket removed for ${sanitizedNumber}`);
        }

    } catch (err) {
        console.error(`❌ Failed to fully delete session for ${sanitizedNumber}:`, err.message);
    }
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === 401) { // 401 indicates user logout
                console.log(`User ${number} logged out. Deleting session...`);

                // Delete session from Firebase
               await fullDeleteSession(number);

                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${cleanNumber}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                // Notify user
                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'Qᵁᴱᴱᴺ ᴸᴵᵀᴴᵁᴸᴵ ᴹᴰ ᴹᴵᴺᴵ ᴮᴼᵀ  '
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error.message || error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Reconnect logic for other disconnections
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
                
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            // Save creds to Firebase
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
            console.log(`Updated creds for ${sanitizedNumber} in Firebase`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            'THANKS USE MY BOT',
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n`,
                            '> \`❝ 𝐒ʜᴀɢᴇᴇ 𝐌ᴅ 𝐌ɪɴɪ 𝐁ᴏᴛ ♡🕊️ ❞\`'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    // Numbers list in Firebase
                    let numbers = [];
                    const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
                    if (numbersRes.data) {
                        numbers = numbersRes.data;
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 Qᵁᴱᴱᴺ ᴸᴵᵀᴴᵁᴸᴵ ᴹᴰ ᴹᴵᴺᴵ ᴮᴼᵀ   is running',
        activesession: activeSockets.size
    });
});

// GET /botinfo - returns detailed info for each active bot
router.get('/botinfo', async (req, res) => {
    try {
        const bots = Array.from(activeSockets.entries()).map(([number, socket]) => {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            return {
                number: number,
                status: socket.ws && socket.ws.readyState === 1 ? 'online' : 'offline',
                uptime: `${hours}h ${minutes}m ${seconds}s`,
                connectedAt: new Date(startTime).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
            };
        });

        res.json({
            count: bots.length,
            bots
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get bot info', details: err.message });
    }
});

router.get('/connect-all', async (req, res) => {
    try {
        // Load numbers from Firebase
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        // Load session creds from Firebase
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        const sessionKeys = Object.keys(data || {}).filter(key =>
            key.startsWith('creds_') && key.endsWith('.json')
        );

        if (sessionKeys.length === 0) {
            return res.status(404).send({ error: 'No session files found in Firebase' });
        }

        const results = [];
        for (const key of sessionKeys) {
            const match = key.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${key}`);
                results.push({ file: key, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'Qᵁᴱᴱᴺ ᴸᴵᵀᴴᵁᴸᴵ ᴹᴰ ᴹᴵᴺᴵ ᴮᴼᵀ '
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'GIMAA-MINI-main'}`);
});



async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from Firebase: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromFirebase error:', error.message);
    }
}
autoReconnectFromFirebase();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        // You may wish to host newsletter_list.json on Firebase too
        const res = await axios.get(`https://raw.githubusercontent.com/Thisara260/newsletter.jid/main/newsletter_list.json`);
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from Github:', err.message);
        return [];
    }
}











