const path = require('path');

const ROLE_MASTER = 'master';

/**
 * Valida se a operação é permitida para o role.
 * Master pode TUDO. User tem restrições de segurança.
 *
 * @param {string} toolName - Nome da tool
 * @param {object} args - Argumentos da tool
 * @param {object} context - { phone, role, sender }
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkPermission(toolName, args, context) {
    const { role, phone } = context;

    // Master pode TUDO
    if (role === ROLE_MASTER) {
        return { allowed: true };
    }

    // === USER — restrições ===

    // 1. exec: PROIBIDO para users
    if (toolName === 'executar_comando') {
        return {
            allowed: false,
            reason: 'Operação não disponível para usuários.',
        };
    }

    // 2. cron: PROIBIDO para users
    if (toolName === 'gerenciar_cron') {
        return {
            allowed: false,
            reason: 'Apenas o administrador pode gerenciar tarefas agendadas.',
        };
    }

    // 3. acoes_whatsapp: PROIBIDO para users (só master pode fazer ações autônomas)
    if (toolName === 'acoes_whatsapp') {
        return {
            allowed: false,
            reason: 'Operação não disponível para usuários.',
        };
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
