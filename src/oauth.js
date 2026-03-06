const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const logger = require('./utils/logger');

// --- Configuração via env ---
const DATA_DIR = process.env.DATA_DIR || '/data';
const TOKENS_FILE = path.join(DATA_DIR, 'oauth_tokens.json');

const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLAUDE_OAUTH_CLIENT_SECRET || '';
const AUTH_URL = process.env.CLAUDE_OAUTH_AUTH_URL || 'https://auth.anthropic.com/authorize';
const TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL || 'https://auth.anthropic.com/oauth/token';
const REDIRECT_URI = process.env.CLAUDE_OAUTH_REDIRECT_URI || 'https://localhost/oauth/callback';
const SCOPES = process.env.CLAUDE_OAUTH_SCOPES || 'user:inference';

// Cache em memória
let tokenCache = null;
let pendingState = null;
let pendingCodeVerifier = null;

// --- Helpers ---

/**
 * Checa se OAuth está configurado (pelo menos client_id presente).
 */
function isConfigured() {
    return !!CLIENT_ID;
}

// --- Token persistence ---

async function loadTokens() {
    if (tokenCache) return tokenCache;
    try {
        const data = await fs.readFile(TOKENS_FILE, 'utf-8');
        tokenCache = JSON.parse(data);
        return tokenCache;
    } catch {
        return null;
    }
}

async function saveTokens(tokens) {
    tokenCache = tokens;
    await fs.mkdir(path.dirname(TOKENS_FILE), { recursive: true });
    await fs.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    logger.info('OAuth: tokens salvos');
}

async function clearTokens() {
    tokenCache = null;
    await fs.unlink(TOKENS_FILE).catch(() => {});
    logger.info('OAuth: tokens removidos');
}

// --- Token status ---

/**
 * Verifica se existem tokens válidos (refresh se expirado).
 */
async function hasValidTokens() {
    const tokens = await loadTokens();
    if (!tokens?.access_token) return false;

    // Se expirou, tenta refresh
    if (tokens.expires_at && Date.now() >= tokens.expires_at) {
        if (tokens.refresh_token) {
            try {
                await refreshAccessToken();
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }

    return true;
}

/**
 * Retorna o access token válido (faz refresh se necessário).
 * @returns {Promise<string|null>}
 */
async function getAccessToken() {
    const tokens = await loadTokens();
    if (!tokens?.access_token) return null;

    // Refresh 60s antes de expirar (margem de segurança)
    if (tokens.expires_at && Date.now() >= tokens.expires_at - 60000) {
        if (tokens.refresh_token) {
            try {
                const refreshed = await refreshAccessToken();
                return refreshed.access_token;
            } catch (err) {
                logger.error({ err }, 'OAuth: falha no refresh do token');
                return null;
            }
        }
        return null;
    }

    return tokens.access_token;
}

// --- PKCE ---

function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// --- OAuth flow ---

/**
 * Gera a URL de autorização para o usuário visitar.
 * Usa PKCE para segurança adicional.
 * @returns {string} URL de autorização
 */
function generateAuthUrl() {
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Guardar para verificação posterior
    pendingState = state;
    pendingCodeVerifier = codeVerifier;

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });

    return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Troca o código de autorização por tokens (access + refresh).
 * @param {string} code - Código de autorização
 * @param {string} [state] - State para validação CSRF
 * @returns {Promise<object>} Tokens obtidos
 */
async function exchangeCode(code, state) {
    // Validar state (proteção CSRF)
    if (pendingState && state && state !== pendingState) {
        throw new Error('Parâmetro state não confere. Gere uma nova URL de autorização.');
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
    });

    if (CLIENT_SECRET) {
        body.append('client_secret', CLIENT_SECRET);
    }

    if (pendingCodeVerifier) {
        body.append('code_verifier', pendingCodeVerifier);
    }

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Falha na troca de tokens (${response.status}): ${errText}`);
    }

    const tokens = await response.json();

    // Calcular timestamp de expiração
    if (tokens.expires_in) {
        tokens.expires_at = Date.now() + (tokens.expires_in * 1000);
    }

    await saveTokens(tokens);

    // Limpar estado pendente
    pendingState = null;
    pendingCodeVerifier = null;

    logger.info('OAuth: tokens obtidos com sucesso');
    return tokens;
}

/**
 * Usa o refresh token para obter um novo access token.
 * @returns {Promise<object>} Novos tokens
 */
async function refreshAccessToken() {
    const tokens = await loadTokens();
    if (!tokens?.refresh_token) {
        throw new Error('Sem refresh token disponível. Refaça a autorização OAuth.');
    }

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
    });

    if (CLIENT_SECRET) {
        body.append('client_secret', CLIENT_SECRET);
    }

    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    if (!response.ok) {
        const errText = await response.text();
        // Invalidar tokens em cache
        tokenCache = null;
        throw new Error(`Falha no refresh (${response.status}): ${errText}`);
    }

    const newTokens = await response.json();

    // Preservar refresh_token se não veio um novo
    if (!newTokens.refresh_token && tokens.refresh_token) {
        newTokens.refresh_token = tokens.refresh_token;
    }

    if (newTokens.expires_in) {
        newTokens.expires_at = Date.now() + (newTokens.expires_in * 1000);
    }

    await saveTokens(newTokens);
    logger.info('OAuth: token refreshed');
    return newTokens;
}

// --- URL parsing ---

/**
 * Extrai o código OAuth de uma URL de callback colada pelo usuário.
 * @param {string} text - Texto da mensagem (pode conter a URL)
 * @returns {{ code: string, state: string } | null}
 */
function extractCodeFromUrl(text) {
    try {
        // Encontrar URL no texto
        const urlMatch = text.match(/https?:\/\/\S+/);
        if (!urlMatch) return null;

        const url = new URL(urlMatch[0]);
        const redirectUrl = new URL(REDIRECT_URI);

        // Verificar se é a mesma host + path do redirect URI
        if (url.hostname !== redirectUrl.hostname || url.pathname !== redirectUrl.pathname) {
            return null;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (!code) return null;

        return { code, state };
    } catch {
        return null;
    }
}

module.exports = {
    isConfigured,
    loadTokens,
    hasValidTokens,
    getAccessToken,
    clearTokens,
    generateAuthUrl,
    exchangeCode,
    refreshAccessToken,
    extractCodeFromUrl,
};
