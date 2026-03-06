const OpenAI = require('openai');
const fs = require('fs/promises');
const path = require('path');
const { OPENAI_API_KEY, DATA_DIR } = require('../config');
const logger = require('../utils/logger');

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const TMP_DIR = path.join(DATA_DIR, 'tmp');

/**
 * Resolve o JID de um destinatário a partir de phone ou target_jid.
 */
function resolveTargetJid(args) {
    if (args.target_jid) return args.target_jid;
    if (args.phone) {
        const cleaned = args.phone.replace(/[^0-9]/g, '');
        return `${cleaned}@s.whatsapp.net`;
    }
    return null;
}

/**
 * Handler da tool acoes_whatsapp.
 * Realiza ações autônomas no WhatsApp via Baileys.
 *
 * @param {object} args - { action, target_jid?, phone?, text? }
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<object>} Resultado da operação
 */
async function whatsappActions(args, context) {
    // Importar getSock aqui (lazy) para evitar dependência circular
    const { getSock } = require('../whatsapp');
    const sock = getSock();

    if (!sock) {
        return { error: 'WhatsApp não está conectado no momento.' };
    }

    const { action } = args;

    switch (action) {
        case 'enviar_mensagem': {
            const jid = resolveTargetJid(args);
            if (!jid) {
                return { error: 'Informe target_jid ou phone do destinatário.' };
            }
            if (!args.text) {
                return { error: 'Informe o texto da mensagem.' };
            }

            try {
                await sock.sendMessage(jid, { text: args.text });
                logger.info({ target: jid, textLength: args.text.length }, 'Mensagem autônoma enviada');
                return { success: true, target: jid, message: 'Mensagem enviada com sucesso.' };
            } catch (err) {
                logger.error({ err, target: jid }, 'Erro ao enviar mensagem autônoma');
                return { error: `Falha ao enviar mensagem: ${err.message}` };
            }
        }

        case 'enviar_audio': {
            const jid = resolveTargetJid(args);
            if (!jid) {
                return { error: 'Informe target_jid ou phone do destinatário.' };
            }
            if (!args.text) {
                return { error: 'Informe o texto para sintetizar em áudio.' };
            }
            if (!openai) {
                return { error: 'OpenAI API não configurada. Necessário para TTS.' };
            }

            try {
                await fs.mkdir(TMP_DIR, { recursive: true });

                // Gerar áudio via OpenAI TTS
                const mp3Response = await openai.audio.speech.create({
                    model: 'tts-1',
                    voice: 'nova',
                    input: args.text,
                    response_format: 'opus',
                });

                const audioBuffer = Buffer.from(await mp3Response.arrayBuffer());
                const tmpPath = path.join(TMP_DIR, `tts_${Date.now()}.opus`);

                await fs.writeFile(tmpPath, audioBuffer);

                // Enviar como mensagem de áudio (ptt = push to talk / voice note)
                await sock.sendMessage(jid, {
                    audio: audioBuffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true,
                });

                // Limpar arquivo temporário
                await fs.unlink(tmpPath).catch(() => {});

                logger.info({ target: jid, textLength: args.text.length }, 'Áudio TTS enviado');
                return { success: true, target: jid, message: 'Áudio enviado com sucesso.' };
            } catch (err) {
                logger.error({ err, target: jid }, 'Erro ao enviar áudio TTS');
                return { error: `Falha ao gerar/enviar áudio: ${err.message}` };
            }
        }

        case 'verificar_contato': {
            const jid = resolveTargetJid(args);
            if (!jid) {
                return { error: 'Informe target_jid ou phone para verificar.' };
            }

            try {
                const [result] = await sock.onWhatsApp(jid.replace('@s.whatsapp.net', ''));
                if (result && result.exists) {
                    return {
                        exists: true,
                        jid: result.jid,
                        message: `Contato existe no WhatsApp: ${result.jid}`,
                    };
                }
                return { exists: false, message: 'Número não encontrado no WhatsApp.' };
            } catch (err) {
                logger.error({ err, jid }, 'Erro ao verificar contato');
                return { error: `Falha ao verificar contato: ${err.message}` };
            }
        }

        case 'info_perfil': {
            const jid = resolveTargetJid(args);
            if (!jid) {
                return { error: 'Informe target_jid ou phone para buscar perfil.' };
            }

            try {
                const status = await sock.fetchStatus(jid).catch(() => null);
                const profilePic = await sock.profilePictureUrl(jid, 'preview').catch(() => null);

                return {
                    jid,
                    status: status?.status || null,
                    setAt: status?.setAt || null,
                    profilePicUrl: profilePic || null,
                    message: 'Informações do perfil obtidas.',
                };
            } catch (err) {
                logger.error({ err, jid }, 'Erro ao buscar perfil');
                return { error: `Falha ao buscar perfil: ${err.message}` };
            }
        }

        default:
            return { error: `Ação desconhecida: "${action}". Use: enviar_mensagem, enviar_audio, verificar_contato, info_perfil.` };
    }
}

module.exports = whatsappActions;
