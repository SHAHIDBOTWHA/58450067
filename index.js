const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : 'https://58450067-production.up.railway.app';

const publicDir = path.join(__dirname, 'public');
const indexHtmlPath = path.join(publicDir, 'index.html');

app.use(express.json());
app.use(express.static(publicDir));

app.get('/', (req, res) => {
    if (fs.existsSync(indexHtmlPath)) {
        return res.sendFile(indexHtmlPath);
    }
    return res.status(200).send('Server is running, but public/index.html was not found.');
});

app.get('/status', (req, res) => {
    res.json({ ok: true, site: SITE_URL });
});

app.post('/pair', async (req, res) => {
    let { number } = req.body;

    if (!number) {
        return res.status(400).json({ error: 'لطفاً شماره را وارد کنید.' });
    }

    number = number.replace(/[^0-9]/g, '');
    if (number.length < 8) {
        return res.status(400).json({ error: 'شماره را همراه با کد کشور وارد کنید.' });
    }

    const sessionPath = path.join(__dirname, 'sessions', number);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection }) => {
            if (connection === 'open') {
                console.log(`Connected: ${number}`);
                await sock.sendMessage(sock.user.id, {
                    text: '✅ ربات شما با موفقیت متصل شد.'
                });
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const body =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';

            if (body === '.ping' || body === 'سلام') {
                await sock.sendMessage(msg.key.remoteJid, { text: 'ربات فعال است!' });
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            const code = await sock.requestPairingCode(number);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            return res.json({ code: formatted });
        }

        return res.json({ message: 'این شماره قبلاً متصل است.' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'خطا در تولید کد. کمی بعد دوباره تلاش کنید.' });
    }
});

app.listen(PORT, () => {
    console.log(`Running on ${SITE_URL} (port ${PORT})`);
});
