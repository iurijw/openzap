const fs = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const logger = require('./utils/logger');

const JOBS_FILE = path.join(DATA_DIR, 'cron_jobs.json');
const TRIGGERS_DIR = path.join(DATA_DIR, 'cron_triggers');
const TRIGGER_SCRIPT = '/app/scripts/cron_trigger.sh';
const POLL_INTERVAL_MS = 10000; // 10 segundos

let sock = null;
let processing = false;

// --- Socket management ---

function setSock(newSock) {
    sock = newSock;
    logger.info('Cron: socket atualizado');
}

// --- Inicialização ---

async function initCron() {
    // Criar diretório de triggers
    await fs.mkdir(TRIGGERS_DIR, { recursive: true });

    // Iniciar daemon cron
    try {
        execSync('cron', { stdio: 'pipe' });
        logger.info('Cron daemon iniciado');
    } catch (err) {
        // Pode falhar se já estiver rodando, ou se não estiver instalado
        logger.warn({ err: err.message }, 'Aviso ao iniciar cron daemon (pode já estar rodando)');
    }

    // Sincronizar crontab com jobs salvos
    await syncCrontab();

    // Iniciar polling de triggers
    setInterval(() => processPendingTriggers(), POLL_INTERVAL_MS);
    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Cron: polling de triggers iniciado');

    // Processar triggers pendentes (de antes do restart)
    await processPendingTriggers();
}

// --- Gerenciamento de jobs ---

async function loadJobs() {
    try {
        const data = await fs.readFile(JOBS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

async function saveJobs(jobs) {
    await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

/**
 * Cria um novo cron job.
 * Suporta mode "agent" (padrão) e "direct" (executa script diretamente).
 *
 * @param {object} params - Dados do job
 * @param {string} params.mode - "agent" ou "direct"
 * @param {string} [params.script] - Caminho do script (para mode "direct")
 * @param {string} [params.prompt] - Instrução para o agente (para mode "agent")
 * @returns {object} Job criado com ID gerado
 */
async function addJob({ schedule, description, target_jid, prompt, script, mode, role, created_by }) {
    const jobs = await loadJobs();

    const job = {
        id: crypto.randomUUID(),
        schedule,
        description: description || 'Tarefa agendada',
        target_jid,
        mode: mode || 'agent',
        role: role || 'master',
        created_by,
        created_at: new Date().toISOString(),
    };

    // Campos específicos por modo
    if (job.mode === 'direct') {
        job.script = script;
    } else {
        job.prompt = prompt;
    }

    jobs.push(job);
    await saveJobs(jobs);
    await syncCrontab();

    logger.info({ jobId: job.id, schedule, mode: job.mode, description: job.description }, 'Cron job criado');
    return job;
}

/**
 * Remove um cron job pelo ID.
 */
async function removeJob(jobId) {
    const jobs = await loadJobs();
    const filtered = jobs.filter(j => j.id !== jobId);

    if (filtered.length === jobs.length) {
        return { error: `Job não encontrado: ${jobId}` };
    }

    await saveJobs(filtered);
    await syncCrontab();

    logger.info({ jobId }, 'Cron job removido');
    return { success: true };
}

/**
 * Lista todos os cron jobs.
 */
async function listJobs() {
    return await loadJobs();
}

// --- Sincronização com crontab do sistema ---

async function syncCrontab() {
    const jobs = await loadJobs();

    if (jobs.length === 0) {
        try {
            execSync('crontab -r 2>/dev/null || true', { stdio: 'pipe' });
        } catch {}
        logger.info('Crontab limpo (sem jobs)');
        return;
    }

    const lines = jobs.map(job =>
        `${job.schedule} ${TRIGGER_SCRIPT} ${job.id}`
    );

    const crontab = lines.join('\n') + '\n';

    const tmpFile = path.join(DATA_DIR, '.crontab.tmp');
    await fs.writeFile(tmpFile, crontab);

    try {
        execSync(`crontab ${tmpFile}`, { stdio: 'pipe' });
        logger.info({ jobCount: jobs.length }, 'Crontab sincronizado');
    } catch (err) {
        logger.error({ err: err.message }, 'Falha ao sincronizar crontab');
    }

    await fs.unlink(tmpFile).catch(() => {});
}

// --- Processamento de triggers ---

async function processPendingTriggers() {
    if (processing) return;
    processing = true;

    try {
        const files = await fs.readdir(TRIGGERS_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

        for (const file of jsonFiles) {
            await processTrigger(path.join(TRIGGERS_DIR, file));
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            logger.error({ err }, 'Erro ao escanear diretório de triggers');
        }
    } finally {
        processing = false;
    }
}

async function processTrigger(filePath) {
    let trigger;
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        trigger = JSON.parse(data);
    } catch (err) {
        logger.error({ err, filePath }, 'Falha ao ler arquivo de trigger');
        await fs.unlink(filePath).catch(() => {});
        return;
    }

    // Deletar trigger imediatamente para evitar reprocessamento
    await fs.unlink(filePath).catch(() => {});

    if (!sock) {
        logger.warn({ jobId: trigger.id }, 'Sem conexão WhatsApp — trigger ignorado');
        return;
    }

    const mode = trigger.mode || 'agent';

    logger.info(
        { jobId: trigger.id, target: trigger.target_jid, mode, description: trigger.description },
        'Processando trigger de cron'
    );

    // Modo direto: executa script e envia stdout como mensagem
    if (mode === 'direct') {
        await processDirectTrigger(trigger);
        return;
    }

    // Modo agent: processa via Claude
    await processAgentTrigger(trigger);
}

/**
 * Processa trigger no modo "direct": executa o script diretamente
 * e envia o stdout como mensagem ao destinatário.
 * Não consome tokens do Claude.
 */
async function processDirectTrigger(trigger) {
    if (!trigger.script) {
        logger.error({ jobId: trigger.id }, 'Trigger direto sem script definido');
        return;
    }

    const scriptPath = path.join(DATA_DIR, trigger.script);

    // Verificar se o script existe
    try {
        await fs.access(scriptPath);
    } catch {
        logger.error({ scriptPath, jobId: trigger.id }, 'Script direto não encontrado');
        if (sock && trigger.target_jid) {
            try {
                await sock.sendMessage(trigger.target_jid, {
                    text: `[Erro cron "${trigger.description || trigger.id}"]: Script não encontrado: ${trigger.script}`,
                });
            } catch {}
        }
        return;
    }

    try {
        // Determinar como executar baseado na extensão
        const ext = path.extname(scriptPath).toLowerCase();
        let cmd;
        if (ext === '.js') {
            cmd = `node "${scriptPath}"`;
        } else if (ext === '.py') {
            cmd = `python3 "${scriptPath}"`;
        } else {
            // Para .sh e outros: tornar executável e rodar via sh
            try { execSync(`chmod +x "${scriptPath}"`, { stdio: 'pipe' }); } catch {}
            cmd = `sh "${scriptPath}"`;
        }

        const output = execSync(cmd, {
            cwd: DATA_DIR,
            timeout: 30000,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, DATA_DIR },
        });

        if (output && output.trim()) {
            await sock.sendMessage(trigger.target_jid, { text: output.trim() });
            logger.info(
                { jobId: trigger.id, target: trigger.target_jid, outputLength: output.length },
                'Mensagem de cron direto enviada'
            );
        }
    } catch (err) {
        const stderr = err.stderr || err.message || 'Erro desconhecido';
        logger.error({ jobId: trigger.id, stderr: stderr.substring(0, 500) }, 'Erro ao executar script direto');

        // Enviar erro ao destinatário
        if (sock && trigger.target_jid) {
            try {
                await sock.sendMessage(trigger.target_jid, {
                    text: `[Erro cron "${trigger.description || trigger.id}"]: ${stderr.substring(0, 500)}`,
                });
            } catch {}
        }
    }
}

/**
 * Processa trigger no modo "agent": executa via Claude (comportamento original).
 */
async function processAgentTrigger(trigger) {
    try {
        // Lazy require para evitar dependência circular (cron → agent → tools → cron)
        const { runAgent } = require('./agent');

        const phone = trigger.target_jid
            .replace('@s.whatsapp.net', '')
            .replace('@lid', '');
        const role = trigger.role || 'master';

        // Enriquecer o prompt com contexto do cron para evitar que o agente
        // use acoes_whatsapp (o que pode falhar se o JID mudar de formato).
        // A resposta do agente é enviada automaticamente ao target_jid correto.
        const enrichedPrompt = `[TAREFA AUTOMÁTICA — CRON JOB]
Destinatário: ${trigger.target_jid}
Descrição: ${trigger.description || 'Tarefa agendada'}
Instrução: ${trigger.prompt}

IMPORTANTE: Sua resposta será enviada AUTOMATICAMENTE ao destinatário acima. NÃO use a tool acoes_whatsapp para enviar esta mensagem — basta compor o texto de resposta diretamente.`;

        const reply = await runAgent(
            trigger.target_jid,
            phone,
            role,
            enrichedPrompt,
            { fromCron: true }
        );

        if (reply && reply.trim()) {
            await sock.sendMessage(trigger.target_jid, { text: reply });
            logger.info(
                { jobId: trigger.id, target: trigger.target_jid, replyLength: reply.length },
                'Mensagem de cron enviada'
            );
        }
    } catch (err) {
        logger.error({ err, jobId: trigger.id }, 'Erro ao processar trigger de cron');
    }
}

module.exports = { initCron, setSock, addJob, removeJob, listJobs };
