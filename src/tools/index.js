const path = require('path');
const { checkPermission } = require('./permissions');
const { getToolDefinitions } = require('./definitions');
const fileRead = require('./file_read');
const fileWrite = require('./file_write');
const fileList = require('./file_list');
const execCommand = require('./exec');
const cronHandler = require('./cron');
const whatsappActions = require('./whatsapp_actions');
const logger = require('../utils/logger');

const handlers = {
    'ler_arquivo': fileRead,
    'escrever_arquivo': fileWrite,
    'listar_arquivos': fileList,
    'executar_comando': execCommand,
    'gerenciar_cron': cronHandler,
    'acoes_whatsapp': whatsappActions,
};

/**
 * Dispatcher de tools com validação de permissão e sanitização de paths.
 * @param {string} name - Nome da tool
 * @param {object} args - Argumentos da tool
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<object>} Resultado da tool ou { error: string }
 */
async function dispatchTool(name, args, context) {
    logger.info({ tool: name, args, role: context.role, phone: context.phone }, 'Tool chamada');

    // 1. Checa permissão ANTES de executar
    const perm = checkPermission(name, args, context);

    if (!perm.allowed) {
        logger.warn({ tool: name, role: context.role, phone: context.phone, reason: perm.reason }, 'Tool bloqueada por permissão');
        return { error: perm.reason };
    }

    // 2. Sanitiza paths (impede path traversal)
    if (args.path) {
        const normalized = path.normalize(args.path);
        if (normalized.includes('..') || path.isAbsolute(normalized)) {
            logger.warn({ tool: name, path: args.path }, 'Tentativa de path traversal bloqueada');
            return { error: 'Caminho inválido.' };
        }
        // Usa o path normalizado
        args.path = normalized;
    }

    // 3. Executa
    const handler = handlers[name];
    if (!handler) {
        logger.warn({ tool: name }, 'Tool desconhecida');
        return { error: 'Ferramenta desconhecida.' };
    }

    try {
        const result = await handler(args, context);
        logger.info({ tool: name, success: true }, 'Tool executada');
        return result;
    } catch (err) {
        logger.error({ err, tool: name }, 'Erro ao executar tool');
        return { error: `Erro: ${err.message}` };
    }
}

module.exports = { dispatchTool, getToolDefinitions };
