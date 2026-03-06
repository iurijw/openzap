/**
 * Definições de tools para a Anthropic Claude API (tool use format).
 * Cada tool tem nome em português para manter coerência com o prompt.
 */

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
        description: 'Gerencia tarefas agendadas (cron jobs). Cria lembretes automáticos, notificações recorrentes, rotinas periódicas, etc. Quando o cron dispara, o assistente executa a instrução e envia a mensagem ao destinatário.',
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
                    description: 'Instrução que o assistente seguirá quando o cron disparar. Pode ler arquivos, executar comandos, etc.',
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
];

function getToolDefinitions() {
    return toolDefinitions;
}

module.exports = { getToolDefinitions };
