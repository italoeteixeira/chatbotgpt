/**
 * Rastreador de uso do Copilot CLI — métricas por sessão.
 * Tokens estimados com base em contagem de caracteres (~4 chars/token).
 */

const CHARS_PER_TOKEN = 4;

const _stats = {
  sessionStart: Date.now(),
  totalRequests: 0,
  primaryOk: 0,
  fallbackOk: 0,
  errors: 0,
  timeouts: 0,
  inputChars: 0,
  outputChars: 0,
  byModel: {},
  lastRequestAt: null,
  lastModel: null
};

/**
 * Registra uma requisição ao Copilot.
 * @param {{ model?: string, inputChars?: number, outputChars?: number, stage?: string, success?: boolean, timedOut?: boolean }} opts
 */
export function recordCopilotRequest({ model, inputChars, outputChars, stage, success, timedOut } = {}) {
  _stats.totalRequests++;
  _stats.inputChars += inputChars || 0;
  _stats.outputChars += outputChars || 0;
  _stats.lastRequestAt = Date.now();
  _stats.lastModel = model || 'default';

  if (timedOut) {
    _stats.timeouts++;
  } else if (success) {
    if (stage === 'fallback') _stats.fallbackOk++;
    else _stats.primaryOk++;
  } else {
    _stats.errors++;
  }

  const m = model || 'default';
  if (!_stats.byModel[m]) {
    _stats.byModel[m] = { requests: 0, inputChars: 0, outputChars: 0 };
  }
  _stats.byModel[m].requests++;
  _stats.byModel[m].inputChars += inputChars || 0;
  _stats.byModel[m].outputChars += outputChars || 0;
}

/**
 * Retorna estatísticas brutas de uso.
 */
export function getCopilotUsageStats() {
  const estInputTokens = Math.round(_stats.inputChars / CHARS_PER_TOKEN);
  const estOutputTokens = Math.round(_stats.outputChars / CHARS_PER_TOKEN);
  const estTotalTokens = estInputTokens + estOutputTokens;
  const sessionAgeMs = Date.now() - _stats.sessionStart;
  const sessionMin = Math.floor(sessionAgeMs / 60000);

  const byModel = Object.entries(_stats.byModel).map(([name, s]) => ({
    name,
    requests: s.requests,
    estTokens: Math.round((s.inputChars + s.outputChars) / CHARS_PER_TOKEN)
  }));

  return {
    sessionMin,
    totalRequests: _stats.totalRequests,
    primaryOk: _stats.primaryOk,
    fallbackOk: _stats.fallbackOk,
    errors: _stats.errors,
    timeouts: _stats.timeouts,
    estInputTokens,
    estOutputTokens,
    estTotalTokens,
    byModel,
    lastRequestAt: _stats.lastRequestAt,
    lastModel: _stats.lastModel
  };
}

/**
 * Formata relatório de uso legível para envio no WhatsApp.
 */
export function formatCopilotUsageReport() {
  const s = getCopilotUsageStats();

  const lines = [
    `📊 *Uso do Copilot — Sessão atual*`,
    ``,
    `🔢 Requisições: *${s.totalRequests}* total`,
    `   ✅ Primário OK: ${s.primaryOk}`
  ];

  if (s.fallbackOk > 0) lines.push(`   ⚠️ Fallback OK: ${s.fallbackOk}`);
  if (s.errors > 0)     lines.push(`   ❌ Erros: ${s.errors}`);
  if (s.timeouts > 0)   lines.push(`   ⏱ Timeouts: ${s.timeouts}`);

  lines.push(
    ``,
    `📝 *Tokens estimados* (~4 chars/token):`,
    `   Entrada:  ~${s.estInputTokens.toLocaleString('pt-BR')} tokens`,
    `   Saída:    ~${s.estOutputTokens.toLocaleString('pt-BR')} tokens`,
    `   *Total:   ~${s.estTotalTokens.toLocaleString('pt-BR')} tokens*`
  );

  if (s.byModel.length > 0) {
    lines.push(``, `🤖 Por modelo:`);
    for (const m of s.byModel) {
      lines.push(`   • ${m.name}: ${m.requests} req · ~${m.estTokens.toLocaleString('pt-BR')} tokens`);
    }
  }

  lines.push(
    ``,
    `⏰ Sessão ativa há: *${s.sessionMin} min*`,
    s.lastRequestAt
      ? `   Última req.: ${new Date(s.lastRequestAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
      : `   Nenhuma requisição ainda.`,
    ``,
    `ℹ️ _Nota: o GitHub Copilot não expõe cotas de tokens via API pública. Estes valores são estimativas locais da sessão em execução._`
  );

  return lines.join('\n');
}

/**
 * Resumo compacto para uso no heartbeat.
 */
export function getCopilotUsageSummary() {
  const s = getCopilotUsageStats();
  if (s.totalRequests === 0) return 'Sem requisições nesta sessão';
  return `${s.totalRequests} req · ~${s.estTotalTokens.toLocaleString('pt-BR')} tokens est.`;
}
