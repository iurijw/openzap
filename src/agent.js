const Anthropic = require('@anthropic-ai/sdk').default;
const { ANTHROPIC_API_KEY, CLAUDE_MODEL, MAX_TOOL_ITERATIONS, getSystemPrompt } = require('./config');
const oauth = require('./oauth');
const { getHistory, saveHistory } = require('./memory');
const { dispatchTool, getToolDefinitions } = require('./tools');
const logger = require('./utils/logger');

// Janela de contexto: últimas N mensagens enviadas para a API
const CONTEXT_WINDOW = 30;

/**
 * Cria um cliente Anthropic usando OAuth (prioridade) ou API key.
 * @returns {Promise<object|null>} Cliente Anthropic ou null se sem auth
 */
async function createClient() {
    // 1. Tentar OAuth primeiro
    if (oauth.isConfigured()) {
        const accessToken = await oauth.getAccessToken();
        if (accessToken) {
            logger.debug('Claude auth: OAuth');
            return new Anthropic({ authToken: accessToken });
        }
    }

    // 2. Fallback: API key
    if (ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== 'sk-ant-...') {
        logger.debug('Claude auth: API key');
        return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    }

    return null;
}

/**
 * Chama a API Claude com retry automático em caso de token expirado (401).
 * Se OAuth falhar, tenta fallback para API key.
 */
async function callClaude(params) {
    let client = await createClient();
    if (!client) {
        throw new Error('Nenhuma autenticação Claude configurada');
    }

    try {
        return await client.messages.create(params);
    } catch (err) {
        // Se 401 e estamos usando OAuth, tentar refresh + retry
        if (err.status === 401 && oauth.isConfigured()) {
            logger.warn('Claude 401 — tentando refresh do token OAuth...');
            try {
                await oauth.refreshAccessToken();
                const newToken = await oauth.getAccessToken();
                if (newToken) {
                    client = new Anthropic({ authToken: newToken });
                    return await client.messages.create(params);
                }
            } catch (refreshErr) {
                logger.error({ err: refreshErr }, 'Falha no refresh OAuth');
            }

            // Fallback final: API key (se disponível)
            if (ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== 'sk-ant-...') {
                logger.warn('OAuth falhou, usando API key como fallback');
                client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
                return await client.messages.create(params);
            }
        }

        throw err;
    }
}

/**
 * Converte o histórico simples (role/content strings) para o formato Anthropic Messages API.
 * Garante alternância user/assistant e coalescência de mensagens consecutivas do mesmo role.
 */
function buildAnthropicMessages(history) {
    const messages = [];

    for (const msg of history) {
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;
        if (!msg.content) continue;

        // Anthropic exige alternância user/assistant.
        // Se a última mensagem é do mesmo role, coalescer.
        if (messages.length > 0 && messages[messages.length - 1].role === msg.role) {
            messages[messages.length - 1].content += '\n' + msg.content;
        } else {
            messages.push({ role: msg.role, content: msg.content });
        }
    }

    return messages;
}

/**
 * Executa o loop de tool use do agente via Anthropic Claude.
 * @param {string} sender - JID do remetente
 * @param {string} phone - Número do telefone
 * @param {string} role - 'master' ou 'user'
 * @param {string} userMessage - Texto da mensagem do usuário
 * @param {object} [options] - Opções adicionais
 * @param {boolean} [options.fromCron=false] - Se true, não salva o prompt no histórico (só a resposta)
 * @returns {Promise<string>} Resposta final do agente
 */
async function runAgent(sender, phone, role, userMessage, { fromCron = false } = {}) {
    const systemPrompt = await getSystemPrompt(phone, role);
    const history = await getHistory(sender);

    // Para msgs normais, salva no histórico. Para cron, apenas no contexto da API.
    if (!fromCron) {
        history.push({ role: 'user', content: userMessage });
    }

    // Monta mensagens para a API (últimas N do histórico, formato Anthropic)
    let messages = buildAnthropicMessages(history.slice(-CONTEXT_WINDOW));

    // Para cron, adiciona o prompt como msg temporária (não persiste no histórico)
    if (fromCron) {
        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
            messages[messages.length - 1].content += '\n' + userMessage;
        } else {
            messages.push({ role: 'user', content: userMessage });
        }
    }

    // Anthropic exige que a primeira mensagem seja 'user'
    if (messages.length === 0 || messages[0].role !== 'user') {
        messages.unshift({ role: 'user', content: userMessage });
    }

    let iterations = 0;
    const tools = getToolDefinitions();

    while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;

        logger.info({ sender, iteration: iterations, messagesCount: messages.length }, 'Chamando Claude');

        let response;
        try {
            response = await callClaude({
                model: CLAUDE_MODEL,
                max_tokens: 8192,
                system: systemPrompt,
                tools,
                messages,
            });
        } catch (err) {
            logger.error({ err }, 'Erro na chamada Claude');
            return 'Desculpe, estou com dificuldade para processar sua mensagem. Tente novamente em instantes.';
        }

        // Extrair texto da resposta
        const textBlocks = response.content.filter(b => b.type === 'text');
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        // Se parou sem tool_use → resposta final
        if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
            const reply = textBlocks.map(b => b.text).join('\n') || '';
            history.push({ role: 'assistant', content: reply });
            await saveHistory(sender, history);

            logger.info({ sender, iterations, replyLength: reply.length }, 'Resposta final gerada');
            return reply;
        }

        // Tool use
        if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
            // Adiciona a resposta completa do assistant (com tool_use blocks) ao contexto
            messages.push({ role: 'assistant', content: response.content });

            // Processar cada tool_use e coletar resultados
            const toolResults = [];

            for (const toolUse of toolUseBlocks) {
                logger.info({ tool: toolUse.name, args: toolUse.input, phone, role }, 'Executando tool call');

                // PERMISSÃO VALIDADA NO DISPATCHER (não no prompt)
                const result = await dispatchTool(
                    toolUse.name,
                    toolUse.input || {},
                    { phone, role, sender }
                );

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(result),
                });
            }

            // Anthropic: tool results vão como mensagem 'user'
            messages.push({ role: 'user', content: toolResults });

            continue;
        }

        // Fallback: pode ter texto mesmo com stop_reason inesperado
        if (textBlocks.length > 0) {
            const reply = textBlocks.map(b => b.text).join('\n');
            history.push({ role: 'assistant', content: reply });
            await saveHistory(sender, history);
            return reply;
        }

        break;
    }

    logger.warn({ sender, iterations }, 'Limite de iterações atingido');
    return 'Desculpe, tive um problema processando sua mensagem. Tente novamente.';
}

module.exports = { runAgent };
