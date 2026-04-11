import { config } from './config.js';

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(text, maxChars) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

// Busca real via DuckDuckGo HTML — retorna resultados reais da web (e-commerce, notícias, sites)
async function searchDuckDuckGoHTML(query, limit) {
  const body = new URLSearchParams({ q: query, b: '' }).toString();
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    },
    body
  });

  if (!response.ok) return [];

  const html = await response.text();
  const results = [];

  // Extrai pares título+url e snippet de cada resultado
  const titleMatches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*href="[^"]+"[^>]*>([\s\S]*?)<\/a>/gi)];

  for (let i = 0; i < titleMatches.length && results.length < limit; i++) {
    const url = titleMatches[i][1];
    const title = stripHtml(titleMatches[i][2]);
    const snippet = snippetMatches[i] ? stripHtml(snippetMatches[i][1]) : '';
    if (title && url && url.startsWith('http')) {
      results.push({ title, snippet, url });
    }
  }

  return results;
}

// Fallback: Wikipedia para consultas factuais/enciclopédicas
async function searchWikipedia(query, limit) {
  const url = `https://pt.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];

  const data = await response.json();
  const items = Array.isArray(data?.query?.search) ? data.query.search : [];

  return items.map((item) => {
    const title = String(item?.title || '').trim();
    const snippet = stripHtml(item?.snippet || '');
    const pageUrl = title ? `https://pt.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}` : '';
    return { title, snippet, url: pageUrl };
  });
}

export async function runWebSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    throw new Error('Consulta vazia.');
  }

  if (!config.searchEnabled) {
    throw new Error('Busca web desativada (SEARCH_ENABLED=false).');
  }

  const max = Math.max(1, config.searchMaxResults);

  // Prioriza DuckDuckGo HTML (resultados reais da web)
  let results = await searchDuckDuckGoHTML(query, max);

  // Fallback para Wikipedia se DDG não retornar nada
  if (!results.length) {
    results = await searchWikipedia(query, max);
  }

  if (!results.length) {
    return {
      query,
      summary: 'Nao encontrei resultados relevantes agora.',
      results: []
    };
  }

  const lines = results.map((item, index) => {
    const title = item.title || `Resultado ${index + 1}`;
    const snippet = item.snippet ? ` - ${item.snippet}` : '';
    const url = item.url ? ` (${item.url})` : '';
    return `${index + 1}. ${title}${snippet}${url}`;
  });

  const summary = clampText(lines.join('\n'), 2500);

  return {
    query,
    summary,
    results
  };
}
