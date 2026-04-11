import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { accessControl } from '../src/accessControl.js';
import { tryHandleLocalAction } from '../src/localActions.js';

function pickAdminSenderNumber() {
  return config.adminSenderNumbers[0] || config.fullSenderNumbers[0] || config.authorizedSenderNumbers[0] || '21972163738';
}

function buildMockContext() {
  const senderNumber = pickAdminSenderNumber();
  const senderJid = `${senderNumber}@c.us`;
  const botJid = '5511999999999@c.us';
  const groupId = '120363425030367057@g.us';
  const participants = [
    { id: { _serialized: botJid }, isAdmin: true },
    { id: { _serialized: senderJid }, isAdmin: true },
    { id: { _serialized: '5521999990000@c.us' }, isAdmin: false }
  ];

  const evaluateCalls = [];
  const chat = {
    id: { _serialized: groupId },
    isGroup: true,
    name: 'Grupo Teste',
    description: 'Descricao inicial',
    groupMetadata: {
      subject: 'Grupo Teste',
      desc: 'Descricao inicial',
      announce: false,
      restrict: false,
      memberAddMode: 'all_member_add',
      ephemeralDuration: 0,
      participants
    },
    participants,
    client: {
      pupPage: {
        evaluate: async (_pageFn, targetChatId, durationSeconds) => {
          evaluateCalls.push({ targetChatId, durationSeconds });
          assert.equal(targetChatId, groupId);
          return {
            ok: true,
            durationSeconds
          };
        }
      }
    }
  };

  const client = {
    info: {
      wid: {
        _serialized: botJid
      }
    },
    getChatById: async (targetChatId) => {
      assert.equal(targetChatId, groupId);
      return chat;
    }
  };

  return {
    chat,
    evaluateCalls,
    context: {
      senderNumber,
      senderJid,
      groupId,
      client
    }
  };
}

async function main() {
  const originalIsAdmin = accessControl.isAdmin.bind(accessControl);
  accessControl.isAdmin = () => true;

  const { chat, evaluateCalls, context } = buildMockContext();

  try {
    const activate24h = await tryHandleLocalAction('@ ativar mensagens temporarias 24hrs', context);
    assert.equal(activate24h?.handled, true);
    assert.match(activate24h?.response || '', /24 horas/i);
    assert.equal(chat.groupMetadata.ephemeralDuration, 86400);
    assert.deepEqual(evaluateCalls[0], {
      targetChatId: context.groupId,
      durationSeconds: 86400
    });

    const status24h = await tryHandleLocalAction('status das mensagens temporarias', context);
    assert.equal(status24h?.handled, true);
    assert.match(status24h?.response || '', /24 horas/i);

    const activate7d = await tryHandleLocalAction('ativar mensagens temporarias 7 dias', context);
    assert.equal(activate7d?.handled, true);
    assert.match(activate7d?.response || '', /7 dias/i);
    assert.equal(chat.groupMetadata.ephemeralDuration, 604800);

    const activate90d = await tryHandleLocalAction('ativar mensagens temporarias 90 dias', context);
    assert.equal(activate90d?.handled, true);
    assert.match(activate90d?.response || '', /90 dias/i);
    assert.equal(chat.groupMetadata.ephemeralDuration, 7776000);

    const missingDuration = await tryHandleLocalAction('ativar mensagens temporarias', context);
    assert.equal(missingDuration?.handled, true);
    assert.match(missingDuration?.response || '', /24 horas, 7 dias ou 90 dias/i);

    const deactivate = await tryHandleLocalAction('desativar mensagens temporarias', context);
    assert.equal(deactivate?.handled, true);
    assert.match(deactivate?.response || '', /desativadas/i);
    assert.equal(chat.groupMetadata.ephemeralDuration, 0);
    assert.deepEqual(evaluateCalls.at(-1), {
      targetChatId: context.groupId,
      durationSeconds: 0
    });

    const statusOff = await tryHandleLocalAction('ver mensagens temporarias', context);
    assert.equal(statusOff?.handled, true);
    assert.match(statusOff?.response || '', /desativadas/i);
  } finally {
    accessControl.isAdmin = originalIsAdmin;
  }

  console.log('Validacao local de mensagens temporarias: OK');
}

await main();
