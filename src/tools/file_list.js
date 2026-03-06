const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../config');

/**
 * Lista arquivos e diretórios em /data/.
 * @param {object} args - { path?: string }
 * @param {object} context - Contexto de permissão (já validado)
 * @returns {Promise<object>} { entries: Array<{ name, type }> } ou { error: string }
 */
async function fileList(args, context) {
    const dirPath = path.join(DATA_DIR, args.path || '');

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        const result = entries.map(entry => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
        }));

        return { entries: result };
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { error: `Diretório não encontrado: ${args.path || '/'}` };
        }
        throw err;
    }
}

module.exports = fileList;
