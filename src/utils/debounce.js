/**
 * Debounce de mensagens por remetente.
 * Agrupa mensagens rápidas (ex: 13s) em um único texto antes de processar.
 * Armazena em memória — não persiste entre restarts.
 */

const logger = require('./logger');

const DEBOUNCE_MS = (parseInt(process.env.DEBOUNCE_SECONDS, 10) || 13) * 1000;

// Map<sender, { texts: string[], timer: NodeJS.Timeout }>
const pending = new Map();

/**
 * @param {string} sender - JID do remetente
 * @param {string} text - Texto da mensagem individual
 * @param {(fullText: string) => Promise<void>} callback - Chamado com texto agrupado após debounce
 */
function debounce(sender, text, callback) {
    let entry = pending.get(sender);

    if (entry) {
        // Já existe timer pendente — acumula texto e reinicia timer
        entry.texts.push(text);
        clearTimeout(entry.timer);
        logger.debug({ sender, queued: entry.texts.length }, 'Debounce: mensagem acumulada');
    } else {
        entry = { texts: [text], timer: null };
        pending.set(sender, entry);
        logger.debug({ sender }, 'Debounce: nova entrada');
    }

    entry.timer = setTimeout(async () => {
        const fullText = entry.texts.join('\n');
        pending.delete(sender);

        logger.info({ sender, parts: entry.texts.length, length: fullText.length }, 'Debounce: disparando callback');

        try {
            await callback(fullText);
        } catch (err) {
            logger.error({ err, sender }, 'Debounce: erro no callback');
        }
    }, DEBOUNCE_MS);
}

module.exports = { debounce };
