import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeGroupId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/@g\.us$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@g.us` : '';
}

function senderMatchesAllowed(senderNumber, allowed) {
  if (!senderNumber || !allowed) return false;
  return senderNumber === allowed || senderNumber.endsWith(allowed) || allowed.endsWith(senderNumber);
}

const defaultState = () => ({
  authorizedExtra: [],
  adminExtra: [],
  fullExtra: [],
  privateExtra: [],
  responseGroupExtra: [],
  updatedAt: new Date().toISOString()
});

export class AccessControl {
  constructor(filePath = 'data/access-control.json') {
    this.filePath = filePath;
    this.state = defaultState();
    this.ready = this.load();
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') {
        this.state = defaultState();
        return;
      }

      const authorizedExtra = Array.isArray(parsed.authorizedExtra)
        ? Array.from(new Set(parsed.authorizedExtra.map((item) => normalizePhoneNumber(item)).filter(Boolean)))
        : [];
      const adminExtra = Array.isArray(parsed.adminExtra)
        ? Array.from(new Set(parsed.adminExtra.map((item) => normalizePhoneNumber(item)).filter(Boolean)))
        : [];
      const fullExtra = Array.isArray(parsed.fullExtra)
        ? Array.from(new Set(parsed.fullExtra.map((item) => normalizePhoneNumber(item)).filter(Boolean)))
        : [];
      const privateExtra = Array.isArray(parsed.privateExtra)
        ? Array.from(new Set(parsed.privateExtra.map((item) => normalizePhoneNumber(item)).filter(Boolean)))
        : [];
      const responseGroupExtra = Array.isArray(parsed.responseGroupExtra)
        ? Array.from(new Set(parsed.responseGroupExtra.map((item) => normalizeGroupId(item)).filter(Boolean)))
        : [];

      this.state = {
        authorizedExtra,
        adminExtra,
        fullExtra,
        privateExtra,
        responseGroupExtra,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
      };
    } catch {
      this.state = defaultState();
      await this.save();
    }
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.state.updatedAt = new Date().toISOString();
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  async withLock(task) {
    this.chain = this.chain
      .catch(() => {
        // Mantem fila.
      })
      .then(task);
    return this.chain;
  }

  async ensureReady() {
    await this.ready;
  }

  staticAuthorized() {
    return config.allowAllSenders ? [] : [...config.authorizedSenderNumbers];
  }

  staticAdmins() {
    return config.allowAllAdmins ? [] : [...config.adminSenderNumbers];
  }

  staticFulls() {
    return config.allowAllFulls ? [] : [...config.fullSenderNumbers];
  }

  allAuthorizedNumbers() {
    const combined = new Set([...this.staticAuthorized(), ...this.state.authorizedExtra, ...this.allAdminNumbers()]);
    return Array.from(combined);
  }

  extraAuthorizedNumbers() {
    return [...this.state.authorizedExtra];
  }

  allAdminNumbers() {
    const combined = new Set([...this.staticAdmins(), ...this.state.adminExtra, ...this.allFullNumbers()]);
    return Array.from(combined);
  }

  extraAdminNumbers() {
    return [...this.state.adminExtra];
  }

  allFullNumbers() {
    const combined = new Set([...this.staticFulls(), ...this.state.fullExtra]);
    return Array.from(combined);
  }

  extraFullNumbers() {
    return [...this.state.fullExtra];
  }

  allPrivateNumbers() {
    return [...this.state.privateExtra];
  }

  extraPrivateNumbers() {
    return [...this.state.privateExtra];
  }

  allResponseGroupIds(primaryGroupId = '') {
    const primary = normalizeGroupId(primaryGroupId);
    const combined = new Set(primary ? [primary] : []);
    for (const groupId of this.state.responseGroupExtra) {
      const normalized = normalizeGroupId(groupId);
      if (normalized) combined.add(normalized);
    }
    return Array.from(combined);
  }

  extraResponseGroupIds() {
    return [...this.state.responseGroupExtra];
  }

  snapshot(primaryGroupId = '') {
    const primary = normalizeGroupId(primaryGroupId);
    return {
      allowAllSenders: config.allowAllSenders,
      allowAllAdmins: config.allowAllAdmins,
      allowAllFulls: config.allowAllFulls,
      staticAuthorized: this.staticAuthorized(),
      staticAdmins: this.staticAdmins(),
      staticFulls: this.staticFulls(),
      dynamicAuthorized: this.extraAuthorizedNumbers(),
      dynamicAdmins: this.extraAdminNumbers(),
      dynamicFulls: this.extraFullNumbers(),
      dynamicPrivate: this.extraPrivateNumbers(),
      dynamicResponseGroups: this.extraResponseGroupIds(),
      effectiveAuthorized: this.allAuthorizedNumbers(),
      effectiveAdmins: this.allAdminNumbers(),
      effectiveFulls: this.allFullNumbers(),
      effectivePrivate: this.allPrivateNumbers(),
      primaryGroupId: primary || null,
      effectiveResponseGroups: this.allResponseGroupIds(primary),
      updatedAt: this.state.updatedAt
    };
  }

  isAuthorized(senderNumber) {
    const normalized = normalizePhoneNumber(senderNumber);
    if (!normalized) return false;
    if (config.allowAllSenders) return true;
    if (this.isAdmin(normalized)) return true;

    const all = this.allAuthorizedNumbers();
    return all.some((allowed) => senderMatchesAllowed(normalized, allowed));
  }

  isFull(senderNumber) {
    const normalized = normalizePhoneNumber(senderNumber);
    if (!normalized) return false;
    if (config.allowAllFulls) return true;

    const all = this.allFullNumbers();
    return all.some((allowed) => senderMatchesAllowed(normalized, allowed));
  }

  isPrivateAllowed(senderNumber) {
    const normalized = normalizePhoneNumber(senderNumber);
    if (!normalized) return false;

    const all = this.allPrivateNumbers();
    return all.some((allowed) => senderMatchesAllowed(normalized, allowed));
  }

  isResponseGroupAllowed(groupId, primaryGroupId = '') {
    const normalized = normalizeGroupId(groupId);
    if (!normalized) return false;
    return this.allResponseGroupIds(primaryGroupId).includes(normalized);
  }

  isAdmin(senderNumber) {
    const normalized = normalizePhoneNumber(senderNumber);
    if (!normalized) return false;
    if (this.isFull(normalized)) return true;
    if (config.allowAllAdmins) return true;

    const all = this.allAdminNumbers();
    return all.some((allowed) => senderMatchesAllowed(normalized, allowed));
  }

  async addAuthorized(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { added: false, reason: 'invalid', number: '' };
    if (this.allAuthorizedNumbers().includes(normalized)) return { added: false, reason: 'exists', number: normalized };

    return this.withLock(async () => {
      this.state.authorizedExtra = Array.from(new Set([...this.state.authorizedExtra, normalized]));
      await this.save();
      return { added: true, number: normalized };
    });
  }

  async removeAuthorized(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { removed: false, reason: 'invalid', number: '' };

    return this.withLock(async () => {
      const before = this.state.authorizedExtra.length;
      this.state.authorizedExtra = this.state.authorizedExtra.filter((item) => item !== normalized);
      const removed = before !== this.state.authorizedExtra.length;
      if (removed) await this.save();
      return { removed, number: normalized };
    });
  }

  async addAdmin(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { added: false, reason: 'invalid', number: '' };
    if (this.allAdminNumbers().includes(normalized)) return { added: false, reason: 'exists', number: normalized };

    return this.withLock(async () => {
      this.state.adminExtra = Array.from(new Set([...this.state.adminExtra, normalized]));
      if (!this.isAuthorized(normalized)) {
        this.state.authorizedExtra = Array.from(new Set([...this.state.authorizedExtra, normalized]));
      }
      await this.save();
      return { added: true, number: normalized };
    });
  }

  async removeAdmin(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { removed: false, reason: 'invalid', number: '' };

    return this.withLock(async () => {
      const before = this.state.adminExtra.length;
      this.state.adminExtra = this.state.adminExtra.filter((item) => item !== normalized);
      const removed = before !== this.state.adminExtra.length;
      if (removed) await this.save();
      return { removed, number: normalized };
    });
  }

  async addFull(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { added: false, reason: 'invalid', number: '' };
    if (this.allFullNumbers().includes(normalized)) return { added: false, reason: 'exists', number: normalized };

    return this.withLock(async () => {
      this.state.fullExtra = Array.from(new Set([...this.state.fullExtra, normalized]));
      await this.save();
      return { added: true, number: normalized };
    });
  }

  async removeFull(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { removed: false, reason: 'invalid', number: '' };

    return this.withLock(async () => {
      const before = this.state.fullExtra.length;
      this.state.fullExtra = this.state.fullExtra.filter((item) => item !== normalized);
      const removed = before !== this.state.fullExtra.length;
      if (removed) await this.save();
      return { removed, number: normalized };
    });
  }

  async addPrivate(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { added: false, reason: 'invalid', number: '' };
    if (this.allPrivateNumbers().includes(normalized)) return { added: false, reason: 'exists', number: normalized };

    return this.withLock(async () => {
      this.state.privateExtra = Array.from(new Set([...this.state.privateExtra, normalized]));
      await this.save();
      return { added: true, number: normalized };
    });
  }

  async removePrivate(number) {
    await this.ensureReady();
    const normalized = normalizePhoneNumber(number);
    if (!normalized) return { removed: false, reason: 'invalid', number: '' };

    return this.withLock(async () => {
      const before = this.state.privateExtra.length;
      this.state.privateExtra = this.state.privateExtra.filter((item) => item !== normalized);
      const removed = before !== this.state.privateExtra.length;
      if (removed) await this.save();
      return { removed, number: normalized };
    });
  }

  async addResponseGroup(groupId) {
    await this.ensureReady();
    const normalized = normalizeGroupId(groupId);
    if (!normalized) return { added: false, reason: 'invalid', groupId: '' };
    if (this.state.responseGroupExtra.includes(normalized)) {
      return { added: false, reason: 'exists', groupId: normalized };
    }

    return this.withLock(async () => {
      this.state.responseGroupExtra = Array.from(new Set([...this.state.responseGroupExtra, normalized]));
      await this.save();
      return { added: true, groupId: normalized };
    });
  }

  async removeResponseGroup(groupId) {
    await this.ensureReady();
    const normalized = normalizeGroupId(groupId);
    if (!normalized) return { removed: false, reason: 'invalid', groupId: '' };

    return this.withLock(async () => {
      const before = this.state.responseGroupExtra.length;
      this.state.responseGroupExtra = this.state.responseGroupExtra.filter((item) => item !== normalized);
      const removed = before !== this.state.responseGroupExtra.length;
      if (removed) await this.save();
      return { removed, groupId: normalized };
    });
  }
}

export const accessControl = new AccessControl('data/access-control.json');
export { normalizeGroupId, normalizePhoneNumber };
