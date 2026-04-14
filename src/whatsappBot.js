import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from './config.js';
import { logger } from './logger.js';
import { accessControl } from './accessControl.js';
import { settingsStore } from './settingsStore.js';

const { Client, LocalAuth } = pkg;

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function foldText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractSerializedWid(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value._serialized === 'string') return value._serialized;
    if (typeof value.user === 'string' && typeof value.server === 'string') return `${value.user}@${value.server}`;
    if (value.id) return extractSerializedWid(value.id);
  }
  return '';
}

function numbersAreEquivalent(a, b) {
  const left = normalizePhoneNumber(a);
  const right = normalizePhoneNumber(b);
  if (!left || !right) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

function isGroupParticipantAdmin(participant) {
  return Boolean(participant?.isAdmin || participant?.isSuperAdmin || participant?.type === 'admin' || participant?.type === 'superadmin');
}

function findParticipantByWid(participants, targetWid) {
  if (!targetWid || !Array.isArray(participants)) return null;
  const targetDigits = normalizePhoneNumber(String(targetWid).split('@')[0]);

  return participants.find((participant) => {
    const pid = extractSerializedWid(participant?.id || participant);
    if (!pid) return false;
    if (pid === targetWid) return true;
    const participantDigits = normalizePhoneNumber(String(pid).split('@')[0]);
    if (!targetDigits || !participantDigits) return false;
    return numbersAreEquivalent(participantDigits, targetDigits);
  });
}

function getSenderCandidates(message) {
  const candidates = [
    message.author,
    message.id?.participant,
    message._data?.author,
    message._data?.participant
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  return Array.from(new Set(candidates));
}

function isBotMentioned(message, botWid) {
  const mentionedIds = Array.isArray(message.mentionedIds) ? message.mentionedIds : [];
  if (!mentionedIds.length || !botWid) return false;

  const botDigits = normalizePhoneNumber(String(botWid).split('@')[0]);

  return mentionedIds.some((item) => {
    const serialized =
      typeof item === 'string'
        ? item
        : typeof item?._serialized === 'string'
          ? item._serialized
          : typeof item?.user === 'string' && typeof item?.server === 'string'
            ? `${item.user}@${item.server}`
            : String(item || '');

    if (serialized === botWid) return true;
    const candidateDigits = normalizePhoneNumber(serialized.split('@')[0]);
    return botDigits && candidateDigits && candidateDigits === botDigits;
  });
}

function isBotMentionedInBody(messageBody, botWid) {
  const botNumber = normalizePhoneNumber(String(botWid || '').split('@')[0]);
  const bodyText = String(messageBody || '');
  const bodyDigits = normalizePhoneNumber(bodyText);

  if (botNumber && bodyDigits.includes(botNumber)) {
    return true;
  }

  // Fallback: alguns clientes nao expõem mentionedIds corretamente.
  // Para evitar falso positivo em transcricoes/historico, so aceita '@' no inicio da mensagem.
  return /^@\s*\S*/.test(bodyText.trimStart());
}

async function isReplyingToBot(message, botWid) {
  if (!message?.hasQuotedMsg || typeof message.getQuotedMessage !== 'function') {
    return false;
  }

  try {
    const quoted = await message.getQuotedMessage();
    if (!quoted) return false;

    if (quoted.fromMe) return true;

    const quotedCandidates = [
      quoted.author,
      quoted.from,
      quoted.id?.participant,
      quoted.id?._serialized,
      quoted._data?.author,
      quoted._data?.from
    ]
      .map((item) => String(item || '').trim())
      .filter(Boolean);

    const bot = String(botWid || '').trim();
    if (!bot) return false;
    return quotedCandidates.includes(bot);
  } catch {
    return false;
  }
}

function isOperationalHealthCheck(text) {
  const folded = foldText(text).replace(/[!?.,;:]+$/g, '').trim();
  if (!folded) return false;

  return (
    /^(status|status do bot|status do servidor|status do servico)$/.test(folded) ||
    /^(esta|ta) tudo ok(?: ai)?$/.test(folded) ||
    /^(como esta|como ta) (?:o )?(bot|servidor|servico)$/.test(folded) ||
    /^(o )?(bot|servidor|servico) (?:esta|ta) (?:ok|online|ativo|rodando)$/.test(folded)
  );
}

export function canSenderInteract(senderNumber) {
  return accessControl.isAuthorized(senderNumber);
}

export function canSenderPrivateInteract(senderNumber) {
  return accessControl.isPrivateAllowed(senderNumber);
}

function pickAuthorizedSender(candidates) {
  for (const senderJid of candidates) {
    const senderNumber = normalizePhoneNumber(senderJid.split('@')[0]);
    if (!senderNumber) continue;
    if (canSenderInteract(senderNumber)) {
      return { senderJid, senderNumber };
    }
  }
  return null;
}

function pickPrivateSender(candidates) {
  for (const senderJid of candidates) {
    const senderNumber = normalizePhoneNumber(senderJid.split('@')[0]);
    if (!senderNumber) continue;
    if (canSenderPrivateInteract(senderNumber)) {
      return { senderJid, senderNumber };
    }
  }
  return null;
}

async function resolveSenderCandidates(message) {
  const candidates = new Set(getSenderCandidates(message));

  try {
    const contact = await message.getContact();
    const contactId = contact?.id?._serialized;
    if (contactId) candidates.add(contactId);

    let contactNumber = normalizePhoneNumber(contact?.number);
    if (!contactNumber && typeof contact?.getFormattedNumber === 'function') {
      try {
        const formatted = await contact.getFormattedNumber();
        contactNumber = normalizePhoneNumber(formatted);
      } catch {
        // Ignora falha de leitura do numero formatado.
      }
    }

    if (contactNumber) {
      candidates.add(`${contactNumber}@c.us`);
      candidates.add(`${contactNumber}@s.whatsapp.net`);
    }
  } catch {
    // Em alguns cenarios o contato pode nao estar disponivel; seguimos com os candidatos originais.
  }

  return Array.from(candidates);
}

export function createWhatsappClient(handlers) {
  let botWid = '';

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: config.sessionName,
      dataPath: config.sessionDir
    }),
    puppeteer: {
      headless: config.puppeteerHeadless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  client.on('qr', async (qr) => {
    logger.info('QR Code atualizado. Escaneie pelo painel web.');
    try {
      const qrDataUrl = await QRCode.toDataURL(qr);
      handlers.onQr?.(qrDataUrl);
    } catch (error) {
      logger.error('Falha ao converter QR Code para imagem', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  client.on('ready', () => {
    botWid = client.info?.wid?._serialized || '';
    logger.info('WhatsApp conectado e pronto.');
    handlers.onReady?.();
  });

  client.on('authenticated', () => {
    logger.info('Sessao autenticada com sucesso.');
    handlers.onAuthenticated?.();
  });

  client.on('auth_failure', (message) => {
    logger.error('Falha de autenticacao do WhatsApp', { message });
    handlers.onAuthFailure?.(message);
  });

  client.on('change_state', (state) => {
    logger.info('Estado do WhatsApp alterado', { state });
    handlers.onStateChange?.(state);
  });

  client.on('disconnected', (reason) => {
    logger.warn('WhatsApp desconectado', { reason });
    handlers.onDisconnected?.(reason);
  });

  client.on('message', async (message) => {
    const from = message.from || '';
    const isGroup = from.endsWith('@g.us');
    const authorizedGroupJid = handlers.getAuthorizedGroupJid?.() || config.groupJid;
    const providedResponseGroups = handlers.getResponseGroupJids?.();
    const declaredResponseGroups = Array.isArray(providedResponseGroups) ? providedResponseGroups : [];
    const responseGroups = Array.from(
      new Set(
        [authorizedGroupJid, ...(Array.isArray(declaredResponseGroups) ? declaredResponseGroups : [])]
          .map((item) => String(item || '').trim())
          .filter((item) => item.endsWith('@g.us'))
      )
    );

    if (message.fromMe) {
      logger.debug('Mensagem do proprio bot ignorada');
      return;
    }

    if (!isGroup) {
      const senderCandidates = await resolveSenderCandidates(message);
      const privateSender = pickPrivateSender(senderCandidates);

      if (!privateSender) {
        logger.debug('Mensagem privada ignorada: remetente sem permissao de privado', { from, senderCandidates });
        if (typeof handlers.onUnauthorizedMessage === 'function') {
          const fallbackJid = senderCandidates[0] || from;
          const fallbackNumber = normalizePhoneNumber(fallbackJid.split('@')[0]);
          try {
            await handlers.onUnauthorizedMessage(message, {
              senderJid: fallbackJid,
              senderNumber: fallbackNumber,
              chatId: from,
              chatType: 'private'
            });
          } catch {}
        }
        return;
      }

      const { senderJid, senderNumber } = privateSender;
      const privateContext = {
        senderJid,
        senderNumber,
        mentionedIds: Array.isArray(message.mentionedIds) ? message.mentionedIds : [],
        authorizedGroupJid,
        groupId: from,
        chatType: 'private',
        authorizationMode: 'private',
        isGroupAdminSender: false
      };

      if (message.type !== 'chat') {
        logger.debug('Mensagem privada nao textual ignorada', { type: message.type, from, senderJid });
        return;
      }

      if (!message.body || !message.body.trim()) {
        logger.debug('Mensagem privada vazia ignorada', { from, senderJid });
        return;
      }

      handlers.onEligibleMessage?.(message, privateContext);
      return;
    }

    if (!responseGroups.length) {
      logger.debug('Mensagem de grupo ignorada: nenhum grupo de resposta ativo', { from });
      return;
    }

    if (!responseGroups.includes(from)) {
      if (typeof handlers.onForeignGroupMessage === 'function') {
        const senderCandidates = await resolveSenderCandidates(message);
        const primarySenderJid = senderCandidates[0] || '';
        const primarySenderNumber = normalizePhoneNumber(primarySenderJid.split('@')[0]);
        const context = {
          senderJid: primarySenderJid || null,
          senderNumber: primarySenderNumber || null,
          mentionedIds: Array.isArray(message.mentionedIds) ? message.mentionedIds : [],
          authorizedGroupJid,
          groupId: from
        };

        try {
          await handlers.onForeignGroupMessage(message, context);
        } catch (error) {
          logger.warn('Falha ao observar mensagem de grupo externo', {
            from,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      logger.debug('Mensagem de outro grupo ignorada', { from, responseGroupsCount: responseGroups.length });
      return;
    }

    const senderCandidates = await resolveSenderCandidates(message);
    const primarySenderJid = senderCandidates[0] || '';
    const primarySenderNumber = normalizePhoneNumber(primarySenderJid.split('@')[0]);
    const context = {
      senderJid: primarySenderJid || null,
      senderNumber: primarySenderNumber || null,
      mentionedIds: Array.isArray(message.mentionedIds) ? message.mentionedIds : [],
      authorizedGroupJid,
      groupId: from,
      chatType: 'group'
    };

    let authorizedSender = pickAuthorizedSender(senderCandidates);
    const authorizationMode = 'authorized';

    if (!authorizedSender) {
      logger.debug('Mensagem bloqueada: remetente nao autorizado', {
        senderCandidates
      });
      if (typeof handlers.onUnauthorizedMessage === 'function' && message.body?.trim()) {
        const fallbackJid = senderCandidates[0] || '';
        const fallbackNumber = normalizePhoneNumber(fallbackJid.split('@')[0]);
        try {
          await handlers.onUnauthorizedMessage(message, {
            senderJid: fallbackJid,
            senderNumber: fallbackNumber,
            chatId: from,
            chatType: 'group'
          });
        } catch {}
      }
      try {
        await message.delete(true);
        logger.info('Mensagem de remetente bloqueado apagada automaticamente', {
          from,
          senderCandidates
        });
      } catch (error) {
        logger.warn('Falha ao apagar mensagem de remetente bloqueado', {
          error: error instanceof Error ? error.message : String(error),
          from,
          senderCandidates
        });
      }
      return;
    }

    const { senderJid, senderNumber } = authorizedSender;
    const eligibleContext = {
      ...context,
      senderJid,
      senderNumber,
      authorizationMode,
      isGroupAdminSender: false
    };

    // Normaliza body: imagens/vídeos com legenda armazenam o caption em _data.caption
    if (message.hasMedia && !message.body?.trim() && message._data?.caption?.trim()) {
      message.body = message._data.caption;
    }

    if (message.hasMedia) {
      handlers.onGroupMedia?.(message, eligibleContext);
    }

    if (message.type === 'chat' && message.body && message.body.trim()) {
      handlers.onGroupMessage?.(message, eligibleContext);
    }

    // Mídia com legenda: body contém o caption — tratar como mensagem elegível
    // Documentos (type='document') nunca são tratados como elegíveis: o body é o filename,
    // não uma legenda digitada pelo usuário. O handler de mídia já cuida deles.
    const hasCaption =
      message.hasMedia &&
      message.type !== 'document' &&
      message.body &&
      message.body.trim();

    if (message.type !== 'chat' && !hasCaption) {
      logger.debug('Mensagem nao textual tratada somente para ingestao', { type: message.type });
      return;
    }

    if (!message.body || !message.body.trim()) {
      logger.debug('Mensagem vazia ignorada');
      return;
    }

    await settingsStore.ensureReady();
    const runtime = settingsStore.get();

    if (runtime.requireMention) {
      const currentBotWid = botWid || client.info?.wid?._serialized || '';
      const mentionedByIds = isBotMentioned(message, currentBotWid);
      const mentionedByBody = isBotMentionedInBody(message.body, currentBotWid);
      const repliedToBot = await isReplyingToBot(message, currentBotWid);
      const mentionBypassForStatus =
        (accessControl.isAdmin(senderNumber) || accessControl.isFull(senderNumber)) &&
        isOperationalHealthCheck(message.body);

      if (!currentBotWid || (!mentionedByIds && !mentionedByBody && !repliedToBot && !mentionBypassForStatus)) {
        logger.debug('Mensagem ignorada: bot nao foi mencionado', {
          senderJid,
          mentionedByIds,
          mentionedByBody,
          repliedToBot,
          mentionBypassForStatus
        });
        return;
      }
    }

    // A ACL `authorized` define quem pode conversar com o bot.
    // Regras de admin/FULL continuam aplicadas dentro dos comandos locais.
    handlers.onEligibleMessage?.(message, eligibleContext);
    });

  return client;
}
