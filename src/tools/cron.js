const { addJob, removeJob, listJobs } = require('../cron');

/**
 * Handler da tool gerenciar_cron.
 * Permite ao agente criar, listar e remover cron jobs.
 *
 * @param {object} args - { action, schedule?, prompt?, description?, target_jid?, job_id? }
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
            if (!args.prompt) {
                return { error: 'Parâmetro "prompt" é obrigatório.' };
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
                prompt: args.prompt,
                role: context.role,
                created_by: context.sender,
            });

            return {
                success: true,
                job_id: job.id,
                schedule: job.schedule,
                description: job.description,
                target_jid: job.target_jid,
                message: `Cron job criado com sucesso. ID: ${job.id}`,
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
