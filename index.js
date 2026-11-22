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
    DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : 'https://58450067-production.up.railway.app';

const PAIR_TAG = 'SHAHID74';
const publicFolder = path.join(__dirname, 'public');
const indexFile = path.join(publicFolder, 'index.html');
const sessionsRoot = path.join(__dirname, 'sessions');

// نگهداری سوکت‌های فعال در حافظه تا پس از گرفتن کد بسته نشوند
const activeSockets = new Map();

app.use(express.json());
app.use(express.static(publicFolder));

app.get('/', (req, res) => {
    if (fs.existsSync(indexFile)) {
        return res.sendFile(indexFile);
    }
    return res.status(404).send('public/index.html not found');
});

app.get('/status', (req, res) => {
    res.json({ ok: true, site: SITE_URL, tag: PAIR_TAG });
});

function buildMenuText() {
    return [
        '╔══════════════════════╗',
        '       📋 منوی ربات واتساپ',
        '╚══════════════════════╝',
        '',
        'این ربات توسط KING SHAHID جور شده است.',
        `شناسه: ${PAIR_TAG}`,
        '',
        '📌 دستورات قابل استفاده:',
        '• .MENU — نمایش این منو',
        '• .PING — بررسی وضعیت اتصال ربات',
        '• سلام — پیام خوش‌آمدگویی'
    ].join('\n');
}

function attachEvents(sock, number, sessionFolder) {
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`Connected successfully: ${number} (${PAIR_TAG})`);
            try {
                await sock.sendMessage(sock.user.id, {
                    text: `✅ ربات (${PAIR_TAG}) با موفقیت به واتساپ متصل شد!\nبرای دیدن منو دستور .MENU را بفرستید.\n\nاین ربات توسط KING SHAHID جور شده است.`
                });
            } catch (e) {
                console.error('Welcome message error:', e.message);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${number}. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

            if (statusCode === DisconnectReason.loggedOut) {
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
        if (!msg || !msg.message || msg.key.fromMe) return;

        const body = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            ''
        ).trim();

        if (body.toUpperCase() === '.MENU') {
            await sock.sendMessage(msg.key.remoteJid, { text: buildMenuText() });
        } else if (body.toUpperCase() === '.PING') {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `🟢 ربات فعال است (${PAIR_TAG})!\nاین ربات توسط KING SHAHID جور شده است.`
            });
        } else if (body === 'سلام') {
            await sock.sendMessage(msg.key.remoteJid, {
                text: 'سلام! خوش آمدید. برای مشاهده منو .MENU را بفرستید.'
            });
        }
    });
}

async function startSocket(number, { freshSession = false, isReconnect = false } = {}) {
    const sessionFolder = path.join(sessionsRoot, number);

    if (freshSession && fs.existsSync(sessionFolder)) {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
    }

    const oldSock = activeSockets.get(number);
    if (oldSock && !isReconnect) {
        try {
            oldSock.ws?.close();
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
        browser: ['Mac OS', 'Chrome', '124.0.0.0'],
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
        return res.status(400).json({ error: 'لطفاً شماره را وارد کنید.' });
    }

    number = number.replace(/[^0-9]/g, '');
    if (number.length < 8) {
        return res.status(400).json({ error: 'شماره را همراه با کد کشور وارد کنید.' });
    }

    try {
        // شروع نشست تازه برای جلوگیری از گیر کردن روی نشست نیمه‌کاره قبلی
        const sock = await startSocket(number, { freshSession: true });

        if (!sock.authState.creds.registered) {
            await delay(2000);
            const rawCode = await sock.requestPairingCode(number);
            const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
            return res.json({
                code: formatted,
                tag: PAIR_TAG
            });
        }

        return res.json({
            message: 'این شماره قبلاً متصل است. در واتساپ .MENU را بفرستید.',
            tag: PAIR_TAG
        });
    } catch (err) {
        console.error('Pair error:', err);
        return res.status(500).json({
            error: 'خطا در تولید کد یا برقراری ارتباط با واتساپ. چند دقیقه صبر کنید و دوباره امتحان کنید.'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Running on ${SITE_URL} (port ${PORT})`);
});
