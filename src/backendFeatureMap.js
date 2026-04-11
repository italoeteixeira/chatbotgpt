/**
 * Mapeamento interno do projeto (backend only).
 *
 * IMPORTANTE:
 * - Sempre que uma nova funcao/comando/endpoint for criada, atualize este arquivo.
 * - Mapeamento atualizado = maior cobertura das configuracoes dinamicas funcionando.
 * - Este conteudo nao deve ser exposto no WhatsApp nem no HTML do painel.
 */

export const BACKEND_FEATURE_MAP_VERSION = '2026-04-10';

export const BACKEND_FEATURE_MAP = Object.freeze({
  ai: Object.freeze([
    'aiProvider',
    'codexModel',
    'codexFallbackModel',
    'codexReasoningEffort',
    'codexTimeoutMs',
    'copilotModel',
    'copilotFullModel',
    'copilotFallbackModel',
    'copilotTimeoutMs',
    'copilotFullTimeoutMs'
  ]),
  respostas: Object.freeze([
    'requireMention',
    'showThinkingMessage',
    'thinkingMessageText',
    'maxInputChars',
    'maxOutputChars',
    'fallbackMessage',
    'systemPrompt'
  ]),
  terminal: Object.freeze(['enableTerminalExec', 'terminalAllowlist']),
  midia: Object.freeze([
    'mediaIngestEnabled',
    'mediaRootDir',
    'mediaMaxBytes',
    'mediaRetentionDays',
    'mediaAllowedMimePrefixes'
  ]),
  relay_e_full: Object.freeze(['relaySenderName', 'fullAutoDevTimeoutMs']),
  silencioso: Object.freeze(['silentMode']),
  permissoes: Object.freeze([
    'access-control/authorized',
    'access-control/admins',
    'access-control/full',
    'response-routing/groups',
    'response-routing/private'
  ]),
  grupo: Object.freeze([
    'group/control/set_subject',
    'group/control/set_description',
    'group/control/set_messages_admins_only',
    'group/control/set_info_admins_only',
    'group/control/set_add_members_admins_only',
    'group/control/get_invite_link',
    'group/control/refresh_invite_link'
  ])
});

export function getBackendFeatureMapStats() {
  const categories = Object.keys(BACKEND_FEATURE_MAP);
  const totalEntries = categories.reduce((sum, category) => {
    const items = BACKEND_FEATURE_MAP[category];
    return sum + (Array.isArray(items) ? items.length : 0);
  }, 0);

  return {
    version: BACKEND_FEATURE_MAP_VERSION,
    categories: categories.length,
    entries: totalEntries
  };
}
