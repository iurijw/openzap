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
 * @returns {object} Job criado com ID gerado
 */
async function addJob({ schedule, description, target_jid, prompt, role, created_by }) {
    const jobs = await loadJobs();

    const job = {
        id: crypto.randomUUID(),
        schedule,
        description: description || 'Tarefa agendada',
        target_jid,
        prompt,
        role: role || 'master',
        created_by,
        created_at: new Date().toISOString(),
    };

    jobs.push(job);
    await saveJobs(jobs);
    await syncCrontab();

    logger.info({ jobId: job.id, schedule, description: job.description }, 'Cron job criado');
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

    logger.info(
        { jobId: trigger.id, target: trigger.target_jid, description: trigger.description },
        'Processando trigger de cron'
    );

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
