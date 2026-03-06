/**
 * Definições de tools para a Anthropic Claude API (tool use format).
 * Cada tool tem nome em português para manter coerência com o prompt.
 *
 * getToolDefinitions() carrega também ferramentas customizadas de /data/custom_tools/registry.json.
 */

const { loadRegistrySync } = require('./custom_tools');

const toolDefinitions = [
    {
        name: 'executar_comando',
        description: 'Executa um comando shell no computador Linux. Use para operações complexas, instalar ferramentas, rodar scripts, manipular dados, etc. Diretório de trabalho: /data/.',
        input_schema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'Comando shell para executar. Diretório de trabalho: /data/',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'ler_arquivo',
        description: 'Lê o conteúdo de um arquivo. Caminhos relativos a /data/.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Caminho do arquivo relativo a /data/. Ex: notas/reuniao.md',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'escrever_arquivo',
        description: 'Cria ou sobrescreve um arquivo. Cria diretórios automaticamente. Caminhos relativos a /data/.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Caminho do arquivo relativo a /data/.',
                },
                content: {
                    type: 'string',
                    description: 'Conteúdo completo do arquivo.',
                },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'listar_arquivos',
        description: 'Lista arquivos e pastas. Caminhos relativos a /data/.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Diretório para listar. Vazio = raiz /data/.',
                },
            },
            required: [],
        },
    },
    {
        name: 'gerenciar_cron',
        description: 'Gerencia tarefas agendadas (cron jobs). Suporta dois modos: "agent" (padrão — o assistente processa via Claude quando disparar) e "direct" (executa um script diretamente e envia stdout como mensagem, sem consumir tokens). Use "direct" para monitores, alertas e tarefas repetitivas simples.',
        input_schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['criar', 'listar', 'remover'],
                    description: 'Ação: criar novo cron, listar existentes, ou remover.',
                },
                schedule: {
                    type: 'string',
                    description: 'Expressão cron (5 campos). Ex: "0 8 * * 1-5" (seg-sex 8h), "*/5 13-18 * * 1-5" (cada 5min horário comercial). Horário UTC.',
                },
                prompt: {
                    type: 'string',
                    description: 'Instrução que o assistente seguirá quando o cron disparar (apenas para mode "agent").',
                },
                description: {
                    type: 'string',
                    description: 'Descrição legível do que o cron faz.',
                },
                target_jid: {
                    type: 'string',
                    description: 'JID do destinatário da mensagem. Se não informado, usa o remetente atual.',
                },
                job_id: {
                    type: 'string',
                    description: 'ID do cron job (obrigatório para ação "remover").',
                },
                mode: {
                    type: 'string',
                    enum: ['agent', 'direct'],
                    description: 'Modo de execução. "agent" (padrão): processa via Claude. "direct": executa script e envia stdout como mensagem (não consome tokens).',
                },
                script: {
                    type: 'string',
                    description: 'Caminho do script relativo a /data/ (obrigatório para mode "direct"). O stdout do script será enviado como mensagem. Ex: scripts/bitcoin_monitor.sh',
                },
            },
            required: ['action'],
        },
    },
    {
        name: 'acoes_whatsapp',
        description: 'Realiza ações no WhatsApp via Baileys: enviar mensagem para outro contato, enviar áudio sintetizado (TTS), verificar se contato existe, obter info do perfil. Use para comunicação autônoma.',
        input_schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['enviar_mensagem', 'enviar_audio', 'verificar_contato', 'info_perfil'],
                    description: 'Ação a executar no WhatsApp.',
                },
                target_jid: {
                    type: 'string',
                    description: 'JID do destinatário. Formato: "5511999999999@s.whatsapp.net" ou LID.',
                },
                phone: {
                    type: 'string',
                    description: 'Número de telefone (com código do país, sem +). Alternativa ao target_jid — será convertido automaticamente.',
                },
                text: {
                    type: 'string',
                    description: 'Texto da mensagem (para enviar_mensagem) ou texto para sintetizar em voz (para enviar_audio).',
                },
            },
            required: ['action'],
        },
    },
    {
        name: 'gerenciar_ferramentas',
        description: 'Cria, edita, lista e remove ferramentas customizadas. Ferramentas são scripts Node.js que ficam disponíveis como tools do agente. O código deve exportar: module.exports = async function(args, context) { ... return { resultado }; }. Pode usar require() para módulos Node.js (fs, path, child_process, https, etc.).',
        input_schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['criar', 'editar', 'listar', 'remover', 'ver_codigo'],
                    description: 'Ação a executar.',
                },
                name: {
                    type: 'string',
                    description: 'Nome da ferramenta (letras minúsculas, números, underscore, começa com letra). Ex: bitcoin_price, consultar_cep',
                },
                description: {
                    type: 'string',
                    description: 'Descrição do que a ferramenta faz.',
                },
                input_schema: {
                    type: 'object',
                    description: 'Schema dos parâmetros da ferramenta (formato JSON Schema). Define os argumentos que a ferramenta aceita.',
                },
                code: {
                    type: 'string',
                    description: 'Código JavaScript do handler. Deve exportar uma função: module.exports = async function(args, context) { ... return { resultado }; }. O context contém: { phone, role, sender }.',
                },
            },
            required: ['action'],
        },
    },
];

/**
 * Retorna todas as definições de tools (nativas + customizadas).
 * Carrega custom tools do registry a cada chamada para refletir mudanças em tempo real.
 * @returns {Array} Array de tool definitions no formato Anthropic
 */
function getToolDefinitions() {
    const allTools = [...toolDefinitions];

    // Load custom tools from registry (sync for compatibility with agent loop)
    const customTools = loadRegistrySync();

    for (const tool of customTools) {
        allTools.push({
            name: tool.name,
            description: tool.description || 'Ferramenta customizada',
            input_schema: tool.input_schema || { type: 'object', properties: {}, required: [] },
        });
    }

    return allTools;
}

module.exports = { getToolDefinitions };
