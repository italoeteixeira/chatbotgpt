import { config } from './config.js';

const PANEL_URL_CACHE_TTL_MS = 10 * 60 * 1000;
const PUBLIC_IP_ENDPOINTS = Object.freeze([
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com'
]);

let cachedPanelInfo = null;
let cachedPanelInfoAt = 0;
let pendingPanelInfoPromise = null;

function normalizeIpv4(value) {
  const trimmed = String(value || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) return '';

  const parts = trimmed.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return '';
  return parts.join('.');
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function joinPanelUrl(baseUrl, pathname = '') {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = String(pathname || '').trim().replace(/^\/+/, '');
  if (!normalizedPath) return normalizedBaseUrl;
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

function buildLocalPanelBaseUrl() {
  return `http://localhost:${config.port}`;
}

function buildPanelBaseUrlFromIp(ip) {
  return `http://${ip}:${config.port}`;
}

function extractIpv4FromBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    return normalizeIpv4(parsed.hostname);
  } catch {
    return '';
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'whatsapp-codex-bridge/1.0'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function detectPublicIpv4() {
  for (const endpoint of PUBLIC_IP_ENDPOINTS) {
    try {
      const detectedIp = normalizeIpv4(await fetchTextWithTimeout(endpoint, 5000));
      if (detectedIp) return detectedIp;
    } catch {
      // tenta o proximo endpoint.
    }
  }

  return '';
}

function buildPanelInfo(baseUrl, source) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || buildLocalPanelBaseUrl();
  return {
    baseUrl: normalizedBaseUrl,
    menuUrl: joinPanelUrl(normalizedBaseUrl, 'bot-config-menu.html'),
    publicIp: extractIpv4FromBaseUrl(normalizedBaseUrl),
    source
  };
}

function getConfiguredPanelInfo() {
  const configuredBaseUrl = normalizeBaseUrl(config.panelPublicBaseUrl);
  if (configuredBaseUrl) {
    return buildPanelInfo(configuredBaseUrl, 'config_base_url');
  }

  const configuredPublicIp = normalizeIpv4(config.panelPublicIp);
  if (configuredPublicIp) {
    return buildPanelInfo(buildPanelBaseUrlFromIp(configuredPublicIp), 'config_public_ip');
  }

  return null;
}

export function buildLocalPanelUrl(pathname = '') {
  return joinPanelUrl(buildLocalPanelBaseUrl(), pathname);
}

export async function resolvePanelAccessInfo({ forceRefresh = false } = {}) {
  const configured = getConfiguredPanelInfo();
  if (configured) return configured;

  const cacheIsFresh = cachedPanelInfo && Date.now() - cachedPanelInfoAt < PANEL_URL_CACHE_TTL_MS;
  if (!forceRefresh && cacheIsFresh) return cachedPanelInfo;

  if (!forceRefresh && pendingPanelInfoPromise) {
    return pendingPanelInfoPromise;
  }

  pendingPanelInfoPromise = (async () => {
    const detectedPublicIp = await detectPublicIpv4();
    const resolvedInfo = detectedPublicIp
      ? buildPanelInfo(buildPanelBaseUrlFromIp(detectedPublicIp), 'detected_public_ip')
      : buildPanelInfo(buildLocalPanelBaseUrl(), 'local_fallback');

    cachedPanelInfo = resolvedInfo;
    cachedPanelInfoAt = Date.now();
    return resolvedInfo;
  })();

  try {
    return await pendingPanelInfoPromise;
  } finally {
    pendingPanelInfoPromise = null;
  }
}

export async function resolvePanelUrl(pathname = '', options = {}) {
  const info = await resolvePanelAccessInfo(options);
  return pathname ? joinPanelUrl(info.baseUrl, pathname) : info.baseUrl;
}
