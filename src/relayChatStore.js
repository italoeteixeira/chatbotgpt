import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE_PATH = join(process.cwd(), 'data', 'relay-chats.json');

let _ready = false;
let _data = { relays: [] };

async function load() {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    _data = { relays: Array.isArray(parsed?.relays) ? parsed.relays : [] };
  } catch {
    _data = { relays: [] };
  }
  _ready = true;
}

async function save() {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(_data, null, 2), 'utf-8');
}

export const relayChatStore = {
  async ensureReady() {
    if (!_ready) await load();
  },

  async addRelay({ targetNumber, targetJid, groupId, requestedBy }) {
    await this.ensureReady();
    _data.relays = _data.relays.map((r) =>
      r.targetNumber === targetNumber && r.groupId === groupId ? { ...r, active: false } : r
    );
    const relay = {
      id: randomUUID(),
      targetNumber,
      targetJid,
      groupId,
      requestedBy: requestedBy || '',
      active: true,
      createdAt: new Date().toISOString(),
      forwardedMessageIds: []
    };
    _data.relays.push(relay);
    await save();
    return relay;
  },

  async stopRelay({ targetNumber, groupId }) {
    await this.ensureReady();
    const n = String(targetNumber || '').replace(/\D/g, '');
    let stopped = false;
    _data.relays = _data.relays.map((r) => {
      const s = String(r.targetNumber || '').replace(/\D/g, '');
      const matches = s === n || s.endsWith(n) || n.endsWith(s);
      if (r.active && matches && (!groupId || r.groupId === groupId)) {
        stopped = true;
        return { ...r, active: false };
      }
      return r;
    });
    if (stopped) await save();
    return stopped;
  },

  async findActiveByTarget(targetNumber) {
    await this.ensureReady();
    const n = String(targetNumber || '').replace(/\D/g, '');
    return (
      _data.relays.find(
        (r) =>
          r.active &&
          (() => {
            const s = String(r.targetNumber || '').replace(/\D/g, '');
            return s === n || s.endsWith(n) || n.endsWith(s);
          })()
      ) || null
    );
  },

  async findActiveByGroupId(groupId) {
    await this.ensureReady();
    return _data.relays.filter((r) => r.active && r.groupId === groupId);
  },

  async addForwardedMessageId(relayId, messageId) {
    await this.ensureReady();
    _data.relays = _data.relays.map((r) => {
      if (r.id !== relayId) return r;
      const ids = Array.isArray(r.forwardedMessageIds) ? r.forwardedMessageIds : [];
      return { ...r, forwardedMessageIds: [...ids.slice(-49), messageId] };
    });
    await save();
  },

  async findRelayByForwardedMessageId(messageId, groupId) {
    await this.ensureReady();
    return (
      _data.relays.find(
        (r) =>
          r.active &&
          (!groupId || r.groupId === groupId) &&
          Array.isArray(r.forwardedMessageIds) &&
          r.forwardedMessageIds.includes(messageId)
      ) || null
    );
  },

  async listActive(groupId) {
    await this.ensureReady();
    return _data.relays.filter((r) => r.active && (!groupId || r.groupId === groupId));
  }
};
