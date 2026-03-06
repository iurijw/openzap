const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../config');
const logger = require('../utils/logger');

/**
 * Cria ou sobrescreve um arquivo em /data/.
 * Cria diretórios intermediários automaticamente.
 *
 * Caso especial: ao salvar config.json, injeta automaticamente o master_jid
 * do remetente para identificação futura do master (suporta LID).
 *
 * @param {object} args - { path: string, content: string }
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<object>} { success: true, path: string } ou { error: string }
 */
async function fileWrite(args, context) {
    const filePath = path.join(DATA_DIR, args.path);
    const dir = path.dirname(filePath);

    let content = args.content;

    // Auto-injetar master_jid no config.json quando salvo pelo master
    if (path.normalize(args.path) === 'config.json' && context.role === 'master') {
        try {
            const parsed = JSON.parse(content);

            // Sempre salvar o JID do master que está configurando
            parsed.master_jid = context.sender;

            content = JSON.stringify(parsed, null, 4);

            logger.info({ master_jid: context.sender }, 'master_jid injetado no config.json');
        } catch {
            // Se não for JSON válido, salvar como está
            logger.warn('config.json não é JSON válido — salvando sem injetar master_jid');
        }
    }

    // Cria diretórios intermediários
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, content, 'utf-8');

    return { success: true, path: args.path };
}

module.exports = fileWrite;
