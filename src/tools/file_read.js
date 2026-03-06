const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../config');

/**
 * Lê o conteúdo de um arquivo em /data/.
 * @param {object} args - { path: string }
 * @param {object} context - Contexto de permissão (já validado)
 * @returns {Promise<object>} { content: string } ou { error: string }
 */
async function fileRead(args, context) {
    const filePath = path.join(DATA_DIR, args.path);

    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return { content };
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { error: `Arquivo não encontrado: ${args.path}` };
        }
        throw err;
    }
}

module.exports = fileRead;
