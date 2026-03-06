# OpenZap

Agente autonomo de WhatsApp. Um unico container Docker, sem banco de dados, sem Redis, sem painel web.

Voce define o proposito: atendimento, vendas, suporte, automacao, o que quiser.
O bot conecta no WhatsApp, pensa com Claude (Anthropic) e age de forma autonoma.

## Como funciona

```
WhatsApp (Baileys WebSocket) --> Claude (raciocinio + tools) --> WhatsApp
                                     |
                                OpenAI (apenas midia: vision, whisper, TTS)
```

- **Claude** faz todo o raciocinio, conversacao e uso de ferramentas
- **OpenAI** e usado apenas para: analisar imagens (Vision), transcrever audio (Whisper) e gerar audio falado (TTS)
- **Baileys** conecta ao WhatsApp via WebSocket de saida (nenhuma porta exposta)
- Tudo persiste em `/data/` dentro do container (volume Docker)

## Pre-requisitos

- Docker e Docker Compose
- Chave de API da Anthropic ([console.anthropic.com](https://console.anthropic.com))
- Chave de API da OpenAI (opcional, necessaria para audio e imagem)
- Um numero de WhatsApp para o bot (sera vinculado via QR code)

## Instalacao

### 1. Clone o repositorio

```bash
git clone https://github.com/iurijw/openzap.git
cd openzap
```

### 2. Configure o .env

```bash
cp .env.example .env
```

Edite o `.env` com suas chaves:

```env
# OBRIGATORIO - Chave da API Anthropic
ANTHROPIC_API_KEY=sk-ant-sua-chave-aqui

# OPCIONAL - Modelo Claude (default: claude-sonnet-4-6)
CLAUDE_MODEL=claude-sonnet-4-6

# OPCIONAL - Chave da API OpenAI (para audio e imagem)
OPENAI_API_KEY=sk-sua-chave-aqui

# RECOMENDADO - Telefone do master (com codigo do pais, sem +)
MASTER_PHONE=5511999999999
```

### 3. Suba o container

```bash
docker compose up -d --build
```

### 4. Escaneie o QR code

```bash
docker logs -f openzap
```

O QR code aparece no terminal. Escaneie com o WhatsApp do numero que sera o bot:
- WhatsApp > Dispositivos conectados > Conectar dispositivo

### 5. Faca o onboarding

Envie qualquer mensagem pelo WhatsApp do **master** (o numero configurado em `MASTER_PHONE`). O bot inicia uma conversa guiada perguntando:

1. Nome do assistente
2. Proposito/funcao principal
3. Instrucoes de comportamento (tom, regras, personalidade)
4. Quem pode interagir (aberto a todos ou restrito)

Apos confirmar, o bot salva a configuracao e esta pronto para operar.

## Variaveis de ambiente

| Variavel | Obrigatoria | Default | Descricao |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sim | — | Chave da API Anthropic |
| `CLAUDE_MODEL` | Nao | `claude-sonnet-4-6` | Modelo Claude |
| `OPENAI_API_KEY` | Nao | — | Chave OpenAI (para audio/imagem) |
| `OPENAI_MODEL` | Nao | `gpt-4o` | Modelo OpenAI para vision |
| `MASTER_PHONE` | Recomendada | — | Telefone do master (sem +) |
| `MAX_TOOL_ITERATIONS` | Nao | `10` | Max iteracoes no loop de tools |
| `DEBOUNCE_SECONDS` | Nao | `13` | Segundos para agrupar mensagens rapidas |
| `MEMORY_MAX_MESSAGES` | Nao | `100` | Max mensagens no historico por contato |
| `DATA_DIR` | Nao | `/data` | Diretorio de dados persistentes |
| `LOG_LEVEL` | Nao | `info` | Nivel de log (debug, info, warn, error) |
| `TZ` | Nao | `UTC` | Fuso horario do container (ex: `America/Sao_Paulo`) |

## Roles: Master vs User

| | Master | User |
|---|---|---|
| Quem e | O dono do bot (primeiro a enviar msg ou `MASTER_PHONE`) | Qualquer outro contato |
| Comandos shell | Liberado | Bloqueado |
| Cron jobs | Liberado | Bloqueado |
| Acoes WhatsApp | Liberado | Bloqueado |
| Escrita de arquivos | Tudo em `/data/` | Apenas `users/{phone}/` |
| Leitura de arquivos | Tudo em `/data/` | Apenas `config.json` e `users/{phone}/` |

O master e identificado automaticamente:
1. Sem config (onboarding): primeiro remetente = master
2. `master_jid` salvo no config.json (injetado automaticamente)
3. `MASTER_PHONE` do .env (fallback)

## Ferramentas do agente

O Claude tem acesso a 6 ferramentas que usa de forma autonoma:

| Ferramenta | O que faz |
|---|---|
| `executar_comando` | Roda comandos shell no Linux (apt, curl, scripts, etc.) |
| `ler_arquivo` | Le arquivos de `/data/` |
| `escrever_arquivo` | Cria/sobrescreve arquivos em `/data/` |
| `listar_arquivos` | Lista diretorios em `/data/` |
| `gerenciar_cron` | Cria, lista e remove tarefas agendadas (cron jobs) |
| `acoes_whatsapp` | Envia mensagens, audio TTS, verifica contatos |

## Cron jobs (tarefas agendadas)

O master pode pedir ao bot para agendar tarefas automaticas. Exemplos:

- "Me lembre todo dia as 8h de verificar o email"
- "Todo dia util as 18h, envie um resumo do dia"
- "A cada 30 minutos, verifique se o site X esta online"

O cron usa o daemon nativo do Linux. Os horarios seguem o fuso do container (UTC por padrao). Para usar horario de Brasilia, adicione `TZ=America/Sao_Paulo` no `.env`.

## Midia (audio e imagem)

Requer `OPENAI_API_KEY` configurada.

**Audio recebido:** Transcrito automaticamente via OpenAI Whisper e processado como texto.

**Imagem recebida:** Analisada automaticamente via OpenAI GPT-4o Vision e processada como descricao textual.

**Audio enviado (TTS):** O agente pode gerar audio falado via OpenAI TTS e enviar como mensagem de voz.

## Comandos uteis

```bash
# Subir o bot
docker compose up -d --build

# Ver logs (e QR code)
docker logs -f openzap

# Reiniciar sem rebuild
docker compose restart

# Parar
docker compose down

# Backup dos dados
docker cp openzap:/data ./backup

# Novo QR code (reconectar WhatsApp)
docker exec openzap rm -rf /data/auth/
docker compose restart

# Refazer onboarding do zero
docker exec openzap rm /data/config.json
docker exec openzap rm -rf /data/memory/
docker compose restart

# Ver configuracao atual
docker exec openzap cat /data/config.json

# Ver cron jobs ativos
docker exec openzap cat /data/cron_jobs.json

# Dev local (sem Docker)
npm install
DATA_DIR=./data node src/index.js
```

## Estrutura de arquivos

```
openzap/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── scripts/
│   └── cron_trigger.sh
└── src/
    ├── index.js               # Entry point
    ├── whatsapp.js            # Conexao Baileys + QR code
    ├── router.js              # Roteamento de mensagens + audio/imagem
    ├── agent.js               # Loop de raciocinio Claude (tool use)
    ├── config.js              # Variaveis, roles, prompts
    ├── memory.js              # Historico por contato (JSON)
    ├── cron.js                # Sistema de cron jobs
    ├── tools/
    │   ├── index.js           # Dispatcher (permissao + sanitizacao)
    │   ├── definitions.js     # Schemas das tools
    │   ├── permissions.js     # Controle de acesso master/user
    │   ├── file_read.js
    │   ├── file_write.js
    │   ├── file_list.js
    │   ├── exec.js
    │   ├── cron.js
    │   └── whatsapp_actions.js
    └── utils/
        ├── debounce.js
        └── logger.js
```

## Dados persistentes (/data/)

```
/data/
├── auth/              # Credenciais WhatsApp (Baileys)
├── config.json        # Configuracao do bot (gerado no onboarding)
├── memory/            # Historico de conversa por contato
├── tmp/               # Arquivos temporarios (audio, conversoes)
├── cron_jobs.json     # Definicoes de cron jobs
├── cron_triggers/     # Triggers temporarios de cron
└── ...                # O agente organiza o restante livremente
```

## Resolucao de problemas

| Problema | Solucao |
|---|---|
| QR code nao aparece | `docker logs -f openzap` — ele e renderizado nos logs |
| Bot nao responde | Sessao expirou. `docker exec openzap rm -rf /data/auth/` + restart |
| Master tratado como user | Verifique `master_jid` em `docker exec openzap cat /data/config.json` |
| Cron no horario errado | Adicione `TZ=America/Sao_Paulo` no `.env` e reinicie |
| Audio/imagem nao funciona | Verifique se `OPENAI_API_KEY` esta no `.env` |
| Erro "Caminho invalido" | Paths devem ser relativos, sem `..` e sem `/` no inicio |
| Mensagens duplicadas | Normal na reconexao — o filtro descarta msgs historicas |

## Limites internos

| O que | Valor | Onde |
|---|---|---|
| Contexto enviado ao Claude | 30 msgs | agent.js |
| Max tokens na resposta | 8192 | agent.js |
| Historico salvo em disco | 100 msgs/contato | memory.js |
| Timeout de comandos shell | 30s | exec.js |
| Polling de cron triggers | 10s | cron.js |
| Debounce de mensagens | 13s | debounce.js |
| Timeout de conexao WhatsApp | 60s | whatsapp.js |

## Licenca

MIT
