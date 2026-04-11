import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

function compactSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function hasMeaningfulText(text) {
  return /[\p{L}\p{N}]/u.test(String(text || ''));
}

function foldText(text) {
  return compactSpaces(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeNamedAgendaLabel(name) {
  const normalized = compactSpaces(String(name || '').replace(/^["'`]+|["'`]+$/g, '').replace(/[.,;:!?]+$/g, ''));
  if (!normalized || !hasMeaningfulText(normalized)) return '';
  return normalized;
}

function buildNamedAgendaKey(name) {
  const folded = foldText(name);
  if (!folded) return '';

  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || '';
}

function normalizeNamedAgendaEntries(input) {
  if (!Array.isArray(input)) return [];

  const seenKeys = new Set();

  return input
    .map((entry) => {
      if (typeof entry === 'string') {
        const name = normalizeNamedAgendaLabel(entry);
        const key = buildNamedAgendaKey(name);
        if (!name || !key) return null;
        const now = new Date().toISOString();
        return {
          key,
          name,
          createdAt: now,
          updatedAt: now
        };
      }

      if (!entry || typeof entry !== 'object') return null;

      const name = normalizeNamedAgendaLabel(entry.name || entry.label || entry.key);
      const key = buildNamedAgendaKey(entry.key || name);
      if (!name || !key) return null;

      const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString();
      const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : createdAt;

      return {
        key,
        name,
        createdAt,
        updatedAt
      };
    })
    .filter((entry) => {
      if (!entry || seenKeys.has(entry.key)) return false;
      seenKeys.add(entry.key);
      return true;
    });
}

function parseNamedAgendaEntries(value) {
  const normalized = compactSpaces(value);
  if (!normalized) return [];

  try {
    return normalizeNamedAgendaEntries(JSON.parse(normalized));
  } catch {
    return [];
  }
}

const NAMED_AGENDAS_META_KEY = 'named_agendas_v1';
const SINGLE_GROUP_AGENDA_MIGRATION_META_KEY = 'migration_done_single_group_agenda_v1';
const EXPENSES_MIGRATION_META_KEY = 'migration_done_expenses_v1';
const PRIMARY_GROUP_COLLECTIONS_MIGRATION_META_KEY = 'migration_done_primary_group_collections_v1';
const GROUP_EXPENSES_MIGRATION_META_PREFIX = 'migration_done_group_expenses_v2:';

function normalizeGroupId(value) {
  const normalized = compactSpaces(value);
  return normalized.endsWith('@g.us') ? normalized : '';
}

function normalizeGroupDatabaseFolderName(groupId) {
  return normalizeGroupId(groupId).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseMoneyToCents(value) {
  const input = compactSpaces(String(value || '').replace(/\uFEFF/g, '').replace(/r\$\s*/gi, ''));
  if (!input) return 0;

  const normalized = input.includes(',')
    ? input.replace(/\./g, '').replace(',', '.')
    : input.replace(',', '.');
  const numeric = Number.parseFloat(normalized);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

function parseExpenseDateToIso(value) {
  const input = compactSpaces(String(value || '').replace(/\s+às\s+/i, ' '));
  if (!input) return '';

  const full = input.match(
    /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/
  );
  if (!full) return '';

  const day = Number.parseInt(full[1], 10);
  const month = Number.parseInt(full[2], 10);
  const rawYear = Number.parseInt(full[3], 10);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const hour = Number.parseInt(full[4] || '0', 10);
  const minute = Number.parseInt(full[5] || '0', 10);
  const second = Number.parseInt(full[6] || '0', 10);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeExpenseTitle(value, fallback = 'Despesa avulsa') {
  let title = compactSpaces(String(value || '').replace(/\uFEFF/g, ' '));
  title = title.replace(/`+/g, ' ');
  title = title.replace(/\bse quiser\b.*$/i, ' ');
  title = title.replace(/\|\s*r\$\s*[\d.,]+.*$/i, ' ');
  title = title.replace(/[|]+.*$/g, ' ');
  title = title.replace(/[.;,:!?-]+$/g, ' ');
  title = compactSpaces(title);
  return title || fallback;
}

function normalizeExpenseSearchText(input = {}) {
  return foldText(
    [
      input.title,
      input.observation,
      input.payerName,
      input.payeeName,
      input.originBank,
      input.destinationBank
    ]
      .map((item) => compactSpaces(item))
      .filter(Boolean)
      .join(' ')
  );
}

function sanitizeExpenseRow(row) {
  if (!row || typeof row !== 'object') return null;

  const amountCents = Number.parseInt(String(row.amountCents ?? row.amount_cents ?? 0), 10) || 0;
  const source = compactSpaces(row.source);
  const status = compactSpaces(row.status);

  return {
    id: Number.parseInt(String(row.id || 0), 10) || 0,
    groupId: compactSpaces(row.groupId || row.group_id),
    title: normalizeExpenseTitle(row.title, 'Despesa'),
    normalizedTitle: compactSpaces(row.normalizedTitle || row.normalized_title),
    amountCents,
    expenseAt: compactSpaces(row.expenseAt || row.expense_at),
    source,
    sourceLabel:
      source === 'ocr' ? 'ocr' : source === 'manual' ? 'manual' : source === 'legacy_csv' ? 'importado' : source || 'manual',
    observation: compactSpaces(row.observation),
    senderNumber: compactSpaces(row.senderNumber || row.sender_number),
    status,
    statusLabel: status || 'persistido',
    payerName: compactSpaces(row.payerName || row.payer_name),
    payeeName: compactSpaces(row.payeeName || row.payee_name),
    originBank: compactSpaces(row.originBank || row.origin_bank),
    destinationBank: compactSpaces(row.destinationBank || row.destination_bank),
    dedupeKey: compactSpaces(row.dedupeKey || row.dedupe_key),
    extraJson: compactSpaces(row.extraJson || row.extra_json),
    createdAt: compactSpaces(row.createdAt || row.created_at),
    updatedAt: compactSpaces(row.updatedAt || row.updated_at)
  };
}

async function readLegacyExpenseRows(rootDir = join('data', 'despesas')) {
  try {
    const groupDirs = await readdir(rootDir, { withFileTypes: true });
    const rows = [];

    for (const groupDir of groupDirs) {
      if (!groupDir.isDirectory()) continue;

      const groupId = compactSpaces(groupDir.name).replace(/_g\.us$/i, '@g.us');
      if (!groupId.endsWith('@g.us')) continue;

      const files = await readdir(join(rootDir, groupDir.name), { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !/\.csv$/i.test(file.name)) continue;

        const content = await readFile(join(rootDir, groupDir.name, file.name), 'utf8');
        const lines = String(content || '')
          .replace(/\uFEFF/g, '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of lines.slice(1)) {
          const parts = line.split(';');
          if (parts.length < 5) continue;

          const title = normalizeExpenseTitle(parts[0], 'Despesa importada');
          const amountCents = parseMoneyToCents(parts[1]);
          const expenseAt = parseExpenseDateToIso(parts[2]) || new Date().toISOString();
          const originBank = compactSpaces(parts[3]);
          const destinationBank = compactSpaces(parts[4]);
          const dedupeKey = foldText([title, amountCents, expenseAt, originBank, destinationBank].join('|'));

          rows.push({
            groupId,
            title,
            amountCents,
            expenseAt,
            source: 'legacy_csv',
            observation: '',
            senderNumber: '',
            status: 'persistido',
            payerName: '',
            payeeName: title,
            originBank,
            destinationBank,
            dedupeKey,
            extraJson: JSON.stringify({
              fileName: file.name
            })
          });
        }
      }
    }

    return rows;
  } catch {
    return [];
  }
}

function normalizePanelUsername(value) {
  const normalized = compactSpaces(value).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(normalized)) return '';
  return normalized;
}

function validatePanelPassword(value, options = {}) {
  const password = String(value ?? '');
  const configuredMinLength = Number.parseInt(String(options.minLength ?? 8), 10);
  const minLength = Number.isFinite(configuredMinLength) ? Math.max(1, configuredMinLength) : 8;
  if (password.trim().length === 0) {
    return 'Senha obrigatoria.';
  }
  if (password.length < minLength) {
    return `A senha precisa ter pelo menos ${minLength} caracteres.`;
  }
  if (password.length > 128) {
    return 'A senha excede o limite de 128 caracteres.';
  }
  return '';
}

function hashPanelPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password ?? '').normalize('NFKC'), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPanelPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;

  try {
    const actualHash = scryptSync(String(password ?? '').normalize('NFKC'), salt, 64).toString('hex');
    const left = Buffer.from(actualHash, 'hex');
    const right = Buffer.from(String(expectedHash || ''), 'hex');

    if (left.length !== right.length || left.length === 0) {
      return false;
    }

    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function sanitizePanelUserRow(row) {
  if (!row || typeof row !== 'object') return null;

  return {
    id: Number(row.id),
    username: String(row.username || '').trim(),
    createdAt: String(row.createdAt || row.created_at || '').trim(),
    updatedAt: String(row.updatedAt || row.updated_at || '').trim(),
    lastLoginAt: String(row.lastLoginAt || row.last_login_at || '').trim() || null
  };
}

function normalizeLegacyItems(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === 'string') {
        const text = compactSpaces(item);
        if (!text || !hasMeaningfulText(text)) return null;
        const now = new Date().toISOString();
        return { text, createdAt: now, updatedAt: now };
      }

      if (!item || typeof item !== 'object') return null;
      const text = compactSpaces(item.text);
      if (!text || !hasMeaningfulText(text)) return null;
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
      const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
      return { text, createdAt, updatedAt };
    })
    .filter(Boolean);
}

function parseLegacyCollectionContent(content) {
  const normalized = String(content || '').trim();
  if (!normalized) return [];

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return normalizeLegacyItems(parsed);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return normalizeLegacyItems(parsed.items);
    }
  } catch {
    // Tenta JSONL no fallback abaixo.
  }

  const jsonlItems = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return normalizeLegacyItems(jsonlItems);
}

async function readLegacyItems(filePath) {
  const candidates = [filePath];
  if (filePath.endsWith('.json')) {
    candidates.push(`${filePath}l`);
  }

  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, 'utf8');
      const items = parseLegacyCollectionContent(content);
      if (items.length) {
        return { items, source: candidate };
      }
    } catch {
      // tenta proximo candidato.
    }
  }

  return { items: [], source: null };
}

class SqliteBotDatabase {
  constructor(filePath = config.botDatabaseFile, options = {}) {
    this.filePath = filePath;
    this.options = {
      migrateLegacyCollections: true,
      migrateLegacyExpenses: true,
      ...options
    };
    this.db = null;
    this.ready = null;
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = this.initialize();
    }
    await this.ready;
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });

    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_bot_items_collection_id
      ON bot_items(collection, id);

      CREATE TABLE IF NOT EXISTS bot_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS panel_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_panel_users_username
      ON panel_users(username);

      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        search_text TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        expense_at TEXT NOT NULL,
        source TEXT NOT NULL,
        observation TEXT NOT NULL DEFAULT '',
        sender_number TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'persistido',
        payer_name TEXT NOT NULL DEFAULT '',
        payee_name TEXT NOT NULL DEFAULT '',
        origin_bank TEXT NOT NULL DEFAULT '',
        destination_bank TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT,
        extra_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_expenses_group_expense_at
      ON expenses(group_id, expense_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_expenses_group_normalized_title
      ON expenses(group_id, normalized_title);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_group_dedupe_key
      ON expenses(group_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND dedupe_key <> '';

      CREATE TABLE IF NOT EXISTS full_auto_jobs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL DEFAULT '',
        sender_number TEXT NOT NULL DEFAULT '',
        request TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        status_label TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        validation_status TEXT NOT NULL DEFAULT '',
        log_lines TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_full_auto_jobs_started_at
      ON full_auto_jobs(started_at DESC);
    `);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO bot_items (collection, text, created_at, updated_at)
      VALUES (@collection, @text, @createdAt, @updatedAt)
    `);
    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM bot_items
      WHERE collection = @collection
    `);
    this.stmtList = this.db.prepare(`
      SELECT item_index AS itemIndex, text, created_at AS createdAt, updated_at AS updatedAt
      FROM (
        SELECT
          ROW_NUMBER() OVER (ORDER BY id ASC) AS item_index,
          text,
          created_at,
          updated_at
        FROM bot_items
        WHERE collection = @collection
      )
      ORDER BY item_index DESC
      LIMIT @limit
    `);
    this.stmtGetByIndex = this.db.prepare(`
      SELECT id, text, created_at AS createdAt, updated_at AS updatedAt
      FROM (
        SELECT
          id,
          text,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (ORDER BY id ASC) AS item_index
        FROM bot_items
        WHERE collection = @collection
      )
      WHERE item_index = @itemIndex
      LIMIT 1
    `);
    this.stmtDeleteById = this.db.prepare(`
      DELETE FROM bot_items
      WHERE id = @id
    `);
    this.stmtUpdateById = this.db.prepare(`
      UPDATE bot_items
      SET text = @text, updated_at = @updatedAt
      WHERE id = @id
    `);
    this.stmtClear = this.db.prepare(`
      DELETE FROM bot_items
      WHERE collection = @collection
    `);
    this.stmtMetaGet = this.db.prepare(`
      SELECT value
      FROM bot_meta
      WHERE key = @key
      LIMIT 1
    `);
    this.stmtMetaSet = this.db.prepare(`
      INSERT INTO bot_meta (key, value)
      VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.stmtPanelUserCount = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM panel_users
    `);
    this.stmtPanelUserList = this.db.prepare(`
      SELECT
        id,
        username,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_login_at AS lastLoginAt
      FROM panel_users
      ORDER BY username COLLATE NOCASE ASC
    `);
    this.stmtPanelUserGetById = this.db.prepare(`
      SELECT
        id,
        username,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_login_at AS lastLoginAt
      FROM panel_users
      WHERE id = @id
      LIMIT 1
    `);
    this.stmtPanelUserGetByUsername = this.db.prepare(`
      SELECT
        id,
        username,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        created_at AS createdAt,
        updated_at AS updatedAt,
        last_login_at AS lastLoginAt
      FROM panel_users
      WHERE username = @username
      LIMIT 1
    `);
    this.stmtPanelUserInsert = this.db.prepare(`
      INSERT INTO panel_users (
        username,
        password_hash,
        password_salt,
        created_at,
        updated_at,
        last_login_at
      )
      VALUES (
        @username,
        @passwordHash,
        @passwordSalt,
        @createdAt,
        @updatedAt,
        NULL
      )
    `);
    this.stmtPanelUserUpdatePassword = this.db.prepare(`
      UPDATE panel_users
      SET
        password_hash = @passwordHash,
        password_salt = @passwordSalt,
        updated_at = @updatedAt
      WHERE id = @id
    `);
    this.stmtPanelUserTouchLogin = this.db.prepare(`
      UPDATE panel_users
      SET
        last_login_at = @lastLoginAt,
        updated_at = @updatedAt
      WHERE id = @id
    `);
    this.stmtPanelUserDelete = this.db.prepare(`
      DELETE FROM panel_users
      WHERE id = @id
    `);
    this.stmtExpenseCount = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM expenses
    `);
    this.stmtExpenseInsert = this.db.prepare(`
      INSERT INTO expenses (
        group_id,
        title,
        normalized_title,
        search_text,
        amount_cents,
        expense_at,
        source,
        observation,
        sender_number,
        status,
        payer_name,
        payee_name,
        origin_bank,
        destination_bank,
        dedupe_key,
        extra_json,
        created_at,
        updated_at
      )
      VALUES (
        @groupId,
        @title,
        @normalizedTitle,
        @searchText,
        @amountCents,
        @expenseAt,
        @source,
        @observation,
        @senderNumber,
        @status,
        @payerName,
        @payeeName,
        @originBank,
        @destinationBank,
        @dedupeKey,
        @extraJson,
        @createdAt,
        @updatedAt
      )
    `);
    this.stmtExpenseGetById = this.db.prepare(`
      SELECT
        id,
        group_id AS groupId,
        title,
        normalized_title AS normalizedTitle,
        amount_cents AS amountCents,
        expense_at AS expenseAt,
        source,
        observation,
        sender_number AS senderNumber,
        status,
        payer_name AS payerName,
        payee_name AS payeeName,
        origin_bank AS originBank,
        destination_bank AS destinationBank,
        dedupe_key AS dedupeKey,
        extra_json AS extraJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM expenses
      WHERE id = @id
      LIMIT 1
    `);
    this.stmtExpenseDeleteById = this.db.prepare(`
      DELETE FROM expenses
      WHERE id = @id AND group_id = @groupId
    `);
    this.stmtExpenseGetByDedupe = this.db.prepare(`
      SELECT
        id,
        group_id AS groupId,
        title,
        normalized_title AS normalizedTitle,
        amount_cents AS amountCents,
        expense_at AS expenseAt,
        source,
        observation,
        sender_number AS senderNumber,
        status,
        payer_name AS payerName,
        payee_name AS payeeName,
        origin_bank AS originBank,
        destination_bank AS destinationBank,
        dedupe_key AS dedupeKey,
        extra_json AS extraJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM expenses
      WHERE group_id = @groupId AND dedupe_key = @dedupeKey
      LIMIT 1
    `);
    this.stmtExpenseRecentSimilar = this.db.prepare(`
      SELECT
        id,
        group_id AS groupId,
        title,
        normalized_title AS normalizedTitle,
        amount_cents AS amountCents,
        expense_at AS expenseAt,
        source,
        observation,
        sender_number AS senderNumber,
        status,
        payer_name AS payerName,
        payee_name AS payeeName,
        origin_bank AS originBank,
        destination_bank AS destinationBank,
        dedupe_key AS dedupeKey,
        extra_json AS extraJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM expenses
      WHERE
        group_id = @groupId
        AND normalized_title = @normalizedTitle
        AND amount_cents = @amountCents
        AND sender_number = @senderNumber
        AND observation = @observation
        AND created_at >= @minCreatedAt
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    this.stmtExpenseList = this.db.prepare(`
      SELECT
        id,
        group_id AS groupId,
        title,
        normalized_title AS normalizedTitle,
        amount_cents AS amountCents,
        expense_at AS expenseAt,
        source,
        observation,
        sender_number AS senderNumber,
        status,
        payer_name AS payerName,
        payee_name AS payeeName,
        origin_bank AS originBank,
        destination_bank AS destinationBank,
        dedupe_key AS dedupeKey,
        extra_json AS extraJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM expenses
      WHERE
        group_id = @groupId
        AND (@fromIso = '' OR expense_at >= @fromIso)
        AND (@toIso = '' OR expense_at < @toIso)
        AND (@query = '' OR search_text LIKE @queryLike OR normalized_title LIKE @queryLike)
      ORDER BY expense_at DESC, id DESC
      LIMIT @limit
    `);
    this.stmtExpenseListForDelete = this.db.prepare(`
      SELECT
        id,
        group_id AS groupId,
        title,
        normalized_title AS normalizedTitle,
        amount_cents AS amountCents,
        expense_at AS expenseAt,
        source,
        observation,
        sender_number AS senderNumber,
        status,
        payer_name AS payerName,
        payee_name AS payeeName,
        origin_bank AS originBank,
        destination_bank AS destinationBank,
        dedupe_key AS dedupeKey,
        extra_json AS extraJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM expenses
      WHERE
        group_id = @groupId
        AND (@fromIso = '' OR expense_at >= @fromIso)
        AND (@toIso = '' OR expense_at < @toIso)
        AND (@query = '' OR search_text LIKE @queryLike OR normalized_title LIKE @queryLike)
      ORDER BY expense_at DESC, id DESC
    `);
    this.stmtExpenseDeleteFiltered = this.db.prepare(`
      DELETE FROM expenses
      WHERE
        group_id = @groupId
        AND (@fromIso = '' OR expense_at >= @fromIso)
        AND (@toIso = '' OR expense_at < @toIso)
        AND (@query = '' OR search_text LIKE @queryLike OR normalized_title LIKE @queryLike)
    `);
    this.stmtExpenseSummary = this.db.prepare(`
      SELECT
        COUNT(*) AS totalCount,
        COALESCE(SUM(amount_cents), 0) AS totalAmountCents
      FROM expenses
      WHERE
        group_id = @groupId
        AND (@fromIso = '' OR expense_at >= @fromIso)
        AND (@toIso = '' OR expense_at < @toIso)
        AND (@query = '' OR search_text LIKE @queryLike OR normalized_title LIKE @queryLike)
    `);

    this.stmtFullJobSave = this.db.prepare(`
      INSERT OR REPLACE INTO full_auto_jobs
        (id, group_id, sender_number, request, status, status_label,
         detail, summary, error, validation_status, log_lines,
         started_at, updated_at, finished_at)
      VALUES
        (@id, @groupId, @senderNumber, @request, @status, @statusLabel,
         @detail, @summary, @error, @validationStatus, @logLines,
         @startedAt, @updatedAt, @finishedAt)
    `);
    this.stmtFullJobGetById = this.db.prepare(`
      SELECT * FROM full_auto_jobs WHERE id = @id
    `);
    this.stmtFullJobList = this.db.prepare(`
      SELECT * FROM full_auto_jobs
      WHERE started_at >= @sinceMs
      ORDER BY started_at DESC
      LIMIT @limit
    `);
    this.stmtFullJobClearOld = this.db.prepare(`
      DELETE FROM full_auto_jobs WHERE started_at < @beforeMs
    `);
    this.stmtFullJobClearAll = this.db.prepare(`
      DELETE FROM full_auto_jobs
    `);

    if (this.options.migrateLegacyCollections) {
      await this.migrateLegacyCollection('agenda', config.agendaFile);
      await this.migrateLegacyCollection('notes', config.notesFile);
    }
    if (this.options.migrateLegacyExpenses) {
      await this.migrateLegacyExpenses();
    }
  }

  countCollection(collection) {
    const row = this.stmtCount.get({ collection });
    return Number(row?.total || 0);
  }

  getMeta(key) {
    const row = this.stmtMetaGet.get({ key });
    return row?.value || '';
  }

  setMeta(key, value) {
    this.stmtMetaSet.run({
      key,
      value: String(value ?? '')
    });
  }

  async migrateLegacyCollection(collection, legacyFilePath) {
    const migrationKey = `migration_done_${collection}`;
    if (this.getMeta(migrationKey) === '1') {
      return;
    }

    const existing = this.countCollection(collection);
    if (existing > 0) {
      this.setMeta(migrationKey, '1');
      return;
    }

    const { items, source } = await readLegacyItems(legacyFilePath);
    if (!items.length) {
      this.setMeta(migrationKey, '1');
      return;
    }

    const insertTransaction = this.db.transaction((rows) => {
      for (const row of rows) {
        this.stmtInsert.run({
          collection,
          text: row.text,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt
        });
      }
    });

    insertTransaction(items);
    logger.info('Migracao de colecao para SQLite concluida', {
      collection,
      migratedItems: items.length,
      source: source || legacyFilePath,
      database: this.filePath
    });
    this.setMeta(migrationKey, '1');
  }

  async addItem(collection, text) {
    await this.ensureReady();

    const normalized = compactSpaces(text);
    if (!normalized || !hasMeaningfulText(normalized)) {
      return {
        item: { text: '' },
        total: this.countCollection(collection)
      };
    }

    const now = new Date().toISOString();
    this.stmtInsert.run({
      collection,
      text: normalized,
      createdAt: now,
      updatedAt: now
    });

    return {
      item: {
        text: normalized,
        createdAt: now,
        updatedAt: now
      },
      total: this.countCollection(collection)
    };
  }

  async listItems(collection, limit = 10) {
    await this.ensureReady();

    const safeLimit = Math.max(1, Number.parseInt(String(limit), 10) || 10);
    const rows = this.stmtList.all({
      collection,
      limit: safeLimit
    });

    return rows.reverse().map((row) => ({
      index: Number(row.itemIndex),
      text: row.text,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  async removeItemByIndex(collection, indexOneBased) {
    await this.ensureReady();

    const itemIndex = Number.parseInt(String(indexOneBased), 10);
    if (!Number.isFinite(itemIndex) || itemIndex <= 0) return null;

    const row = this.stmtGetByIndex.get({
      collection,
      itemIndex
    });
    if (!row) return null;

    this.stmtDeleteById.run({ id: row.id });

    return {
      removed: {
        text: row.text,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      },
      remaining: this.countCollection(collection)
    };
  }

  async updateItemByIndex(collection, indexOneBased, newText) {
    await this.ensureReady();

    const itemIndex = Number.parseInt(String(indexOneBased), 10);
    if (!Number.isFinite(itemIndex) || itemIndex <= 0) return null;

    const normalized = compactSpaces(newText);
    if (!normalized) return null;

    const row = this.stmtGetByIndex.get({
      collection,
      itemIndex
    });
    if (!row) return null;

    const updatedAt = new Date().toISOString();
    this.stmtUpdateById.run({
      id: row.id,
      text: normalized,
      updatedAt
    });

    return {
      index: itemIndex,
      previousText: row.text,
      updatedText: normalized
    };
  }

  async clearItems(collection) {
    await this.ensureReady();
    const result = this.stmtClear.run({ collection });
    return Number(result?.changes || 0);
  }

  buildNamedAgendaCollection(nameOrEntry) {
    const source =
      typeof nameOrEntry === 'string'
        ? nameOrEntry
        : nameOrEntry && typeof nameOrEntry === 'object'
          ? nameOrEntry.key || nameOrEntry.name
          : '';
    const key = buildNamedAgendaKey(source);
    return key ? `agenda_named:${key}` : '';
  }

  async ensureNamedAgendas(names = []) {
    await this.ensureReady();

    const raw = this.getMeta(NAMED_AGENDAS_META_KEY);
    const trimmed = compactSpaces(raw);
    const existing = parseNamedAgendaEntries(raw);
    if (existing.length || trimmed === '[]') {
      return existing;
    }

    const defaults = normalizeNamedAgendaEntries(names);
    this.setMeta(NAMED_AGENDAS_META_KEY, JSON.stringify(defaults));
    return defaults;
  }

  async listNamedAgendas() {
    await this.ensureReady();
    return parseNamedAgendaEntries(this.getMeta(NAMED_AGENDAS_META_KEY));
  }

  async findNamedAgenda(name) {
    await this.ensureReady();

    const normalizedName = normalizeNamedAgendaLabel(name);
    const lookupKey = buildNamedAgendaKey(normalizedName);
    if (!normalizedName || !lookupKey) return null;

    const items = parseNamedAgendaEntries(this.getMeta(NAMED_AGENDAS_META_KEY));
    return (
      items.find((item) => item.key === lookupKey || foldText(item.name) === foldText(normalizedName)) || null
    );
  }

  async createNamedAgenda(name) {
    await this.ensureReady();

    const normalizedName = normalizeNamedAgendaLabel(name);
    const key = buildNamedAgendaKey(normalizedName);
    if (!normalizedName || !key) {
      return {
        ok: false,
        message: 'Nome de agenda invalido.'
      };
    }

    const items = parseNamedAgendaEntries(this.getMeta(NAMED_AGENDAS_META_KEY));
    const existing = items.find((item) => item.key === key || foldText(item.name) === foldText(normalizedName));
    if (existing) {
      return {
        ok: true,
        created: false,
        agenda: existing
      };
    }

    const now = new Date().toISOString();
    const agenda = {
      key,
      name: normalizedName,
      createdAt: now,
      updatedAt: now
    };

    items.push(agenda);
    this.setMeta(NAMED_AGENDAS_META_KEY, JSON.stringify(items));

    return {
      ok: true,
      created: true,
      agenda
    };
  }

  async deleteNamedAgenda(nameOrEntry) {
    await this.ensureReady();

    const source =
      typeof nameOrEntry === 'string'
        ? nameOrEntry
        : nameOrEntry && typeof nameOrEntry === 'object'
          ? nameOrEntry.name || nameOrEntry.key
          : '';
    const normalizedName = normalizeNamedAgendaLabel(source);
    const key = buildNamedAgendaKey(
      typeof nameOrEntry === 'object' && nameOrEntry ? nameOrEntry.key || normalizedName : normalizedName
    );
    if (!normalizedName || !key) {
      return {
        ok: false,
        message: 'Agenda invalida.'
      };
    }

    const items = parseNamedAgendaEntries(this.getMeta(NAMED_AGENDAS_META_KEY));
    const index = items.findIndex((item) => item.key === key || foldText(item.name) === foldText(normalizedName));
    if (index < 0) {
      return {
        ok: false,
        message: 'Agenda nao encontrada.'
      };
    }

    const [agenda] = items.splice(index, 1);
    this.setMeta(NAMED_AGENDAS_META_KEY, JSON.stringify(items));
    const removedItems = await this.clearItems(this.buildNamedAgendaCollection(agenda));

    return {
      ok: true,
      deleted: true,
      agenda,
      removedItems
    };
  }

  async migrateNamedAgendasToSingleAgenda() {
    await this.ensureReady();

    if (this.getMeta(SINGLE_GROUP_AGENDA_MIGRATION_META_KEY) === '1') {
      return {
        ok: true,
        migratedItems: 0,
        removedNamedItems: 0,
        clearedSelectionMeta: 0
      };
    }

    const namedRows = this.db
      .prepare(
        `
          SELECT text, created_at AS createdAt, updated_at AS updatedAt
          FROM bot_items
          WHERE collection LIKE 'agenda_named:%'
          ORDER BY id ASC
        `
      )
      .all();

    const currentAgendaRows = this.db
      .prepare(
        `
          SELECT text, created_at AS createdAt, updated_at AS updatedAt
          FROM bot_items
          WHERE collection = 'agenda'
          ORDER BY id ASC
        `
      )
      .all();

    const existingKeys = new Set(
      currentAgendaRows.map((row) => JSON.stringify([compactSpaces(row.text), row.createdAt || '', row.updatedAt || '']))
    );
    const rowsToInsert = [];

    for (const row of namedRows) {
      const normalizedText = compactSpaces(row.text);
      if (!normalizedText) continue;

      const identity = JSON.stringify([normalizedText, row.createdAt || '', row.updatedAt || '']);
      if (existingKeys.has(identity)) continue;

      existingKeys.add(identity);
      rowsToInsert.push({
        collection: 'agenda',
        text: normalizedText,
        createdAt: row.createdAt || new Date().toISOString(),
        updatedAt: row.updatedAt || row.createdAt || new Date().toISOString()
      });
    }

    if (rowsToInsert.length) {
      const insertTransaction = this.db.transaction((rows) => {
        for (const row of rows) {
          this.stmtInsert.run(row);
        }
      });
      insertTransaction(rowsToInsert);
    }

    const removedNamedItems = Number(
      this.db
        .prepare(
          `
            DELETE FROM bot_items
            WHERE collection LIKE 'agenda_named:%'
          `
        )
        .run().changes || 0
    );
    const clearedSelectionMeta = Number(
      this.db
        .prepare(
          `
            DELETE FROM bot_meta
            WHERE key LIKE 'agenda_selection_v1:%'
          `
        )
        .run().changes || 0
    );

    this.setMeta(SINGLE_GROUP_AGENDA_MIGRATION_META_KEY, '1');

    if (rowsToInsert.length || removedNamedItems || clearedSelectionMeta) {
      logger.info('Migracao de agendas nomeadas para agenda unica concluida', {
        migratedItems: rowsToInsert.length,
        removedNamedItems,
        clearedSelectionMeta,
        database: this.filePath
      });
    }

    return {
      ok: true,
      migratedItems: rowsToInsert.length,
      removedNamedItems,
      clearedSelectionMeta
    };
  }

  async migrateLegacyExpenses() {
    if (this.getMeta(EXPENSES_MIGRATION_META_KEY) === '1') {
      return;
    }

    const existing = Number(this.stmtExpenseCount.get()?.total || 0);
    if (existing > 0) {
      this.setMeta(EXPENSES_MIGRATION_META_KEY, '1');
      return;
    }

    const rows = await readLegacyExpenseRows();
    if (!rows.length) {
      this.setMeta(EXPENSES_MIGRATION_META_KEY, '1');
      return;
    }

    const insertTransaction = this.db.transaction((items) => {
      for (const item of items) {
        const now = new Date().toISOString();
        this.stmtExpenseInsert.run({
          groupId: item.groupId,
          title: normalizeExpenseTitle(item.title),
          normalizedTitle: foldText(item.title),
          searchText: normalizeExpenseSearchText(item),
          amountCents: Number(item.amountCents || 0),
          expenseAt: item.expenseAt || now,
          source: compactSpaces(item.source || 'legacy_csv') || 'legacy_csv',
          observation: compactSpaces(item.observation),
          senderNumber: compactSpaces(item.senderNumber),
          status: compactSpaces(item.status || 'persistido') || 'persistido',
          payerName: compactSpaces(item.payerName),
          payeeName: compactSpaces(item.payeeName),
          originBank: compactSpaces(item.originBank),
          destinationBank: compactSpaces(item.destinationBank),
          dedupeKey: compactSpaces(item.dedupeKey) || null,
          extraJson: compactSpaces(item.extraJson || '{}') || '{}',
          createdAt: now,
          updatedAt: now
        });
      }
    });

    insertTransaction(rows);
    logger.info('Migracao de despesas legadas para SQLite concluida', {
      migratedItems: rows.length,
      database: this.filePath
    });
    this.setMeta(EXPENSES_MIGRATION_META_KEY, '1');
  }

  async addExpense(input = {}) {
    await this.ensureReady();

    const now = new Date().toISOString();
    const title = normalizeExpenseTitle(input.title);
    const amountCents = Number.parseInt(String(input.amountCents || 0), 10) || 0;
    const expenseAt = compactSpaces(input.expenseAt) || now;
    const dedupeKey = compactSpaces(input.dedupeKey);
    const payload = {
      groupId: compactSpaces(input.groupId),
      title,
      normalizedTitle: foldText(title),
      searchText: normalizeExpenseSearchText({
        title,
        observation: input.observation,
        payerName: input.payerName,
        payeeName: input.payeeName,
        originBank: input.originBank,
        destinationBank: input.destinationBank
      }),
      amountCents,
      expenseAt,
      source: compactSpaces(input.source || 'manual') || 'manual',
      observation: compactSpaces(input.observation),
      senderNumber: compactSpaces(input.senderNumber),
      status: compactSpaces(input.status || 'persistido') || 'persistido',
      payerName: compactSpaces(input.payerName),
      payeeName: compactSpaces(input.payeeName),
      originBank: compactSpaces(input.originBank),
      destinationBank: compactSpaces(input.destinationBank),
      dedupeKey: dedupeKey || null,
      extraJson: compactSpaces(input.extraJson || '{}') || '{}',
      createdAt: now,
      updatedAt: now
    };

    if (!payload.groupId) {
      return {
        ok: false,
        message: 'Grupo de despesa invalido.'
      };
    }

    if (payload.amountCents <= 0) {
      return {
        ok: false,
        message: 'Valor de despesa invalido.'
      };
    }

    if (dedupeKey) {
      const existingByDedupe = sanitizeExpenseRow(
        this.stmtExpenseGetByDedupe.get({
          groupId: payload.groupId,
          dedupeKey
        })
      );
      if (existingByDedupe) {
        return {
          ok: true,
          duplicate: true,
          item: existingByDedupe
        };
      }
    }

    try {
      const result = this.stmtExpenseInsert.run(payload);
      return {
        ok: true,
        duplicate: false,
        item: sanitizeExpenseRow(this.stmtExpenseGetById.get({ id: result.lastInsertRowid }))
      };
    } catch (error) {
      if (
        dedupeKey &&
        error instanceof Error &&
        /unique|constraint/i.test(error.message)
      ) {
        const existingByDedupe = sanitizeExpenseRow(
          this.stmtExpenseGetByDedupe.get({
            groupId: payload.groupId,
            dedupeKey
          })
        );
        if (existingByDedupe) {
          return {
            ok: true,
            duplicate: true,
            item: existingByDedupe
          };
        }
      }

      throw error;
    }
  }

  async findRecentSimilarExpense(input = {}) {
    await this.ensureReady();

    const minutes = Math.max(1, Number.parseInt(String(input.withinMinutes || 5), 10) || 5);
    const minCreatedAt = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const row = this.stmtExpenseRecentSimilar.get({
      groupId: compactSpaces(input.groupId),
      normalizedTitle: foldText(input.title),
      amountCents: Number.parseInt(String(input.amountCents || 0), 10) || 0,
      senderNumber: compactSpaces(input.senderNumber),
      observation: compactSpaces(input.observation),
      minCreatedAt
    });
    return sanitizeExpenseRow(row);
  }

  async getExpenseById(id, groupId = '') {
    await this.ensureReady();

    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId) || numericId <= 0) return null;

    const item = sanitizeExpenseRow(this.stmtExpenseGetById.get({ id: numericId }));
    if (!item) return null;

    const normalizedGroupId = compactSpaces(groupId);
    if (normalizedGroupId && item.groupId !== normalizedGroupId) {
      return null;
    }

    return item;
  }

  async deleteExpenseById(input = {}) {
    await this.ensureReady();

    const item = await this.getExpenseById(input.id, input.groupId);
    if (!item) {
      return {
        ok: true,
        deleted: false,
        item: null
      };
    }

    const result = this.stmtExpenseDeleteById.run({
      id: item.id,
      groupId: item.groupId
    });

    return {
      ok: true,
      deleted: Number(result?.changes || 0) > 0,
      item
    };
  }

  async deleteExpenses(filters = {}) {
    await this.ensureReady();

    const query = foldText(filters.query);
    const payload = {
      groupId: compactSpaces(filters.groupId),
      fromIso: compactSpaces(filters.fromIso),
      toIso: compactSpaces(filters.toIso),
      query,
      queryLike: query ? `%${query}%` : ''
    };

    const items = this.stmtExpenseListForDelete
      .all(payload)
      .map((row) => sanitizeExpenseRow(row))
      .filter(Boolean);

    if (!items.length) {
      return {
        ok: true,
        deleted: false,
        deletedCount: 0,
        items: []
      };
    }

    const result = this.stmtExpenseDeleteFiltered.run(payload);

    return {
      ok: true,
      deleted: Number(result?.changes || 0) > 0,
      deletedCount: Number(result?.changes || 0),
      items
    };
  }

  async listExpenses(filters = {}) {
    await this.ensureReady();

    const query = foldText(filters.query);
    const rows = this.stmtExpenseList.all({
      groupId: compactSpaces(filters.groupId),
      fromIso: compactSpaces(filters.fromIso),
      toIso: compactSpaces(filters.toIso),
      query,
      queryLike: query ? `%${query}%` : '',
      limit: Math.max(1, Number.parseInt(String(filters.limit || 20), 10) || 20)
    });

    return {
      items: rows.map((row) => sanitizeExpenseRow(row)).filter(Boolean)
    };
  }

  async summarizeExpenses(filters = {}) {
    await this.ensureReady();

    const query = foldText(filters.query);
    const row = this.stmtExpenseSummary.get({
      groupId: compactSpaces(filters.groupId),
      fromIso: compactSpaces(filters.fromIso),
      toIso: compactSpaces(filters.toIso),
      query,
      queryLike: query ? `%${query}%` : ''
    });

    return {
      totalCount: Number.parseInt(String(row?.totalCount || 0), 10) || 0,
      totalAmountCents: Number.parseInt(String(row?.totalAmountCents || 0), 10) || 0
    };
  }

  async countPanelUsers() {
    await this.ensureReady();
    const row = this.stmtPanelUserCount.get();
    return Number(row?.total || 0);
  }

  async listPanelUsers() {
    await this.ensureReady();
    return this.stmtPanelUserList.all().map((row) => sanitizePanelUserRow(row)).filter(Boolean);
  }

  async getPanelUserById(id) {
    await this.ensureReady();

    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId) || numericId <= 0) return null;

    const row = this.stmtPanelUserGetById.get({ id: numericId });
    return sanitizePanelUserRow(row);
  }

  async getPanelUserByUsername(username) {
    await this.ensureReady();

    const normalizedUsername = normalizePanelUsername(username);
    if (!normalizedUsername) return null;

    const row = this.stmtPanelUserGetByUsername.get({ username: normalizedUsername });
    return sanitizePanelUserRow(row);
  }

  async ensurePanelBootstrapUser(username, password, options = {}) {
    await this.ensureReady();

    const normalizedUsername = normalizePanelUsername(username);
    if (!normalizedUsername) {
      return {
        ok: false,
        message: 'Usuario bootstrap invalido. Use de 3 a 32 caracteres com letras, numeros, ponto, underscore ou hifen.'
      };
    }

    const passwordError = validatePanelPassword(password, {
      minLength: options.allowWeakPassword ? 3 : 8
    });
    if (passwordError) {
      return {
        ok: false,
        message: passwordError
      };
    }

    const existing = this.stmtPanelUserGetByUsername.get({ username: normalizedUsername });
    if (!existing) {
      const now = new Date().toISOString();
      const { salt, hash } = hashPanelPassword(password);
      const result = this.stmtPanelUserInsert.run({
        username: normalizedUsername,
        passwordHash: hash,
        passwordSalt: salt,
        createdAt: now,
        updatedAt: now
      });

      return {
        ok: true,
        created: true,
        updated: false,
        user: await this.getPanelUserById(result.lastInsertRowid)
      };
    }

    if (verifyPanelPassword(password, existing.passwordSalt, existing.passwordHash)) {
      return {
        ok: true,
        created: false,
        updated: false,
        user: sanitizePanelUserRow(existing)
      };
    }

    const updatedAt = new Date().toISOString();
    const { salt, hash } = hashPanelPassword(password);
    this.stmtPanelUserUpdatePassword.run({
      id: Number(existing.id),
      passwordHash: hash,
      passwordSalt: salt,
      updatedAt
    });

    return {
      ok: true,
      created: false,
      updated: true,
      user: await this.getPanelUserById(existing.id)
    };
  }

  async createPanelUser(username, password) {
    await this.ensureReady();

    const normalizedUsername = normalizePanelUsername(username);
    if (!normalizedUsername) {
      return {
        ok: false,
        message: 'Usuario invalido. Use de 3 a 32 caracteres com letras, numeros, ponto, underscore ou hifen.'
      };
    }

    const passwordError = validatePanelPassword(password);
    if (passwordError) {
      return {
        ok: false,
        message: passwordError
      };
    }

    const existing = this.stmtPanelUserGetByUsername.get({ username: normalizedUsername });
    if (existing) {
      return {
        ok: false,
        reason: 'exists',
        message: 'Ja existe um usuario com esse login.'
      };
    }

    const now = new Date().toISOString();
    const { salt, hash } = hashPanelPassword(password);
    const result = this.stmtPanelUserInsert.run({
      username: normalizedUsername,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: now,
      updatedAt: now
    });

    const user = await this.getPanelUserById(result.lastInsertRowid);
    return {
      ok: true,
      created: true,
      user
    };
  }

  async authenticatePanelUser(username, password) {
    await this.ensureReady();

    const normalizedUsername = normalizePanelUsername(username);
    if (!normalizedUsername) {
      return {
        ok: false,
        message: 'Usuario ou senha invalidos.'
      };
    }

    const row = this.stmtPanelUserGetByUsername.get({ username: normalizedUsername });
    if (!row || !verifyPanelPassword(password, row.passwordSalt, row.passwordHash)) {
      return {
        ok: false,
        message: 'Usuario ou senha invalidos.'
      };
    }

    return {
      ok: true,
      user: sanitizePanelUserRow(row)
    };
  }

  async updatePanelUserPassword(id, password) {
    await this.ensureReady();

    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return {
        ok: false,
        message: 'Usuario invalido.'
      };
    }

    const existing = this.stmtPanelUserGetById.get({ id: numericId });
    if (!existing) {
      return {
        ok: false,
        message: 'Usuario nao encontrado.'
      };
    }

    const passwordError = validatePanelPassword(password);
    if (passwordError) {
      return {
        ok: false,
        message: passwordError
      };
    }

    const updatedAt = new Date().toISOString();
    const { salt, hash } = hashPanelPassword(password);
    this.stmtPanelUserUpdatePassword.run({
      id: numericId,
      passwordHash: hash,
      passwordSalt: salt,
      updatedAt
    });

    return {
      ok: true,
      user: await this.getPanelUserById(numericId)
    };
  }

  async touchPanelUserLogin(id) {
    await this.ensureReady();

    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return false;
    }

    const now = new Date().toISOString();
    const result = this.stmtPanelUserTouchLogin.run({
      id: numericId,
      lastLoginAt: now,
      updatedAt: now
    });

    return Number(result?.changes || 0) > 0;
  }

  async deletePanelUser(id) {
    await this.ensureReady();

    const numericId = Number.parseInt(String(id), 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return {
        ok: false,
        message: 'Usuario invalido.'
      };
    }

    const existing = this.stmtPanelUserGetById.get({ id: numericId });
    if (!existing) {
      return {
        ok: false,
        message: 'Usuario nao encontrado.'
      };
    }

    const totalUsers = await this.countPanelUsers();
    if (totalUsers <= 1) {
      return {
        ok: false,
        message: 'Nao e permitido remover o ultimo usuario do painel.'
      };
    }

    this.stmtPanelUserDelete.run({ id: numericId });

    return {
      ok: true,
      removedUser: sanitizePanelUserRow(existing),
      remainingUsers: await this.countPanelUsers()
    };
  }

  // --- full_auto_jobs ---

  saveFullJob(job) {
    if (!job || !job.id) return;
    this.stmtFullJobSave.run({
      id: String(job.id),
      groupId: String(job.groupId || ''),
      senderNumber: String(job.senderNumber || ''),
      request: String(job.request || ''),
      status: String(job.status || 'running'),
      statusLabel: String(job.statusLabel || ''),
      detail: String(job.detail || ''),
      summary: String(job.summary || ''),
      error: String(job.error || ''),
      validationStatus: String(job.validationStatus || ''),
      logLines: JSON.stringify(Array.isArray(job.logLines) ? job.logLines : []),
      startedAt: Number(job.startedAt || 0),
      updatedAt: Number(job.updatedAt || Date.now()),
      finishedAt: job.finishedAt != null ? Number(job.finishedAt) : null
    });
  }

  getFullJobById(id) {
    const row = this.stmtFullJobGetById.get({ id: String(id || '') });
    if (!row) return null;
    return this._deserializeFullJob(row);
  }

  listFullJobsByAge({ limit = 500, daysBack = 30 } = {}) {
    const safeLimit = Math.max(1, Math.min(2000, Number(limit || 500)));
    const safeDays = Math.max(1, Math.min(365, Number(daysBack || 30)));
    const sinceMs = Date.now() - safeDays * 24 * 60 * 60 * 1000;
    const rows = this.stmtFullJobList.all({ sinceMs, limit: safeLimit });
    return rows.map((row) => this._deserializeFullJob(row));
  }

  clearFullJobs({ beforeMs } = {}) {
    if (beforeMs != null) {
      const result = this.stmtFullJobClearOld.run({ beforeMs: Number(beforeMs) });
      return Number(result?.changes || 0);
    }
    const result = this.stmtFullJobClearAll.run();
    return Number(result?.changes || 0);
  }

  _deserializeFullJob(row) {
    let logLines = [];
    try {
      logLines = JSON.parse(row.log_lines || '[]');
      if (!Array.isArray(logLines)) logLines = [];
    } catch {
      logLines = [];
    }
    return {
      id: row.id,
      groupId: row.group_id,
      senderNumber: row.sender_number,
      request: row.request,
      status: row.status,
      statusLabel: row.status_label,
      detail: row.detail,
      summary: row.summary,
      error: row.error,
      validationStatus: row.validation_status,
      logLines,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at ?? null
    };
  }
}

class BotDatabaseManager {
  constructor(options = {}) {
    this.primaryGroupId = normalizeGroupId(options.primaryGroupId || config.groupJid || '');
    this.globalFilePath = options.globalFilePath || config.botDatabaseFile;
    this.groupDatabasesDir = options.groupDatabasesDir || config.groupDatabasesDir;
    this.adminDb = new SqliteBotDatabase(this.globalFilePath, {
      migrateLegacyCollections: false,
      migrateLegacyExpenses: false
    });
    this.groupDbs = new Map();
  }

  setPrimaryGroupId(groupId) {
    const normalized = normalizeGroupId(groupId);
    if (normalized) {
      this.primaryGroupId = normalized;
    }
  }

  resolveGroupId(groupId = '') {
    const normalized = normalizeGroupId(groupId) || normalizeGroupId(this.primaryGroupId);
    if (!normalized) {
      throw new Error('Grupo nao definido para acesso ao banco dedicado.');
    }
    return normalized;
  }

  resolveGroupDatabaseFile(groupId = '') {
    const normalized = this.resolveGroupId(groupId);
    return join(this.groupDatabasesDir, normalizeGroupDatabaseFolderName(normalized), 'bot.sqlite');
  }

  async ensureReady(groupId = '') {
    await this.adminDb.ensureReady();
    const normalizedGroupId = normalizeGroupId(groupId);
    if (normalizedGroupId) {
      await this.getGroupDb(normalizedGroupId);
    }
  }

  getExistingGroupDb(groupId = '') {
    const normalized = this.resolveGroupId(groupId);
    const store = this.groupDbs.get(normalized);
    if (!store || !store.db) {
      throw new Error(`Banco dedicado do grupo ${normalized} ainda nao foi inicializado.`);
    }
    return store;
  }

  async getGroupDb(groupId = '') {
    const normalized = this.resolveGroupId(groupId);
    let store = this.groupDbs.get(normalized);

    if (!store) {
      store = new SqliteBotDatabase(this.resolveGroupDatabaseFile(normalized), {
        migrateLegacyCollections: normalized === this.primaryGroupId,
        migrateLegacyExpenses: false
      });
      this.groupDbs.set(normalized, store);
    }

    await store.ensureReady();
    await this.migratePrimaryGroupCollections(store, normalized);
    await this.migrateGroupExpenses(store, normalized);
    return store;
  }

  copyBotItems(targetDb, rows = []) {
    const items = Array.isArray(rows)
      ? rows
          .map((row) => ({
            collection: compactSpaces(row.collection),
            text: compactSpaces(row.text),
            createdAt: compactSpaces(row.createdAt || row.created_at) || new Date().toISOString(),
            updatedAt: compactSpaces(row.updatedAt || row.updated_at) || compactSpaces(row.createdAt || row.created_at) || new Date().toISOString()
          }))
          .filter((row) => row.collection && row.text)
      : [];

    if (!items.length) return 0;

    const insertTransaction = targetDb.db.transaction((batch) => {
      for (const item of batch) {
        targetDb.stmtInsert.run(item);
      }
    });

    insertTransaction(items);
    return items.length;
  }

  copyMetaEntries(targetDb, rows = []) {
    const entries = Array.isArray(rows)
      ? rows
          .map((row) => ({
            key: compactSpaces(row.key),
            value: String(row.value ?? '')
          }))
          .filter((row) => row.key)
      : [];

    if (!entries.length) return 0;

    const insertTransaction = targetDb.db.transaction((batch) => {
      for (const item of batch) {
        targetDb.stmtMetaSet.run(item);
      }
    });

    insertTransaction(entries);
    return entries.length;
  }

  async migratePrimaryGroupCollections(targetDb, groupId) {
    if (groupId !== this.primaryGroupId) {
      return;
    }

    if (targetDb.getMeta(PRIMARY_GROUP_COLLECTIONS_MIGRATION_META_KEY) === '1') {
      return;
    }

    await this.adminDb.ensureReady();

    let copiedCollections = 0;
    let copiedMeta = 0;

    if (targetDb.countCollection('agenda') === 0) {
      const agendaRows = this.adminDb.db
        .prepare(
          `
            SELECT collection, text, created_at AS createdAt, updated_at AS updatedAt
            FROM bot_items
            WHERE collection = 'agenda'
            ORDER BY id ASC
          `
        )
        .all();
      copiedCollections += this.copyBotItems(targetDb, agendaRows);
    }

    if (targetDb.countCollection('notes') === 0) {
      const notesRows = this.adminDb.db
        .prepare(
          `
            SELECT collection, text, created_at AS createdAt, updated_at AS updatedAt
            FROM bot_items
            WHERE collection = 'notes'
            ORDER BY id ASC
          `
        )
        .all();
      copiedCollections += this.copyBotItems(targetDb, notesRows);
    }

    const existingNamedAgendas = parseNamedAgendaEntries(targetDb.getMeta(NAMED_AGENDAS_META_KEY));
    if (!existingNamedAgendas.length) {
      const namedAgendasValue = this.adminDb.getMeta(NAMED_AGENDAS_META_KEY);
      if (compactSpaces(namedAgendasValue) || namedAgendasValue === '[]') {
        copiedMeta += this.copyMetaEntries(targetDb, [
          {
            key: NAMED_AGENDAS_META_KEY,
            value: namedAgendasValue
          }
        ]);
      }

      const namedAgendaRows = this.adminDb.db
        .prepare(
          `
            SELECT collection, text, created_at AS createdAt, updated_at AS updatedAt
            FROM bot_items
            WHERE collection LIKE 'agenda_named:%'
            ORDER BY id ASC
          `
        )
        .all();
      copiedCollections += this.copyBotItems(targetDb, namedAgendaRows);
    }

    targetDb.setMeta(PRIMARY_GROUP_COLLECTIONS_MIGRATION_META_KEY, '1');

    if (copiedCollections || copiedMeta) {
      logger.info('Migracao inicial do grupo principal para banco dedicado concluida', {
        groupId,
        copiedCollections,
        copiedMeta,
        database: targetDb.filePath,
        sourceDatabase: this.globalFilePath
      });
    }
  }

  async migrateGroupExpenses(targetDb, groupId) {
    const migrationKey = `${GROUP_EXPENSES_MIGRATION_META_PREFIX}${groupId}`;
    if (targetDb.getMeta(migrationKey) === '1') {
      return;
    }

    const existing = Number(targetDb.stmtExpenseCount.get()?.total || 0);
    if (existing > 0) {
      targetDb.setMeta(migrationKey, '1');
      return;
    }

    await this.adminDb.ensureReady();

    let rows = this.adminDb.db
      .prepare(
        `
          SELECT
            group_id AS groupId,
            title,
            amount_cents AS amountCents,
            expense_at AS expenseAt,
            source,
            observation,
            sender_number AS senderNumber,
            status,
            payer_name AS payerName,
            payee_name AS payeeName,
            origin_bank AS originBank,
            destination_bank AS destinationBank,
            dedupe_key AS dedupeKey,
            extra_json AS extraJson,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM expenses
          WHERE group_id = @groupId
          ORDER BY id ASC
        `
      )
      .all({ groupId })
      .map((row) => sanitizeExpenseRow(row))
      .filter(Boolean);

    if (!rows.length) {
      rows = (await readLegacyExpenseRows()).filter((row) => compactSpaces(row.groupId) === groupId);
    }

    if (!rows.length) {
      targetDb.setMeta(migrationKey, '1');
      return;
    }

    const insertTransaction = targetDb.db.transaction((items) => {
      for (const item of items) {
        targetDb.stmtExpenseInsert.run({
          groupId,
          title: normalizeExpenseTitle(item.title, 'Despesa'),
          normalizedTitle: foldText(item.title),
          searchText: normalizeExpenseSearchText(item),
          amountCents: Number(item.amountCents || 0),
          expenseAt: compactSpaces(item.expenseAt) || new Date().toISOString(),
          source: compactSpaces(item.source || 'manual') || 'manual',
          observation: compactSpaces(item.observation),
          senderNumber: compactSpaces(item.senderNumber),
          status: compactSpaces(item.status || 'persistido') || 'persistido',
          payerName: compactSpaces(item.payerName),
          payeeName: compactSpaces(item.payeeName),
          originBank: compactSpaces(item.originBank),
          destinationBank: compactSpaces(item.destinationBank),
          dedupeKey: compactSpaces(item.dedupeKey) || null,
          extraJson: compactSpaces(item.extraJson || '{}') || '{}',
          createdAt: compactSpaces(item.createdAt) || new Date().toISOString(),
          updatedAt: compactSpaces(item.updatedAt) || compactSpaces(item.createdAt) || new Date().toISOString()
        });
      }
    });

    insertTransaction(rows);
    targetDb.setMeta(migrationKey, '1');

    logger.info('Migracao de despesas para banco dedicado do grupo concluida', {
      groupId,
      migratedItems: rows.length,
      database: targetDb.filePath,
      sourceDatabase: this.globalFilePath
    });
  }

  getMeta(key, options = {}) {
    return this.getExistingGroupDb(options.groupId).getMeta(key);
  }

  setMeta(key, value, options = {}) {
    return this.getExistingGroupDb(options.groupId).setMeta(key, value);
  }

  async addItem(collection, text, options = {}) {
    return (await this.getGroupDb(options.groupId)).addItem(collection, text);
  }

  async listItems(collection, limit = 10, options = {}) {
    return (await this.getGroupDb(options.groupId)).listItems(collection, limit);
  }

  async removeItemByIndex(collection, indexOneBased, options = {}) {
    return (await this.getGroupDb(options.groupId)).removeItemByIndex(collection, indexOneBased);
  }

  async updateItemByIndex(collection, indexOneBased, newText, options = {}) {
    return (await this.getGroupDb(options.groupId)).updateItemByIndex(collection, indexOneBased, newText);
  }

  async clearItems(collection, options = {}) {
    return (await this.getGroupDb(options.groupId)).clearItems(collection);
  }

  buildNamedAgendaCollection(nameOrEntry) {
    const source =
      typeof nameOrEntry === 'string'
        ? nameOrEntry
        : nameOrEntry && typeof nameOrEntry === 'object'
          ? nameOrEntry.key || nameOrEntry.name
          : '';
    const key = buildNamedAgendaKey(source);
    return key ? `agenda_named:${key}` : '';
  }

  async ensureNamedAgendas(names = [], options = {}) {
    return (await this.getGroupDb(options.groupId)).ensureNamedAgendas(names);
  }

  async listNamedAgendas(options = {}) {
    return (await this.getGroupDb(options.groupId)).listNamedAgendas();
  }

  async findNamedAgenda(name, options = {}) {
    return (await this.getGroupDb(options.groupId)).findNamedAgenda(name);
  }

  async createNamedAgenda(name, options = {}) {
    return (await this.getGroupDb(options.groupId)).createNamedAgenda(name);
  }

  async deleteNamedAgenda(nameOrEntry, options = {}) {
    return (await this.getGroupDb(options.groupId)).deleteNamedAgenda(nameOrEntry);
  }

  async migrateNamedAgendasToSingleAgenda(options = {}) {
    return (await this.getGroupDb(options.groupId)).migrateNamedAgendasToSingleAgenda();
  }

  async addExpense(input = {}) {
    return (await this.getGroupDb(input.groupId)).addExpense(input);
  }

  async findRecentSimilarExpense(input = {}) {
    return (await this.getGroupDb(input.groupId)).findRecentSimilarExpense(input);
  }

  async getExpenseById(id, groupId = '') {
    return (await this.getGroupDb(groupId)).getExpenseById(id, groupId);
  }

  async deleteExpenseById(input = {}) {
    return (await this.getGroupDb(input.groupId)).deleteExpenseById(input);
  }

  async deleteExpenses(filters = {}) {
    return (await this.getGroupDb(filters.groupId)).deleteExpenses(filters);
  }

  async listExpenses(filters = {}) {
    return (await this.getGroupDb(filters.groupId)).listExpenses(filters);
  }

  async summarizeExpenses(filters = {}) {
    return (await this.getGroupDb(filters.groupId)).summarizeExpenses(filters);
  }

  async countPanelUsers() {
    return this.adminDb.countPanelUsers();
  }

  async listPanelUsers() {
    return this.adminDb.listPanelUsers();
  }

  async getPanelUserById(id) {
    return this.adminDb.getPanelUserById(id);
  }

  async getPanelUserByUsername(username) {
    return this.adminDb.getPanelUserByUsername(username);
  }

  async ensurePanelBootstrapUser(username, password, options = {}) {
    return this.adminDb.ensurePanelBootstrapUser(username, password, options);
  }

  async createPanelUser(username, password) {
    return this.adminDb.createPanelUser(username, password);
  }

  async authenticatePanelUser(username, password) {
    return this.adminDb.authenticatePanelUser(username, password);
  }

  async updatePanelUserPassword(id, password) {
    return this.adminDb.updatePanelUserPassword(id, password);
  }

  async touchPanelUserLogin(id) {
    return this.adminDb.touchPanelUserLogin(id);
  }

  async deletePanelUser(id) {
    return this.adminDb.deletePanelUser(id);
  }

  // --- full_auto_jobs (global, not per-group) ---

  saveFullJob(job) {
    this.adminDb.saveFullJob(job);
  }

  getFullJobById(id) {
    return this.adminDb.getFullJobById(id);
  }

  listFullJobsByAge(options = {}) {
    return this.adminDb.listFullJobsByAge(options);
  }

  clearFullJobs(options = {}) {
    return this.adminDb.clearFullJobs(options);
  }
}

export { SqliteBotDatabase };
export const botDatabase = new BotDatabaseManager();
