const OpenAI = require('openai');
const fs = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const { ROLE_MASTER, ROLE_USER, resolveRole, OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY, DATA_DIR } = require('./config');
const { runAgent } = require('./agent');
const { debounce } = require('./utils/debounce');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const logger = require('./utils/logger');

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const TMP_DIR = path.join(DATA_DIR, 'tmp');

/**
 * Transcreve áudio usando OpenAI Whisper.
 * @param {Buffer} audioBuffer - Buffer do áudio
 * @param {string} mimetype - MIME type do áudio
 * @returns {Promise<string>} Texto transcrito
 */
async function transcribeAudio(audioBuffer, mimetype) {
    if (!openai) throw new Error('OpenAI API não configurada');

    // Salvar em arquivo temporário (Whisper precisa de arquivo)
    await fs.mkdir(TMP_DIR, { recursive: true });
    const ext = mimetype?.includes('ogg') ? 'ogg' : mimetype?.includes('mp4') ? 'mp4' : 'ogg';
    const tmpPath = path.join(TMP_DIR, `audio_${Date.now()}.${ext}`);
    const wavPath = path.join(TMP_DIR, `audio_${Date.now()}.wav`);

    try {
        await fs.writeFile(tmpPath, audioBuffer);

        // Converter para WAV com ffmpeg (Whisper funciona melhor com WAV)
        try {
            execSync(`ffmpeg -i "${tmpPath}" -ar 16000 -ac 1 -y "${wavPath}" 2>/dev/null`, {
                timeout: 15000,
                stdio: 'pipe',
            });
        } catch {
            // Se ffmpeg falhar, tenta enviar o original
            logger.warn('ffmpeg falhou na conversão, usando arquivo original');
        }

        const fileToSend = await fs.access(wavPath).then(() => wavPath).catch(() => tmpPath);
        const fileBuffer = await fs.readFile(fileToSend);

        const file = new File([fileBuffer], path.basename(fileToSend), {
            type: fileToSend.endsWith('.wav') ? 'audio/wav' : mimetype || 'audio/ogg',
        });

        const transcription = await openai.audio.transcriptions.create({
            model: 'whisper-1',
            file,
        });

        return transcription.text || '';
    } finally {
        // Limpar arquivos temporários
        await fs.unlink(tmpPath).catch(() => {});
        await fs.unlink(wavPath).catch(() => {});
    }
}

/**
 * Descreve uma imagem usando OpenAI GPT-4o Vision.
 * @param {Buffer} imageBuffer - Buffer da imagem
 * @param {string} mimetype - MIME type da imagem
 * @param {string} [caption] - Legenda da imagem (se houver)
 * @returns {Promise<string>} Descrição da imagem
 */
async function describeImage(imageBuffer, mimetype, caption) {
    if (!openai) throw new Error('OpenAI API não configurada');

    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimetype || 'image/jpeg'};base64,${base64}`;

    const userContent = [
        {
            type: 'image_url',
            image_url: { url: dataUrl },
        },
        {
            type: 'text',
            text: caption
                ? `O usuário enviou esta imagem com a legenda: "${caption}". Descreva o conteúdo da imagem em detalhes e considere a legenda.`
                : 'Descreva o conteúdo desta imagem em detalhes.',
        },
    ];

    const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: userContent }],
        max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || 'Não consegui analisar a imagem.';
}

/**
 * Recebe uma mensagem do WhatsApp, identifica o remetente e orquestra a resposta.
 * @param {object} sock - Socket do Baileys
 * @param {object} msg - Mensagem crua do Baileys
 */
async function handleMessage(sock, msg) {
    const sender = msg.key.remoteJid;

    // Ignorar mensagens de grupo por enquanto
    if (sender.endsWith('@g.us')) {
        logger.debug({ sender }, 'Mensagem de grupo ignorada');
        return;
    }

    // Ignorar mensagens de status/broadcast
    if (sender === 'status@broadcast') {
        return;
    }

    const phone = sender.replace('@s.whatsapp.net', '').replace('@lid', '');

    // Resolver role dinamicamente (checa config.json + env + onboarding)
    const role = await resolveRole(sender);

    // Extrair texto da mensagem
    let text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || '';

    // === VERIFICAR SE HÁ AUTH CLAUDE DISPONÍVEL ===

    const hasApiKey = ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== 'sk-ant-...';

    if (!hasApiKey) {
        if (role === ROLE_MASTER) {
            await sock.sendMessage(sender, {
                text: 'ANTHROPIC_API_KEY não configurada. Configure no .env e reinicie o bot.',
            });
        } else {
            await sock.sendMessage(sender, {
                text: 'O bot ainda não foi configurado. Aguarde o administrador.',
            });
        }
        return;
    }

    // === PROCESSAMENTO DE MÍDIA (áudio, imagem) ===

    // --- Processar ÁUDIO via OpenAI Whisper ---
    const audioMessage = msg.message?.audioMessage;
    if (audioMessage) {
        logger.info({ sender, mimetype: audioMessage.mimetype }, 'Áudio recebido — transcrevendo via Whisper');
        try {
            const audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
            const transcription = await transcribeAudio(audioBuffer, audioMessage.mimetype);
            text = transcription ? `[Áudio transcrito]: ${transcription}` : '[Áudio recebido mas não foi possível transcrever]';
            logger.info({ sender, transcriptionLength: transcription.length }, 'Áudio transcrito');
        } catch (err) {
            logger.error({ err, sender }, 'Erro ao transcrever áudio');
            text = '[Áudio recebido mas houve erro na transcrição]';
        }
    }

    // --- Processar IMAGEM via OpenAI Vision ---
    const imageMessage = msg.message?.imageMessage;
    if (imageMessage) {
        const caption = imageMessage.caption || '';
        logger.info({ sender, mimetype: imageMessage.mimetype, hasCaption: !!caption }, 'Imagem recebida — analisando via GPT-4o Vision');
        try {
            const imageBuffer = await downloadMediaMessage(msg, 'buffer', {});
            const description = await describeImage(imageBuffer, imageMessage.mimetype, caption);
            text = caption
                ? `[Imagem enviada com legenda: "${caption}"]\n[Análise da imagem]: ${description}`
                : `[Imagem enviada]\n[Análise da imagem]: ${description}`;
            logger.info({ sender, descriptionLength: description.length }, 'Imagem analisada');
        } catch (err) {
            logger.error({ err, sender }, 'Erro ao analisar imagem');
            text = caption
                ? `[Imagem enviada com legenda: "${caption}"] (não foi possível analisar a imagem)`
                : '[Imagem enviada mas houve erro na análise]';
        }
    }

    // --- Processar VÍDEO (extrair caption) ---
    if (!text && msg.message?.videoMessage?.caption) {
        text = msg.message.videoMessage.caption;
    }

    if (!text || !text.trim()) {
        logger.debug({ sender, msgType: Object.keys(msg.message || {}) }, 'Mensagem sem texto processável ignorada');
        return;
    }

    logger.info({ sender, role, phone, textLength: text.length }, 'Mensagem recebida');

    // === AGENTE CLAUDE (debounce + tool use) ===

    // Debounce: agrupa mensagens rápidas
    debounce(sender, text, async (fullText) => {
        try {
            // Simular "digitando..."
            await sock.presenceSubscribe(sender);
            await sock.sendPresenceUpdate('composing', sender);

            const reply = await runAgent(sender, phone, role, fullText);

            // Parar "digitando..."
            await sock.sendPresenceUpdate('paused', sender);

            if (reply && reply.trim()) {
                await sock.sendMessage(sender, { text: reply });
                logger.info({ sender, replyLength: reply.length }, 'Resposta enviada');
            }
        } catch (err) {
            logger.error({ err, sender }, 'Erro ao processar mensagem');

            try {
                await sock.sendPresenceUpdate('paused', sender);
                await sock.sendMessage(sender, {
                    text: 'Desculpe, ocorreu um erro interno. Tente novamente em instantes.',
                });
            } catch (sendErr) {
                logger.error({ err: sendErr, sender }, 'Erro ao enviar mensagem de erro');
            }
        }
    });
}

module.exports = { handleMessage };
