const { startWhatsApp } = require('./whatsapp');
const { handleMessage } = require('./router');
const { initCron } = require('./cron');
const oauth = require('./oauth');
const logger = require('./utils/logger');
const { MASTER_PHONE, ANTHROPIC_API_KEY, OPENAI_API_KEY, DATA_DIR } = require('./config');
const fs = require('fs/promises');

/**
 * Entry point: valida configuração e inicia o bot.
 */
async function main() {
    logger.info('==========================================');
    logger.info('  OpenZap — Agente Autônomo de WhatsApp');
    logger.info('==========================================');

    // --- Validação de autenticação Claude ---
    const hasApiKey = ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== 'sk-ant-...';
    const hasOAuth = oauth.isConfigured();
    const hasOAuthTokens = hasOAuth && await oauth.hasValidTokens();

    if (!hasApiKey && !hasOAuth) {
        logger.error('Nenhuma autenticação Claude configurada.');
        logger.error('Configure ANTHROPIC_API_KEY ou OAuth (CLAUDE_OAUTH_CLIENT_ID) no .env');
        process.exit(1);
    }

    if (hasApiKey) {
        logger.info('Auth Claude: API key configurada');
    }

    if (hasOAuth) {
        if (hasOAuthTokens) {
            logger.info('Auth Claude: OAuth conectado (tokens válidos)');
        } else {
            logger.info('Auth Claude: OAuth configurado (aguardando autorização via WhatsApp)');
        }
    }

    if (!hasApiKey && hasOAuth && !hasOAuthTokens) {
        logger.warn('Sem API key e OAuth ainda não autorizado.');
        logger.warn('O bot iniciará mas enviará link de autorização na primeira mensagem do master.');
    }

    // --- OpenAI (opcional) ---
    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'sk-...') {
        logger.warn('OPENAI_API_KEY não configurada. Funcionalidades de áudio/imagem estarão indisponíveis.');
    }

    if (!MASTER_PHONE || MASTER_PHONE === '5545999999999') {
        logger.warn('MASTER_PHONE não configurado ou usando valor padrão. Edite o arquivo .env');
    }

    // --- Garantir que o diretório /data existe ---
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        logger.info({ dataDir: DATA_DIR }, 'Diretório de dados OK');
    } catch (err) {
        logger.error({ err, dataDir: DATA_DIR }, 'Falha ao criar diretório de dados');
        process.exit(1);
    }

    // --- Iniciar WhatsApp ---
    logger.info('Iniciando conexão com WhatsApp...');
    logger.info('Aguarde o QR Code aparecer no terminal.');

    try {
        await startWhatsApp(handleMessage);
    } catch (err) {
        logger.error({ err }, 'Falha ao iniciar WhatsApp');
        process.exit(1);
    }

    // --- Iniciar sistema de cron ---
    try {
        await initCron();
    } catch (err) {
        logger.error({ err }, 'Falha ao iniciar sistema de cron');
        // Não fatal — bot funciona sem cron
    }
}

// --- Tratamento de erros globais ---
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught Exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled Rejection');
    process.exit(1);
});

// --- Graceful shutdown ---
process.on('SIGTERM', () => {
    logger.info('SIGTERM recebido. Encerrando...');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT recebido. Encerrando...');
    process.exit(0);
});

// --- Start ---
main();
