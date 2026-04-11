import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'chatbot-single-agenda-'));
process.chdir(tempRoot);

process.env.AGENDA_FILE = join(tempRoot, 'data', 'agenda.json');
process.env.NOTES_FILE = join(tempRoot, 'data', 'textos.json');
process.env.SCHEDULED_MESSAGES_FILE = join(tempRoot, 'data', 'scheduled-messages.json');
process.env.REMINDERS_FILE = join(tempRoot, 'data', 'reminders.json');
process.env.BOT_DATABASE_FILE = join(tempRoot, 'data', 'bot.sqlite');
process.env.SETTINGS_FILE = join(tempRoot, 'data', 'bot-settings.json');
process.env.SETTINGS_AUDIT_FILE = join(tempRoot, 'data', 'bot-settings-audit.jsonl');
process.env.MEDIA_INDEX_FILE = join(tempRoot, 'data', 'media-index.json');
process.env.MEDIA_ROOT_DIR = join(tempRoot, 'data', 'midias');
process.env.CONVERSATIONS_DIR = join(tempRoot, 'data', 'conversas');
process.env.SAVE_CONVERSATIONS = 'false';
process.env.AGENDA_AI_ENABLED = 'false';

const { tryHandleLocalAction } = await import('../src/localActions.js');
const { botDatabase } = await import('../src/botDatabase.js');

const context = {
  groupId: '120363425030367057@g.us',
  senderNumber: '5521972163738',
  senderJid: '5521972163738@c.us'
};

async function ask(text) {
  const result = await tryHandleLocalAction(text, context);
  assert.equal(result?.handled, true, `Comando nao tratado: ${text}`);
  return String(result.response || '');
}

await botDatabase.createNamedAgenda('ITALO', {
  groupId: context.groupId
});
await botDatabase.addItem(botDatabase.buildNamedAgendaCollection('ITALO'), 'consulta antiga amanha 10h', {
  groupId: context.groupId
});

let response = await ask('agenda');
assert.match(response, /Aqui esta sua agenda por assunto/i);
assert.match(response, /consulta antiga amanha 10h/i);

let migratedItems = await botDatabase.listItems('agenda', 20, {
  groupId: context.groupId
});
assert.equal(migratedItems.length, 1);

let legacyItems = await botDatabase.listItems(botDatabase.buildNamedAgendaCollection('ITALO'), 20, {
  groupId: context.groupId
});
assert.equal(legacyItems.length, 0);

response = await ask('agendas');
assert.match(response, /agenda unica/i);
assert.doesNotMatch(response, /ITALO/i);
assert.doesNotMatch(response, /FERNANDA/i);

response = await ask('agenda FERNANDA: reuniao com contador sexta 9h');
assert.match(response, /Anotei na sua agenda:/i);
assert.match(response, /reuniao com contador sexta 9h/i);
assert.doesNotMatch(response, /agenda FERNANDA/i);

response = await ask('agenda: pagar conta de luz segunda 8h');
assert.match(response, /Anotei na sua agenda:/i);
assert.match(response, /pagar conta de luz segunda 8h/i);

response = await ask('listar agenda com numeros');
assert.match(response, /Sua agenda com numeros/i);
assert.match(response, /1\./);
assert.match(response, /2\./);
assert.match(response, /3\./);

response = await ask('editar agenda 2: reuniao com contador sexta 11h');
assert.match(response, /atualizado para/i);
assert.match(response, /reuniao com contador sexta 11h/i);

response = await ask('apagar agenda 1');
assert.match(response, /Item 1 removido da sua agenda/i);
assert.match(response, /consulta antiga amanha 10h/i);

response = await ask('criar agenda JOAO');
assert.match(response, /agenda unica/i);

response = await ask('quais agendas existem');
assert.match(response, /agenda unica/i);

response = await ask('agenda');
assert.match(response, /Aqui esta sua agenda por assunto/i);
assert.doesNotMatch(response, /consulta antiga amanha 10h/i);
assert.match(response, /reuniao com contador sexta 11h/i);
assert.match(response, /pagar conta de luz segunda 8h/i);

response = await ask('apagar agenda');
assert.match(response, /Limpei sua agenda \(2 itens removidos\)/i);

response = await ask('agenda');
assert.match(response, /Sua agenda esta vazia no momento/i);
assert.doesNotMatch(response, /reuniao com contador sexta 11h/i);
assert.doesNotMatch(response, /pagar conta de luz segunda 8h/i);

console.log('Teste de agenda unica por grupo: OK');
