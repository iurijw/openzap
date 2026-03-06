const path = require('path');
const { loadConfig } = require('../config');

const ROLE_MASTER = 'master';

/**
 * Tools que NUNCA podem ser liberadas para users, independente do config.
 * Segurança: execução de comandos, cron e criação de ferramentas podem causar dano irreversível.
 */
const NEVER_ALLOW_FOR_USERS = new Set([
    'executar_comando',
    'gerenciar_cron',
    'gerenciar_ferramentas',
]);

/**
 * Set de tools nativas conhecidas (para distinguir de custom tools).
 */
const BUILTIN_TOOLS = new Set([
    'executar_comando', 'ler_arquivo', 'escrever_arquivo', 'listar_arquivos',
    'gerenciar_cron', 'acoes_whatsapp', 'gerenciar_ferramentas',
]);

/**
 * Resolve o target JID de uma chamada de ações WhatsApp (para verificação de permissão).
 */
function resolveTargetForPermission(args) {
    if (args.target_jid) return args.target_jid;
    if (args.phone) {
        const cleaned = args.phone.replace(/[^0-9]/g, '');
        return `${cleaned}@s.whatsapp.net`;
    }
    return null;
}

/**
 * Valida se a operação é permitida para o role.
 * Master pode TUDO. User tem restrições — mas o master pode liberar
 * tools específicas via `user_allowed_tools` no config.json.
 *
 * Suporta:
 * - master_shared_user/ — leitura para users, escrita+leitura para master
 * - whatsapp_permissions — controle granular de ações e destinatários WhatsApp
 * - Custom tools — bloqueadas para users por padrão, liberáveis via user_allowed_tools
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

    // 3. Custom tools (não nativas): bloqueadas por padrão, liberáveis via user_allowed_tools
    if (!BUILTIN_TOOLS.has(toolName)) {
        if (!isToolAllowed) {
            return {
                allowed: false,
                reason: 'Ferramenta não disponível para usuários.',
            };
        }
        return { allowed: true };
    }

    // 4. acoes_whatsapp: bloqueado por padrão, liberável via config, com permissões granulares
    if (toolName === 'acoes_whatsapp') {
        if (!isToolAllowed) {
            return {
                allowed: false,
                reason: 'Operação não disponível para usuários.',
            };
        }

        // Permissões granulares do WhatsApp
        const whatsappPerms = config?.whatsapp_permissions;
        if (whatsappPerms) {
            // Verificar ações permitidas
            if (whatsappPerms.allowed_actions && whatsappPerms.allowed_actions.length > 0) {
                if (!whatsappPerms.allowed_actions.includes(args.action)) {
                    return {
                        allowed: false,
                        reason: `Ação "${args.action}" não autorizada.`,
                    };
                }
            }

            // Verificar destinatários permitidos
            if (whatsappPerms.allowed_targets && whatsappPerms.allowed_targets.length > 0) {
                const targetJid = resolveTargetForPermission(args);

                if (targetJid) {
                    const masterJid = config?.master_jid;

                    const isTargetAllowed = whatsappPerms.allowed_targets.some(target => {
                        // "master" é palavra especial → resolve para master_jid
                        if (target === 'master' && masterJid) {
                            return targetJid === masterJid;
                        }
                        // "sender" → resolve para o remetente atual
                        if (target === 'sender') {
                            return targetJid === context.sender;
                        }
                        // JID literal (com @)
                        if (target.includes('@')) {
                            return targetJid === target;
                        }
                        // Número de telefone (sem @) → converte para JID
                        const targetAsJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                        return targetJid === targetAsJid;
                    });

                    if (!isTargetAllowed) {
                        return {
                            allowed: false,
                            reason: 'Destinatário não autorizado.',
                        };
                    }
                }
            }
        }

        // Liberado (com ou sem restrições granulares)
        return { allowed: true };
    }

    // 5. file_write: user só pode escrever na sua pasta pessoal
    //    master_shared_user/ é somente leitura para users
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

    // 6. file_read: user pode ler config, sua pasta, e master_shared_user/
    if (toolName === 'ler_arquivo') {
        const targetPath = path.normalize(args.path || '');

        const allowedPaths = [
            'config.json',
            `users/${phone}`,
            'master_shared_user',
        ];

        const isAllowed = allowedPaths.some(prefix => targetPath.startsWith(prefix));

        if (!isAllowed) {
            return {
                allowed: false,
                reason: 'Não tenho acesso a essa informação.',
            };
        }
    }

    // 7. file_list: user pode listar sua pasta e master_shared_user/
    if (toolName === 'listar_arquivos') {
        const targetPath = path.normalize(args.path || '');

        // Não pode listar raiz (veria estrutura toda) nem pasta de outros users
        if (targetPath === '' || targetPath === '.' || targetPath === 'users') {
            return {
                allowed: false,
                reason: 'Não tenho permissão para listar esse diretório.',
            };
        }

        const allowedPrefixes = [
            `users/${phone}`,
            'master_shared_user',
        ];

        if (!allowedPrefixes.some(prefix => targetPath.startsWith(prefix))) {
            return {
                allowed: false,
                reason: 'Não tenho permissão para listar esse diretório.',
            };
        }
    }

    return { allowed: true };
}

module.exports = { checkPermission };
