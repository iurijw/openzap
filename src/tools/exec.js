const { execSync } = require('child_process');
const { DATA_DIR } = require('../config');
const logger = require('../utils/logger');

// Limite de saída para evitar payloads gigantes
const MAX_OUTPUT_LENGTH = 10000;

/**
 * Executa um comando shell no diretório /data/.
 * @param {object} args - { command: string }
 * @param {object} context - Contexto de permissão (já validado)
 * @returns {Promise<object>} { stdout: string, exitCode: number } ou { error: string }
 */
async function execCommand(args, context) {
    const { command } = args;

    logger.info({ command, phone: context.phone }, 'Executando comando shell');

    try {
        const stdout = execSync(command, {
            cwd: DATA_DIR,
            timeout: 30000,          // 30 segundos de timeout
            maxBuffer: 1024 * 1024,  // 1MB de buffer
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const output = stdout.length > MAX_OUTPUT_LENGTH
            ? stdout.substring(0, MAX_OUTPUT_LENGTH) + '\n... (saída truncada)'
            : stdout;

        return { stdout: output, exitCode: 0 };
    } catch (err) {
        const stderr = err.stderr || err.message || 'Erro desconhecido';
        const stdout = err.stdout || '';

        logger.warn({ command, exitCode: err.status, stderr }, 'Comando falhou');

        return {
            stdout: stdout.substring(0, MAX_OUTPUT_LENGTH),
            stderr: stderr.substring(0, MAX_OUTPUT_LENGTH),
            exitCode: err.status || 1,
        };
    }
}

module.exports = execCommand;
