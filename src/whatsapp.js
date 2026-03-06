const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const path = require('path');
const logger = require('./utils/logger');
const { DATA_DIR } = require('./config');
const { setSock: setCronSock } = require('./cron');

const AUTH_DIR = path.join(DATA_DIR, 'auth');

// Socket global — acessível por outros módulos via getSock()
let currentSock = null;

/**
 * Retorna o socket Baileys atual.
 * Usado pelas tools para ações autônomas (enviar mensagens, chamadas, etc).
 * @returns {object|null} Socket do Baileys
 */
function getSock() {
    return currentSock;
}

/**
 * Inicia a conexão com o WhatsApp via Baileys.
 * QR Code aparece no terminal (docker logs).
 * Reconecta automaticamente em caso de desconexão.
 *
 * @param {(sock: object, msg: object) => Promise<void>} onMessage - Callback para mensagens recebidas
 * @returns {Promise<object>} Socket do Baileys
 */
async function startWhatsApp(onMessage) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: logger.child({ module: 'baileys' }),
        // Configurações para estabilidade
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
    });

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Gerenciar estado da conexão
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n');
            console.log('╔══════════════════════════════════════════╗');
            console.log('║         ESCANEIE O QR CODE ABAIXO       ║');
            console.log('║  WhatsApp > Menu > Dispositivos > (+)   ║');
            console.log('╚══════════════════════════════════════════╝');
            console.log('');
            qrcode.generate(qr, { small: true });
            console.log('');
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            logger.warn({ statusCode, shouldReconnect }, 'Conexão fechada');

            if (shouldReconnect) {
                logger.info('Reconectando em 3 segundos...');
                setTimeout(() => startWhatsApp(onMessage), 3000);
            } else {
                logger.error('Sessão encerrada (loggedOut). Remova /data/auth/ e reinicie para gerar novo QR.');
            }
        }

        if (connection === 'open') {
            logger.info('WhatsApp conectado com sucesso!');
            currentSock = sock;
            setCronSock(sock);
        }
    });

    // Receber mensagens
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Só processar mensagens novas (notify), não históricas
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensagens enviadas por nós mesmos
            if (msg.key.fromMe) continue;

            // Ignorar mensagens sem conteúdo
            if (!msg.message) continue;

            // Ignorar mensagens de protocolo (reactions, receipts, etc.)
            if (msg.message.protocolMessage || msg.message.reactionMessage) continue;

            try {
                await onMessage(sock, msg);
            } catch (err) {
                logger.error({ err, msgId: msg.key.id }, 'Erro no handler de mensagem');
            }
        }
    });

    return sock;
}

module.exports = { startWhatsApp, getSock };
