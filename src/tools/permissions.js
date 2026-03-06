const path = require('path');
const { loadConfig } = require('../config');

const ROLE_MASTER = 'master';

/**
 * Tools que NUNCA podem ser liberadas para users, independente do config.
 * Segurança: execução de comandos e cron podem causar dano irreversível.
 */
const NEVER_ALLOW_FOR_USERS = new Set([
    'executar_comando',
    'gerenciar_cron',
]);

/**
 * Valida se a operação é permitida para o role.
 * Master pode TUDO. User tem restrições — mas o master pode liberar
 * tools específicas via `user_allowed_tools` no config.json.
 *
 * @param {string} toolName - Nome da tool
 * @param {object} args - Argumentos da tool
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
async function checkPermission(toolName, args, context) {
    const { role, phone } = context;

    // Master pode TUDO
    if (role === ROLE_MASTER) {
        return { allowed: true };
    }

    // === USER — restrições ===

    // 1. Tools que NUNCA são liberadas para users (segurança)
    if (NEVER_ALLOW_FOR_USERS.has(toolName)) {
        return {
            allowed: false,
            reason: 'Operação não disponível para usuários.',
        };
    }

    // 2. Checar se o master liberou a tool via config.json
    const config = await loadConfig();
    const allowedTools = config?.user_allowed_tools || [];
    const isToolAllowed = allowedTools.includes(toolName);

    // 3. acoes_whatsapp: bloqueado por padrão, liberável via config
    if (toolName === 'acoes_whatsapp') {
        if (!isToolAllowed) {
            return {
                allowed: false,
                reason: 'Operação não disponível para usuários.',
            };
        }
        // Liberado pelo master via config
        return { allowed: true };
    }

    // 4. file_write: user só pode escrever na sua pasta pessoal
    if (toolName === 'escrever_arquivo') {
        const targetPath = path.normalize(args.path || '');
        const allowedPrefix = `users/${phone}`;

        if (!targetPath.startsWith(allowedPrefix)) {
            return {
                allowed: false,
                reason: 'Não tenho permissão para gravar nesse local.',
            };
        }
    }

    // 5. file_read: user pode ler config e sua própria pasta
    if (toolName === 'ler_arquivo') {
        const targetPath = path.normalize(args.path || '');

        const allowedPaths = [
            'config.json',
            `users/${phone}`,
        ];

        const isAllowed = allowedPaths.some(prefix => targetPath.startsWith(prefix));

        if (!isAllowed) {
            return {
                allowed: false,
                reason: 'Não tenho acesso a essa informação.',
            };
        }
    }

    // 6. file_list: user só pode listar sua pasta
    if (toolName === 'listar_arquivos') {
        const targetPath = path.normalize(args.path || '');

        // Não pode listar raiz (veria estrutura toda)
        if (targetPath === '' || targetPath === '.' || targetPath === 'users') {
            return {
                allowed: false,
                reason: 'Não tenho permissão para listar esse diretório.',
            };
        }

        const allowedPrefix = `users/${phone}`;

        if (!targetPath.startsWith(allowedPrefix)) {
            return {
                allowed: false,
                reason: 'Não tenho permissão para listar esse diretório.',
            };
        }
    }

    return { allowed: true };
}

module.exports = { checkPermission };
