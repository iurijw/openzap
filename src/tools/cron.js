const { addJob, removeJob, listJobs } = require('../cron');

/**
 * Handler da tool gerenciar_cron.
 * Permite ao agente criar, listar e remover cron jobs.
 * Suporta dois modos: "agent" (padrão) e "direct" (executa script diretamente).
 *
 * @param {object} args - { action, schedule?, prompt?, description?, target_jid?, job_id?, mode?, script? }
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<object>} Resultado da operação
 */
async function cronHandler(args, context) {
    const { action } = args;

    switch (action) {
        case 'criar': {
            if (!args.schedule) {
                return { error: 'Parâmetro "schedule" é obrigatório. Ex: "0 8 * * 1-5"' };
            }

            const mode = args.mode || 'agent';

            // Validações por modo
            if (mode === 'agent' && !args.prompt) {
                return { error: 'Parâmetro "prompt" é obrigatório para mode "agent".' };
            }
            if (mode === 'direct' && !args.script) {
                return { error: 'Parâmetro "script" é obrigatório para mode "direct". Informe o caminho do script relativo a /data/.' };
            }

            // Validação básica da expressão cron (5 campos)
            const parts = args.schedule.trim().split(/\s+/);
            if (parts.length !== 5) {
                return { error: `Expressão cron inválida: esperados 5 campos, recebidos ${parts.length}. Formato: "min hora dia mês diaSemana"` };
            }

            const job = await addJob({
                schedule: args.schedule.trim(),
                description: args.description || 'Tarefa agendada',
                target_jid: args.target_jid || context.sender,
                prompt: mode === 'agent' ? args.prompt : undefined,
                script: mode === 'direct' ? args.script : undefined,
                mode,
                role: context.role,
                created_by: context.sender,
            });

            return {
                success: true,
                job_id: job.id,
                schedule: job.schedule,
                description: job.description,
                target_jid: job.target_jid,
                mode: job.mode,
                message: `Cron job criado com sucesso (mode: ${mode}). ID: ${job.id}`,
            };
        }

        case 'listar': {
            const jobs = await listJobs();

            if (jobs.length === 0) {
                return { message: 'Nenhum cron job configurado.', jobs: [] };
            }

            return {
                message: `${jobs.length} cron job(s) encontrado(s).`,
                jobs: jobs.map(j => ({
                    id: j.id,
                    schedule: j.schedule,
                    description: j.description,
                    target_jid: j.target_jid,
                    mode: j.mode || 'agent',
                    script: j.script || null,
                    created_at: j.created_at,
                })),
            };
        }

        case 'remover': {
            if (!args.job_id) {
                return { error: 'Parâmetro "job_id" é obrigatório para remover.' };
            }
            return await removeJob(args.job_id);
        }

        default:
            return { error: `Ação desconhecida: "${action}". Use: criar, listar, remover.` };
    }
}

module.exports = cronHandler;
