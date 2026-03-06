# CLAUDE.md — OpenZap (Agente Autônomo de WhatsApp)

## O que é este projeto

Monólito Node.js que funciona como agente autônomo de WhatsApp.
Um único container, sem dependências externas (sem banco, sem Redis, sem painel web).

- Conecta no WhatsApp via Baileys (WebSocket de saída, nenhuma porta exposta)
- Raciocínio e tool use via Claude Opus 4.6 (Anthropic API)
- OpenAI usado APENAS para: visão (GPT-4o), transcrição de áudio (Whisper) e TTS
- Propósito e comportamento definidos pelo usuário master via onboarding
- Agenda tarefas automáticas via cron do Linux
- Ações autônomas no WhatsApp: enviar mensagens, áudios (TTS), verificar contatos
- Ferramentas customizadas: o bot pode criar suas próprias tools em Node.js
- Armazena tudo em `/data/` (volume Docker persistente)

## Estrutura de arquivos

```
├── docker-compose.yml         # Stack: 1 serviço, 1 volume
├── Dockerfile                 # node:20-slim + ffmpeg + jq + curl + cron
├── .env.example               # Template de variáveis de ambiente
├── .gitignore
├── package.json               # anthropic, baileys, openai, pino, qrcode-terminal
├── CLAUDE.md                  # Este arquivo
├── scripts/
│   └── cron_trigger.sh        # Script chamado pelo crontab → cria trigger files
└── src/
    ├── index.js               # Entry point — validação + boot + signal handlers
    ├── whatsapp.js            # Conexão Baileys, QR code, reconexão, socket global
    ├── router.js              # Filtra msg → resolve role → áudio/imagem → debounce → orquestra
    ├── agent.js               # Loop de tool use Anthropic Claude (max 10 iterações)
    ├── config.js              # Env vars, resolveRole(), prompts dinâmicos
    ├── memory.js              # Histórico por contato em JSON (1 arquivo por telefone)
    ├── cron.js                # Gerenciador de cron: daemon, jobs, polling de triggers
    ├── tools/
    │   ├── index.js           # Dispatcher: permissão → sanitização → execução (nativas + custom)
    │   ├── definitions.js     # Schemas das 7 tools nativas + carrega custom tools
    │   ├── permissions.js     # Controle de acesso por role (master/user) + granular WhatsApp
    │   ├── custom_tools.js    # Gerenciador de ferramentas customizadas (criar/editar/remover)
    │   ├── file_read.js       # Tool: ler arquivo de /data/
    │   ├── file_write.js      # Tool: escrever arquivo (injeta master_jid no config)
    │   ├── file_list.js       # Tool: listar diretório
    │   ├── exec.js            # Tool: executar comando shell (30s timeout)
    │   ├── cron.js            # Tool: gerenciar cron jobs (criar/listar/remover, mode agent/direct)
    │   └── whatsapp_actions.js # Tool: ações autônomas WhatsApp (msg, TTS, contatos)
    └── utils/
        ├── debounce.js        # Agrupa mensagens rápidas (13s padrão)
        └── logger.js          # Pino — logs estruturados JSON
```

## Arquitetura de IA (split providers)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ANTHROPIC (Claude Opus 4.6)                                        │
│  ├── Raciocínio principal                                            │
│  ├── Tool use (7 tools nativas + custom tools)                       │
│  ├── Conversação com usuários                                        │
│  └── Decisões autônomas (cron jobs, ações WhatsApp)                  │
│                                                                      │
│  OPENAI (auxiliar — só para mídia)                                    │
│  ├── GPT-4o Vision — análise de imagens recebidas                    │
│  ├── Whisper — transcrição de áudios recebidos                       │
│  └── TTS — geração de áudios falados (tool enviar_audio)             │
└──────────────────────────────────────────────────────────────────────┘
```

## Fluxo de dados

### Mensagens de texto (WhatsApp → Bot → WhatsApp)

```
WhatsApp → Baileys WebSocket → whatsapp.js (filtra msgs)
  → router.js (resolve role + debounce)
    → agent.js (Claude tool-use loop)
      → tools/index.js (permissão + sanitização de path)
        → file_read / file_write / file_list / exec / cron / whatsapp_actions / custom_tools
      ← resultado da tool volta para Claude
    ← resposta final em texto
  → whatsapp.js (envia mensagem)
→ WhatsApp
```

### Mensagens de áudio (WhatsApp → OpenAI Whisper → Claude)

```
WhatsApp → Baileys (audioMessage)
  → router.js (downloadMediaMessage)
    → ffmpeg (converte para WAV)
      → OpenAI Whisper API (transcrição)
    ← texto transcrito
  → agent.js (Claude processa como texto "[Áudio transcrito]: ...")
→ WhatsApp
```

### Mensagens de imagem (WhatsApp → OpenAI Vision → Claude)

```
WhatsApp → Baileys (imageMessage)
  → router.js (downloadMediaMessage)
    → OpenAI GPT-4o Vision (descrição da imagem)
  ← descrição textual
  → agent.js (Claude processa como texto "[Análise da imagem]: ...")
→ WhatsApp
```

### Cron jobs — modo "agent" (Crontab → Claude → WhatsApp)

```
cron daemon (Linux) → scripts/cron_trigger.sh (lê job, escreve trigger file)
  → /data/cron_triggers/{timestamp}-{job_id}.json
    → cron.js (polling a cada 10s detecta o arquivo)
      → agent.js (runAgent com fromCron=true)
      ← compõe mensagem
    → whatsapp.js (envia mensagem ao target_jid)
  → WhatsApp
```

### Cron jobs — modo "direct" (Crontab → Script → WhatsApp)

```
cron daemon (Linux) → scripts/cron_trigger.sh (lê job, escreve trigger file)
  → /data/cron_triggers/{timestamp}-{job_id}.json
    → cron.js (polling detecta trigger com mode "direct")
      → execSync(script) — executa o script diretamente
      ← stdout do script
    → whatsapp.js (envia stdout como mensagem ao target_jid)
  → WhatsApp
```

O modo "direct" NÃO passa pelo Claude, não consome tokens. Ideal para monitores, alertas e tarefas repetitivas simples.

## Ferramentas customizadas

O bot pode criar suas próprias ferramentas via `gerenciar_ferramentas`. Ferramentas customizadas são scripts Node.js armazenados em `/data/custom_tools/`.

### Arquitetura

```
/data/custom_tools/
├── registry.json         # Registro com schemas de todas as custom tools
├── bitcoin_price.js      # Handler: module.exports = async function(args, context) { ... }
├── consultar_cep.js      # Cada tool é um arquivo .js independente
└── ...
```

### Formato do handler

```js
// O handler deve exportar uma função async
module.exports = async function(args, context) {
    // args: parâmetros definidos no input_schema da tool
    // context: { phone, role, sender }

    // Pode usar qualquer módulo Node.js
    const https = require('https');
    const { execSync } = require('child_process');

    // ... lógica da ferramenta ...

    return { resultado: 'dados' };  // Retorna objeto JSON
};
```

### Ciclo de vida

1. Master pede ao bot para criar uma ferramenta
2. Bot usa `gerenciar_ferramentas` com action "criar", passando nome, descrição, schema e código
3. Handler é salvo em `/data/custom_tools/{nome}.js` e registrado em `registry.json`
4. `getToolDefinitions()` carrega custom tools do registry a cada iteração do loop
5. A ferramenta fica disponível imediatamente na mesma conversa
6. Permissões: master usa qualquer custom tool; users precisam que o master adicione o nome da tool ao `user_allowed_tools`

### Ações disponíveis

| Ação       | Descrição                                              |
|------------|--------------------------------------------------------|
| `criar`    | Cria nova ferramenta com nome, descrição, schema e código |
| `editar`   | Atualiza descrição, schema ou código de uma ferramenta    |
| `listar`   | Lista todas as ferramentas customizadas                   |
| `remover`  | Remove uma ferramenta                                     |
| `ver_codigo` | Exibe o código-fonte de uma ferramenta                  |

## Identificação de remetente (master vs user)

O WhatsApp moderno usa LIDs (`278876890603567@lid`) em vez de números (`5511999999999@s.whatsapp.net`). O sistema resolve o role em `config.js:resolveRole()` com esta prioridade:

1. **Sem config.json** (onboarding) → primeiro remetente = master
2. **`master_jid`** salvo no config.json → match exato do JID completo
3. **`MASTER_PHONE`** do .env → fallback (compara número extraído)
4. Caso contrário → user

O `master_jid` é injetado automaticamente por `file_write.js` ao salvar `config.json`, sem depender do agente de IA.

## Modelo de permissões

Segurança em 3 camadas:

1. **Handler (código)** — `permissions.js` bloqueia operações proibidas independente do que o modelo de IA decidir
2. **Prompt** — instrui o agente a não tentar operações restritas (reduz chamadas desnecessárias)
3. **Isolamento de memória** — cada contato tem arquivo separado; o agente nunca vê histórico de outro

### Matriz de permissões

| Tool                    | Master          | User                                                |
|-------------------------|-----------------|-----------------------------------------------------|
| `executar_comando`      | Liberado (tudo) | Bloqueado sempre                                     |
| `gerenciar_cron`        | Liberado (tudo) | Bloqueado sempre                                     |
| `gerenciar_ferramentas` | Liberado (tudo) | Bloqueado sempre                                     |
| `acoes_whatsapp`        | Liberado (tudo) | Bloqueado (liberável via `user_allowed_tools` + granular) |
| `escrever_arquivo`      | Liberado (tudo) | Só `users/{phone}/`                                  |
| `ler_arquivo`           | Liberado (tudo) | Só `config.json`, `users/{phone}/` e `master_shared_user/` |
| `listar_arquivos`       | Liberado (tudo) | Só `users/{phone}/` e `master_shared_user/`           |
| Custom tools            | Liberado (tudo) | Bloqueado (liberável via `user_allowed_tools`)        |

### user_allowed_tools (permissões dinâmicas)

O master pode liberar tools para o contexto de users adicionando nomes ao array `user_allowed_tools` no `config.json`:

```json
{
    "user_allowed_tools": ["acoes_whatsapp", "consultar_cep"]
}
```

- **Liberáveis:** `acoes_whatsapp`, `ler_arquivo`, `escrever_arquivo`, `listar_arquivos`, e qualquer custom tool pelo nome
- **Nunca liberáveis (segurança):** `executar_comando`, `gerenciar_cron`, `gerenciar_ferramentas` — bloqueio hardcoded em `permissions.js`

### Permissões granulares do WhatsApp (whatsapp_permissions)

O `user_allowed_tools` libera `acoes_whatsapp` de forma completa (todas as ações, todos os destinos). Para controle fino, configure `whatsapp_permissions` no `config.json`:

```json
{
    "user_allowed_tools": ["acoes_whatsapp"],
    "whatsapp_permissions": {
        "allowed_actions": ["enviar_mensagem"],
        "allowed_targets": ["master"]
    }
}
```

**`allowed_actions`** — quais ações WhatsApp são permitidas no contexto de users:
- `enviar_mensagem`, `enviar_audio`, `verificar_contato`, `info_perfil`
- Se não definido ou vazio: todas as ações são permitidas

**`allowed_targets`** — para quem o bot pode enviar no contexto de users:
- `"master"` — resolve automaticamente para o `master_jid` do config
- `"sender"` — resolve para o JID do remetente atual (o user que está conversando)
- JID literal — ex: `"5511999999999@s.whatsapp.net"` ou `"278876890603567@lid"`
- Número de telefone — ex: `"5511999999999"` (convertido automaticamente para JID)
- Se não definido ou vazio: todos os destinos são permitidos

**Exemplo prático:** "Quero que o bot me avise quando alguém mandar mensagem"
```json
{
    "user_allowed_tools": ["acoes_whatsapp"],
    "whatsapp_permissions": {
        "allowed_actions": ["enviar_mensagem"],
        "allowed_targets": ["master"]
    }
}
```
O bot pode enviar mensagem ao master quando um user interage, mas NÃO pode enviar para qualquer outro número.

### Pasta compartilhada (master_shared_user/)

`/data/master_shared_user/` é uma pasta compartilhada entre master e users:

- **Master:** acesso total (leitura + escrita)
- **Users:** somente leitura (pode ler e listar, não pode escrever)

Use para compartilhar documentos, FAQs, regras, catálogos, ou qualquer informação que users devem poder acessar via bot.

### Sanitização de paths

O dispatcher (`tools/index.js`) bloqueia path traversal antes de executar qualquer handler:
- Normaliza o path com `path.normalize()`
- Rejeita paths contendo `..`
- Rejeita paths absolutos (`path.isAbsolute()`)

## Tool: Ações WhatsApp (acoes_whatsapp)

Tool que permite ao agente realizar ações autônomas no WhatsApp:

| Ação                | Descrição                                                |
|---------------------|----------------------------------------------------------|
| `enviar_mensagem`   | Envia texto para qualquer contato/número                  |
| `enviar_audio`      | Sintetiza texto em voz (OpenAI TTS) e envia como áudio    |
| `verificar_contato` | Verifica se um número existe no WhatsApp                  |
| `info_perfil`       | Obtém status e foto de perfil de um contato               |

O agente pode usar `phone` (número) ou `target_jid` (JID completo) como identificador.

No contexto de users, ações e destinos podem ser restritos via `whatsapp_permissions`.

## Sistema de cron jobs

O bot usa o cron nativo do Linux para agendar tarefas automáticas. O agente (master) cria, lista e remove jobs via a tool `gerenciar_cron`.

### Modos de execução

| Modo     | Descrição                                                          | Consome tokens? |
|----------|--------------------------------------------------------------------|-----------------|
| `agent`  | Quando o cron dispara, executa via Claude (tool use completo)       | Sim             |
| `direct` | Quando o cron dispara, executa um script diretamente (stdout = msg) | Não             |

### Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│  cron_jobs.json ──→ syncCrontab() ──→ crontab do sistema    │
│                                                             │
│  crontab dispara ──→ cron_trigger.sh ──→ trigger file       │
│                                                             │
│  cron.js (polling 10s) ──→ detecta trigger                  │
│     ├── mode "agent"  ──→ runAgent() ──→ sendMessage()      │
│     └── mode "direct" ──→ execSync(script) ──→ sendMessage()│
└─────────────────────────────────────────────────────────────┘
```

### Formato de um job (mode agent)

```json
{
    "id": "a1b2c3d4-e5f6-...",
    "schedule": "0 8 * * 1-5",
    "description": "Tarefa diária às 8h",
    "target_jid": "278876890603567@lid",
    "mode": "agent",
    "prompt": "Execute a tarefa X e me envie o resultado.",
    "role": "master",
    "created_by": "278876890603567@lid",
    "created_at": "2026-03-03T23:00:00.000Z"
}
```

### Formato de um job (mode direct)

```json
{
    "id": "b2c3d4e5-f6a7-...",
    "schedule": "*/5 * * * *",
    "description": "Monitor de preço do Bitcoin a cada 5 minutos",
    "target_jid": "278876890603567@lid",
    "mode": "direct",
    "script": "scripts/bitcoin_monitor.sh",
    "role": "master",
    "created_by": "278876890603567@lid",
    "created_at": "2026-03-03T23:00:00.000Z"
}
```

### Exemplo: monitor de preço (cron direto)

1. Bot cria o script via `escrever_arquivo`:
```bash
#!/bin/sh
curl -s "https://api.coindesk.com/v1/bpi/currentprice.json" | jq -r '"Bitcoin: $" + .bpi.USD.rate'
```

2. Bot cria o cron via `gerenciar_cron`:
```json
{
    "action": "criar",
    "schedule": "*/5 * * * *",
    "mode": "direct",
    "script": "scripts/bitcoin_monitor.sh",
    "description": "Monitor de preço do Bitcoin a cada 5 minutos"
}
```

3. A cada 5 minutos, o script roda e o stdout ("Bitcoin: $97,123.45") é enviado como mensagem.

### Comportamento de cron no histórico

Quando um cron dispara no modo "agent", o `runAgent` roda com `fromCron=true`:
- O **prompt do cron NÃO é salvo** no histórico do contato (é uma instrução interna)
- A **resposta DO agente É salva** no histórico (para contexto em conversas futuras)

No modo "direct", nada é salvo no histórico (execução puramente mecânica).

### Fuso horário

O cron do Linux usa **UTC** por padrão dentro do container.
- BRT (Brasília): UTC-3 → 8h local = `0 11 * * *` no cron
- Para mudar o timezone do container, adicionar `TZ=America/Sao_Paulo` no `.env`

## Filesystem persistente (/data/)

```
/data/
├── auth/                  # Baileys auth state (credenciais WhatsApp)
│   ├── creds.json
│   └── ...
├── config.json            # Configuração do bot (criado no onboarding)
│   └── inclui master_jid  # JID do master, injetado automaticamente
├── memory/                # Histórico de conversa por contato
│   ├── 5511999990001.json
│   └── ...
├── tmp/                   # Arquivos temporários (áudio, conversões)
├── cron_jobs.json         # Definições de cron jobs (gerenciado por cron.js)
├── cron_triggers/         # Arquivos trigger temporários (processados e deletados)
├── custom_tools/          # Ferramentas customizadas criadas pelo bot
│   ├── registry.json      # Registro com schemas das custom tools
│   └── *.js               # Handlers das ferramentas
├── master_shared_user/    # Pasta compartilhada: leitura para users, total para master
└── (o restante é criado pelo agente conforme necessidade)
    ├── users/             # Dados por usuário (pasta individual)
    ├── scripts/           # Scripts para cron direto
    └── ...
```

Apenas `auth/`, `config.json`, `memory/`, `tmp/`, `cron_jobs.json`, `cron_triggers/` e `custom_tools/` têm estrutura definida pelo código. O agente organiza o restante livremente.

## Autenticação Claude

Configure `ANTHROPIC_API_KEY` no `.env` com sua chave da API Anthropic. Cobrado por uso via API.

## Variáveis de ambiente (.env)

| Variável              | Obrigatória | Default                      | Descrição                              |
|-----------------------|-------------|------------------------------|----------------------------------------|
| `ANTHROPIC_API_KEY`   | Sim         | —                            | Chave da API Anthropic (Claude)        |
| `CLAUDE_MODEL`        | Não         | `claude-sonnet-4-6`             | Modelo Claude para raciocínio          |
| `OPENAI_API_KEY`      | Não**       | —                            | Chave da API OpenAI (para mídia)       |
| `OPENAI_MODEL`        | Não         | `gpt-4o`                     | Modelo OpenAI para visão               |
| `MASTER_PHONE`        | Não***      | `''`                         | Telefone do master (fallback, sem +)   |
| `MAX_TOOL_ITERATIONS` | Não         | `10`                         | Max iterações do loop de tool use      |
| `DEBOUNCE_SECONDS`    | Não         | `13`                         | Segundos para agrupar mensagens rápidas|
| `MEMORY_MAX_MESSAGES` | Não         | `100`                        | Max mensagens armazenadas por contato  |
| `DATA_DIR`            | Não         | `/data`                      | Diretório de dados persistentes        |
| `LOG_LEVEL`           | Não         | `info`                       | Nível de log (debug, info, warn, error)|

**`OPENAI_API_KEY` é necessária apenas para funcionalidades de áudio (Whisper/TTS) e imagem (Vision).
***`MASTER_PHONE` é fallback — o sistema usa `master_jid` do config.json como fonte primária.

## Limites e constantes internas

| Constante               | Valor    | Arquivo          | Descrição                                   |
|--------------------------|----------|------------------|---------------------------------------------|
| Context window (API)     | 30 msgs  | `agent.js`       | Últimas N mensagens enviadas para Claude     |
| Max tokens (resposta)    | 8192     | `agent.js`       | Max tokens na resposta do Claude             |
| History storage          | 100 msgs | `memory.js`      | Max mensagens salvas em disco por contato    |
| Shell timeout            | 30s      | `exec.js`        | Timeout para comandos shell                  |
| Shell max buffer         | 1MB      | `exec.js`        | Buffer máximo de saída do comando            |
| Shell output truncation  | 10000ch  | `exec.js`        | Saída truncada para não estourar payload     |
| Direct script timeout    | 30s      | `cron.js`        | Timeout para scripts de cron direto          |
| Cron trigger polling     | 10s      | `cron.js`        | Intervalo de verificação de triggers         |
| Reconnect delay          | 3s       | `whatsapp.js`    | Espera antes de reconectar ao WhatsApp       |
| Keep-alive interval      | 25s      | `whatsapp.js`    | Pings de keep-alive para WhatsApp            |
| Connection timeout       | 60s      | `whatsapp.js`    | Timeout de conexão inicial                   |
| ffmpeg timeout           | 15s      | `router.js`      | Timeout para conversão de áudio              |

## Comandos de operação

```bash
# Build e start
docker compose up -d --build

# Ver logs (QR code aparece aqui)
docker logs -f openzap

# Restart sem rebuild
docker compose restart

# Parar
docker compose down

# Backup dos dados
docker cp openzap:/data ./backup-$(date +%F)

# Reset completo (novo QR code)
docker exec openzap rm -rf /data/auth/
docker compose restart

# Reset do onboarding (refazer config)
docker exec openzap rm /data/config.json
docker exec openzap rm -rf /data/memory/
docker compose restart

# Ver config atual
docker exec openzap cat /data/config.json

# Ver cron jobs ativos
docker exec openzap cat /data/cron_jobs.json
docker exec openzap crontab -l

# Ver ferramentas customizadas
docker exec openzap cat /data/custom_tools/registry.json

# Limpar todos os cron jobs
docker exec openzap sh -c 'echo "[]" > /data/cron_jobs.json && crontab -r'

# Dev local (sem Docker)
npm install
DATA_DIR=./data node src/index.js
```

## Onboarding

Na primeira execução (sem `config.json`), qualquer mensagem recebida é tratada como vinda do master. O agente inicia uma conversa guiada coletando:

1. Nome do assistente (como o bot se chamará)
2. Propósito/função principal
3. Instruções de comportamento (tom de voz, regras, personalidade)
4. Quem pode interagir (open ou restricted)
5. Qualquer outra configuração desejada

Após confirmação, salva `/data/config.json` com `setup_complete: true` e o `master_jid` é injetado automaticamente pelo `file_write.js`.

## Decisões de design relevantes

- **Claude para raciocínio, OpenAI para mídia**: Claude Opus 4.6 é o motor principal de pensamento e tool use. OpenAI é usado apenas para processar mídia (vision, whisper, TTS) — tarefas onde excele.
- **Tool use format Anthropic**: As tools usam o formato `input_schema` do Anthropic em vez de `parameters` do OpenAI. Tool results vão como mensagens `user` com content blocks `tool_result`.
- **Socket global**: `whatsapp.js` expõe `getSock()` para que a tool `acoes_whatsapp` possa enviar mensagens e realizar ações de forma autônoma.
- **Áudio bidirecional**: Entrada (Whisper) e saída (TTS) de áudio via OpenAI, com ffmpeg para conversão de formatos.
- **Propósito genérico**: O onboarding não assume nenhum domínio (clínica, vendas, etc). O master define livremente o que o bot faz.
- **Cron via Linux nativo**: Usa o `cron` daemon do Debian. Mais confiável que schedulers em Node.js para tarefas de longo prazo.
- **Cron direto (mode "direct")**: Scripts executados diretamente pelo cron sem passar pelo Claude. Stdout vira mensagem. Sem custo de tokens.
- **Ferramentas customizadas**: O bot cria tools em runtime via `gerenciar_ferramentas`. Handlers em `/data/custom_tools/` são carregados com `require()` e cache é limpo a cada execução para refletir edições.
- **Tools refresh por iteração**: `getToolDefinitions()` é chamado a cada iteração do loop no `agent.js`, garantindo que custom tools criadas na mesma conversa fiquem disponíveis imediatamente.
- **Permissões granulares WhatsApp**: `whatsapp_permissions` no config.json permite restringir ações e destinos quando `acoes_whatsapp` é liberada para users. Suporta keywords `"master"` e `"sender"` além de JIDs/telefones literais.
- **master_shared_user/**: Pasta compartilhada com users (leitura) e master (total). Permite ao master disponibilizar documentos, FAQs, etc.
- **`fromCron` no agent.js**: Prompt do cron não polui histórico, mas a resposta sim (mantém contexto).
- **Dependência circular `cron.js ↔ agent.js`**: Resolvida com lazy `require()` dentro de `processAgentTrigger()`.
- **Lazy require em `whatsapp_actions.js`**: Importa `getSock()` em runtime para evitar dependência circular.
- **`execSync` no `exec.js` e cron direto**: Bloqueia o event loop por até 30s. Aceitável para operações pontuais.
- **Debounce de 13s**: Configurável via `DEBOUNCE_SECONDS`.
- **Nomes de tools em português**: Consistente com os prompts em português.
- **Sem framework web**: O container não abre portas. Toda comunicação via WebSocket de saída.
- **CommonJS (require)**: Sem ESModules, sem build step. `node src/index.js` roda direto.

## Dependências (5 runtime)

| Pacote                      | Versão   | Propósito                                 |
|-----------------------------|----------|-------------------------------------------|
| `@anthropic-ai/sdk`        | ^0.39.0  | SDK Anthropic (Claude) — raciocínio + tools|
| `@whiskeysockets/baileys`   | ^6.7.16  | Protocolo WhatsApp Web (WebSocket)         |
| `openai`                    | ^4.77.0  | SDK OpenAI — Vision, Whisper, TTS          |
| `pino`                      | ^9.6.0   | Logger estruturado JSON                    |
| `qrcode-terminal`           | ^0.12.0  | Renderiza QR code no terminal              |

`@hapi/boom` é dependência transitiva do Baileys, usada em `whatsapp.js` para checar `DisconnectReason`.

## Problemas conhecidos e como resolver

| Problema | Causa | Solução |
|----------|-------|---------|
| QR code não aparece | Terminal sem suporte | `docker logs -f openzap` — QR renderizado via `qrcode-terminal` |
| Bot não responde | Sessão expirada | `docker exec openzap rm -rf /data/auth/` + restart |
| Master tratado como user | JID mudou ou `master_jid` ausente | Verificar config: `docker exec openzap cat /data/config.json` — campo `master_jid` deve existir |
| Mensagens duplicadas | Baileys reprocessando histórico | Filtro `type !== 'notify'` em `whatsapp.js` descarta msgs históricas |
| Erro "Caminho inválido" | Path traversal bloqueado | Path deve ser relativo, sem `..`, sem `/` inicial |
| Token usage alto | Contexto grande | Reduzir `CONTEXT_WINDOW` em `agent.js` (default 30) |
| Cron não dispara | Daemon cron não rodando | `docker exec openzap crontab -l` para verificar; `docker compose restart` para reiniciar |
| Cron dispara no horário errado | Fuso horário UTC no container | Adicionar `TZ=America/Sao_Paulo` no `.env` |
| Cron direto falha | Script não encontrado ou sem permissão | Verificar caminho em cron_jobs.json; erros são enviados ao destinatário |
| Custom tool não funciona | Handler com erro de sintaxe | Usar `gerenciar_ferramentas` com action "ver_codigo" para inspecionar |
| Áudio não transcreve | OpenAI key ausente ou ffmpeg falhou | Verificar `OPENAI_API_KEY` no `.env` e logs |
| Imagem não analisa | OpenAI key ausente | Verificar `OPENAI_API_KEY` no `.env` |
| TTS não funciona | OpenAI key ausente | Verificar `OPENAI_API_KEY` no `.env` |
