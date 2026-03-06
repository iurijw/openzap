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
    ├── oauth.js               # OAuth 2.0 — autorização Claude Pro/Max via assinatura
    ├── config.js              # Env vars, resolveRole(), prompts dinâmicos
    ├── memory.js              # Histórico por contato em JSON (1 arquivo por telefone)
    ├── cron.js                # Gerenciador de cron: daemon, jobs, polling de triggers
    ├── tools/
    │   ├── index.js           # Dispatcher: permissão → sanitização → execução
    │   ├── definitions.js     # Schemas das 6 tools para Anthropic Claude
    │   ├── permissions.js     # Controle de acesso por role (master/user)
    │   ├── file_read.js       # Tool: ler arquivo de /data/
    │   ├── file_write.js      # Tool: escrever arquivo (injeta master_jid no config)
    │   ├── file_list.js       # Tool: listar diretório
    │   ├── exec.js            # Tool: executar comando shell (30s timeout)
    │   ├── cron.js            # Tool: gerenciar cron jobs (criar/listar/remover)
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
│  ├── Tool use (6 tools)                                              │
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
        → file_read / file_write / file_list / exec / cron / whatsapp_actions
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

### Cron jobs (Crontab → Trigger → Bot → WhatsApp)

```
cron daemon (Linux) → scripts/cron_trigger.sh (lê job, escreve trigger file)
  → /data/cron_triggers/{timestamp}-{job_id}.json
    → cron.js (polling a cada 10s detecta o arquivo)
      → agent.js (runAgent com fromCron=true)
      ← compõe mensagem
    → whatsapp.js (envia mensagem ao target_jid)
  → WhatsApp
```

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

| Tool                 | Master          | User                                       |
|----------------------|-----------------|---------------------------------------------|
| `executar_comando`   | Liberado (tudo) | Bloqueado sempre                             |
| `gerenciar_cron`     | Liberado (tudo) | Bloqueado sempre                             |
| `acoes_whatsapp`     | Liberado (tudo) | Bloqueado sempre                             |
| `escrever_arquivo`   | Liberado (tudo) | Só `users/{phone}/`                          |
| `ler_arquivo`        | Liberado (tudo) | Só `config.json` e `users/{phone}/`          |
| `listar_arquivos`    | Liberado (tudo) | Só `users/{phone}/`; bloqueado raiz e `users/` |

### Sanitização de paths

O dispatcher (`tools/index.js`) bloqueia path traversal antes de executar qualquer handler:
- Normaliza o path com `path.normalize()`
- Rejeita paths contendo `..`
- Rejeita paths absolutos (`path.isAbsolute()`)

## Tool: Ações WhatsApp (acoes_whatsapp)

Nova tool que permite ao agente realizar ações autônomas no WhatsApp:

| Ação                | Descrição                                                |
|---------------------|----------------------------------------------------------|
| `enviar_mensagem`   | Envia texto para qualquer contato/número                  |
| `enviar_audio`      | Sintetiza texto em voz (OpenAI TTS) e envia como áudio    |
| `verificar_contato` | Verifica se um número existe no WhatsApp                  |
| `info_perfil`       | Obtém status e foto de perfil de um contato               |

O agente pode usar `phone` (número) ou `target_jid` (JID completo) como identificador.

## Sistema de cron jobs

O bot usa o cron nativo do Linux para agendar tarefas automáticas. O agente (master) cria, lista e remove jobs via a tool `gerenciar_cron`.

### Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│  cron_jobs.json ──→ syncCrontab() ──→ crontab do sistema    │
│                                                             │
│  crontab dispara ──→ cron_trigger.sh ──→ trigger file       │
│                                                             │
│  cron.js (polling 10s) ──→ detecta trigger ──→ runAgent()   │
│                                ──→ sendMessage()            │
└─────────────────────────────────────────────────────────────┘
```

### Formato de um job

```json
{
    "id": "a1b2c3d4-e5f6-...",
    "schedule": "0 8 * * 1-5",
    "description": "Tarefa diária às 8h",
    "target_jid": "278876890603567@lid",
    "prompt": "Execute a tarefa X e me envie o resultado.",
    "role": "master",
    "created_by": "278876890603567@lid",
    "created_at": "2026-03-03T23:00:00.000Z"
}
```

### Comportamento de cron no histórico

Quando um cron dispara, o `runAgent` roda com `fromCron=true`:
- O **prompt do cron NÃO é salvo** no histórico do contato (é uma instrução interna)
- A **resposta DO agente É salva** no histórico (para contexto em conversas futuras)

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
└── (o restante é criado pelo agente conforme necessidade)
    ├── users/             # Dados por usuário (pasta individual)
    └── ...
```

Apenas `auth/`, `config.json`, `memory/`, `tmp/`, `cron_jobs.json` e `cron_triggers/` têm estrutura definida pelo código. O agente organiza o restante livremente.

## Autenticação Claude (API key vs OAuth)

O bot suporta dois modos de autenticação com a Anthropic, que podem coexistir:

### Opção 1: API Key (padrão)
Configure `ANTHROPIC_API_KEY` no `.env`. Cobrado por uso via API.

### Opção 2: OAuth (assinatura Pro/Max)
Permite usar sua assinatura Claude Pro/Max em vez de pagar pela API.

**Setup:**
1. Registre um app OAuth em `https://console.anthropic.com/settings/oauth`
2. Configure `CLAUDE_OAUTH_CLIENT_ID` (e opcionalmente `CLIENT_SECRET`) no `.env`
3. Inicie o bot: `docker compose up -d --build`
4. Envie qualquer mensagem pelo WhatsApp — o bot responde com o link de autorização
5. Abra o link no navegador e autorize com sua conta Anthropic
6. O navegador redireciona para uma URL que não carrega (normal)
7. Copie a URL completa da barra de endereço e envie pelo WhatsApp
8. Pronto — o bot confirma e começa a funcionar

**Fluxo:**
```
Master envia msg → Bot gera auth URL → Master autoriza no browser
→ Copia callback URL → Cola no WhatsApp → Bot troca code por tokens
→ Tokens salvos em /data/oauth_tokens.json → Bot operacional
```

**Comandos:**
- Enviar `oauth` pelo WhatsApp = gerar nova URL de autorização (para reconfigurar)

**Prioridade de auth:** OAuth tokens > API key > erro.
Se OAuth expira, o bot tenta refresh automático. Se falhar, usa API key como fallback.

**Tokens persistidos em:** `/data/oauth_tokens.json` (auto-refreshed)

## Variáveis de ambiente (.env)

| Variável              | Obrigatória | Default                      | Descrição                              |
|-----------------------|-------------|------------------------------|----------------------------------------|
| `ANTHROPIC_API_KEY`   | Não*        | —                            | Chave da API Anthropic (Claude)        |
| `CLAUDE_MODEL`        | Não         | `claude-sonnet-4-6`             | Modelo Claude para raciocínio          |
| `OPENAI_API_KEY`      | Não**       | —                            | Chave da API OpenAI (para mídia)       |
| `OPENAI_MODEL`        | Não         | `gpt-4o`                     | Modelo OpenAI para visão               |
| `MASTER_PHONE`        | Não***      | `''`                         | Telefone do master (fallback, sem +)   |
| `MAX_TOOL_ITERATIONS` | Não         | `10`                         | Max iterações do loop de tool use      |
| `DEBOUNCE_SECONDS`    | Não         | `13`                         | Segundos para agrupar mensagens rápidas|
| `MEMORY_MAX_MESSAGES` | Não         | `100`                        | Max mensagens armazenadas por contato  |
| `DATA_DIR`            | Não         | `/data`                      | Diretório de dados persistentes        |
| `LOG_LEVEL`           | Não         | `info`                       | Nível de log (debug, info, warn, error)|

**OAuth (alternativa à API key):**

| Variável                    | Default                                    | Descrição                          |
|-----------------------------|--------------------------------------------|------------------------------------|
| `CLAUDE_OAUTH_CLIENT_ID`   | —                                          | Client ID do app OAuth             |
| `CLAUDE_OAUTH_CLIENT_SECRET`| —                                         | Client Secret (se confidential)    |
| `CLAUDE_OAUTH_REDIRECT_URI`| `https://localhost/oauth/callback`          | URI de redirecionamento            |
| `CLAUDE_OAUTH_AUTH_URL`    | `https://auth.anthropic.com/authorize`      | Endpoint de autorização            |
| `CLAUDE_OAUTH_TOKEN_URL`   | `https://auth.anthropic.com/oauth/token`    | Endpoint de token                  |
| `CLAUDE_OAUTH_SCOPES`      | `user:inference`                            | Escopos OAuth                      |

*`ANTHROPIC_API_KEY` é obrigatória se OAuth não estiver configurado. Com OAuth, é opcional (usado como fallback).
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
- **`fromCron` no agent.js**: Prompt do cron não polui histórico, mas a resposta sim (mantém contexto).
- **Dependência circular `cron.js ↔ agent.js`**: Resolvida com lazy `require()` dentro de `processTrigger()`.
- **Lazy require em `whatsapp_actions.js`**: Importa `getSock()` em runtime para evitar dependência circular.
- **`execSync` no `exec.js`**: Bloqueia o event loop por até 30s. Aceitável para operações pontuais.
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
| Áudio não transcreve | OpenAI key ausente ou ffmpeg falhou | Verificar `OPENAI_API_KEY` no `.env` e logs |
| Imagem não analisa | OpenAI key ausente | Verificar `OPENAI_API_KEY` no `.env` |
| TTS não funciona | OpenAI key ausente | Verificar `OPENAI_API_KEY` no `.env` |
