const fs = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../config');
const logger = require('../utils/logger');

const CUSTOM_TOOLS_DIR = path.join(DATA_DIR, 'custom_tools');
const REGISTRY_FILE = path.join(CUSTOM_TOOLS_DIR, 'registry.json');

// Built-in tool names that cannot be used for custom tools
const BUILTIN_NAMES = new Set([
    'executar_comando', 'ler_arquivo', 'escrever_arquivo', 'listar_arquivos',
    'gerenciar_cron', 'acoes_whatsapp', 'gerenciar_ferramentas',
]);

/**
 * Loads the custom tools registry.
 * @returns {Promise<Array>} Array of custom tool definitions
 */
async function loadRegistry() {
    try {
        const data = await fs.readFile(REGISTRY_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

/**
 * Loads the registry synchronously (for getToolDefinitions).
 * @returns {Array} Array of custom tool definitions
 */
function loadRegistrySync() {
    try {
        const data = require('fs').readFileSync(REGISTRY_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

/**
 * Saves the custom tools registry.
 */
async function saveRegistry(registry) {
    await fs.mkdir(CUSTOM_TOOLS_DIR, { recursive: true });
    await fs.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Handler for the gerenciar_ferramentas tool.
 * Allows the agent to create, edit, list, remove and inspect custom tools.
 *
 * @param {object} args - { action, name?, description?, input_schema?, code? }
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<object>} Result of the operation
 */
async function customToolsHandler(args, context) {
    const { action } = args;

    switch (action) {
        case 'criar': {
            if (!args.name) return { error: 'Parâmetro "name" é obrigatório.' };
            if (!args.description) return { error: 'Parâmetro "description" é obrigatório.' };
            if (!args.code) return { error: 'Parâmetro "code" é obrigatório.' };

            // Validate name format
            if (!/^[a-z][a-z0-9_]*$/.test(args.name)) {
                return { error: 'Nome inválido. Use apenas letras minúsculas, números e underscore. Deve começar com letra.' };
            }

            // Prevent conflicts with built-in tools
            if (BUILTIN_NAMES.has(args.name)) {
                return { error: `Nome "${args.name}" conflita com uma ferramenta nativa. Escolha outro nome.` };
            }

            const registry = await loadRegistry();

            // Check for duplicates
            if (registry.find(t => t.name === args.name)) {
                return { error: `Ferramenta "${args.name}" já existe. Use ação "editar" para modificá-la.` };
            }

            // Parse input_schema
            let inputSchema = args.input_schema;
            if (typeof inputSchema === 'string') {
                try {
                    inputSchema = JSON.parse(inputSchema);
                } catch {
                    return { error: 'input_schema inválido. Deve ser um objeto JSON Schema válido.' };
                }
            }
            if (!inputSchema) {
                inputSchema = { type: 'object', properties: {}, required: [] };
            }

            // Write handler file
            const handlerFile = `${args.name}.js`;
            const handlerPath = path.join(CUSTOM_TOOLS_DIR, handlerFile);
            await fs.mkdir(CUSTOM_TOOLS_DIR, { recursive: true });
            await fs.writeFile(handlerPath, args.code, 'utf-8');

            // Add to registry
            const tool = {
                name: args.name,
                description: args.description,
                input_schema: inputSchema,
                handler_file: handlerFile,
                created_at: new Date().toISOString(),
                created_by: context.sender,
            };

            registry.push(tool);
            await saveRegistry(registry);

            logger.info({ toolName: args.name }, 'Custom tool criada');
            return {
                success: true,
                name: args.name,
                message: `Ferramenta "${args.name}" criada com sucesso. Estará disponível imediatamente.`,
            };
        }

        case 'editar': {
            if (!args.name) return { error: 'Parâmetro "name" é obrigatório.' };

            const registry = await loadRegistry();
            const idx = registry.findIndex(t => t.name === args.name);
            if (idx === -1) {
                return { error: `Ferramenta "${args.name}" não encontrada.` };
            }

            if (args.description) {
                registry[idx].description = args.description;
            }

            if (args.input_schema) {
                let inputSchema = args.input_schema;
                if (typeof inputSchema === 'string') {
                    try {
                        inputSchema = JSON.parse(inputSchema);
                    } catch {
                        return { error: 'input_schema inválido.' };
                    }
                }
                registry[idx].input_schema = inputSchema;
            }

            if (args.code) {
                const handlerPath = path.join(CUSTOM_TOOLS_DIR, registry[idx].handler_file);
                await fs.writeFile(handlerPath, args.code, 'utf-8');

                // Clear require cache so next invocation uses the new code
                try { delete require.cache[require.resolve(handlerPath)]; } catch {}
            }

            registry[idx].updated_at = new Date().toISOString();
            await saveRegistry(registry);

            logger.info({ toolName: args.name }, 'Custom tool editada');
            return { success: true, name: args.name, message: `Ferramenta "${args.name}" atualizada.` };
        }

        case 'listar': {
            const registry = await loadRegistry();
            if (registry.length === 0) {
                return { message: 'Nenhuma ferramenta customizada criada.', tools: [] };
            }
            return {
                message: `${registry.length} ferramenta(s) customizada(s).`,
                tools: registry.map(t => ({
                    name: t.name,
                    description: t.description,
                    created_at: t.created_at,
                    updated_at: t.updated_at || null,
                })),
            };
        }

        case 'remover': {
            if (!args.name) return { error: 'Parâmetro "name" é obrigatório.' };

            const registry = await loadRegistry();
            const idx = registry.findIndex(t => t.name === args.name);
            if (idx === -1) {
                return { error: `Ferramenta "${args.name}" não encontrada.` };
            }

            // Delete handler file
            const handlerPath = path.join(CUSTOM_TOOLS_DIR, registry[idx].handler_file);
            await fs.unlink(handlerPath).catch(() => {});
            try { delete require.cache[require.resolve(handlerPath)]; } catch {}

            // Remove from registry
            registry.splice(idx, 1);
            await saveRegistry(registry);

            logger.info({ toolName: args.name }, 'Custom tool removida');
            return { success: true, message: `Ferramenta "${args.name}" removida.` };
        }

        case 'ver_codigo': {
            if (!args.name) return { error: 'Parâmetro "name" é obrigatório.' };

            const registry = await loadRegistry();
            const tool = registry.find(t => t.name === args.name);
            if (!tool) {
                return { error: `Ferramenta "${args.name}" não encontrada.` };
            }

            const handlerPath = path.join(CUSTOM_TOOLS_DIR, tool.handler_file);
            try {
                const code = await fs.readFile(handlerPath, 'utf-8');
                return {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.input_schema,
                    code,
                };
            } catch {
                return { error: `Arquivo de handler não encontrado para "${args.name}".` };
            }
        }

        default:
            return { error: `Ação desconhecida: "${action}". Use: criar, editar, listar, remover, ver_codigo.` };
    }
}

/**
 * Executes a custom tool handler by name.
 * Loads the handler file fresh each time (clears require cache).
 *
 * @param {string} name - Custom tool name
 * @param {object} args - Tool arguments
 * @param {object} context - { phone, role, sender }
 * @returns {Promise<object>} Tool result
 */
async function executeCustomTool(name, args, context) {
    const registry = await loadRegistry();
    const tool = registry.find(t => t.name === name);

    if (!tool) {
        return { error: `Ferramenta customizada "${name}" não encontrada.` };
    }

    const handlerPath = path.join(CUSTOM_TOOLS_DIR, tool.handler_file);

    try {
        // Clear cache to always use latest version of the handler
        delete require.cache[require.resolve(handlerPath)];
    } catch {}

    try {
        const handler = require(handlerPath);

        if (typeof handler !== 'function') {
            return { error: `Handler de "${name}" não exporta uma função. O arquivo deve usar: module.exports = async function(args, context) { ... }` };
        }

        const result = await handler(args, context);
        return result;
    } catch (err) {
        logger.error({ err, toolName: name }, 'Erro ao executar custom tool');
        return { error: `Erro ao executar "${name}": ${err.message}` };
    }
}

module.exports = { customToolsHandler, executeCustomTool, loadRegistry, loadRegistrySync };
