const fs = require('fs/promises');
const path = require('path');
const logger = require('./utils/logger');
const { DATA_DIR, MEMORY_MAX_MESSAGES } = require('./config');

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

/**
 * Extrai o número de telefone de um JID do WhatsApp.
 */
function phoneFromJid(sender) {
    return sender.replace('@s.whatsapp.net', '').replace('@lid', '');
}

/**
 * Retorna o histórico de mensagens de um contato.
 * @param {string} sender - JID do remetente
 * @returns {Promise<Array>} Array de mensagens { role, content }
 */
async function getHistory(sender) {
    const file = path.join(MEMORY_DIR, `${phoneFromJid(sender)}.json`);
    try {
        const data = await fs.readFile(file, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

/**
 * Salva o histórico de mensagens de um contato.
 * Mantém apenas as últimas MEMORY_MAX_MESSAGES mensagens.
 * @param {string} sender - JID do remetente
 * @param {Array} history - Array de mensagens
 */
async function saveHistory(sender, history) {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    const file = path.join(MEMORY_DIR, `${phoneFromJid(sender)}.json`);

    // Manter só as últimas N mensagens
    const trimmed = history.slice(-MEMORY_MAX_MESSAGES);
    await fs.writeFile(file, JSON.stringify(trimmed, null, 2));

    logger.debug({ sender, count: trimmed.length }, 'Histórico salvo');
}

module.exports = { getHistory, saveHistory };
