import { randomBytes } from 'node:crypto';
import { botDatabase } from './botDatabase.js';
import { logger } from './logger.js';

const SESSION_COOKIE_NAME = 'panel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(headerValue) {
  const cookies = new Map();

  for (const part of String(headerValue || '').split(';')) {
    const [rawKey, ...rawValue] = part.split('=');
    const key = String(rawKey || '').trim();
    if (!key) continue;
    cookies.set(key, rawValue.join('=').trim());
  }

  return cookies;
}

export class PanelAuthService {
  constructor() {
    this.sessions = new Map();
  }

  getSessionCookieName() {
    return SESSION_COOKIE_NAME;
  }

  getSessionToken(req) {
    const cookies = parseCookies(req?.headers?.cookie || '');
    return String(cookies.get(SESSION_COOKIE_NAME) || '').trim();
  }

  buildSessionCookie(token, expiresAt) {
    const maxAgeSeconds = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    return [
      `${SESSION_COOKIE_NAME}=${token}`,
      'HttpOnly',
      'Path=/',
      `Max-Age=${maxAgeSeconds}`,
      'SameSite=Lax'
    ].join('; ');
  }

  buildExpiredCookie() {
    return [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'Max-Age=0', 'SameSite=Lax'].join('; ');
  }

  setSessionCookie(res, token, expiresAt) {
    res.setHeader('Set-Cookie', this.buildSessionCookie(token, expiresAt));
  }

  clearSessionCookie(res) {
    res.setHeader('Set-Cookie', this.buildExpiredCookie());
  }

  createSession(user) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;

    this.sessions.set(token, {
      token,
      userId: Number(user.id),
      username: String(user.username || '').trim(),
      expiresAt
    });

    return {
      token,
      expiresAt
    };
  }

  async login(username, password) {
    const authResult = await botDatabase.authenticatePanelUser(username, password);
    if (!authResult.ok || !authResult.user) {
      logger.warn('Falha de login no painel web', {
        username: String(username || '').trim().toLowerCase() || '(vazio)'
      });
      return authResult;
    }

    await botDatabase.touchPanelUserLogin(authResult.user.id);
    const user = await botDatabase.getPanelUserById(authResult.user.id);
    const session = this.createSession(user || authResult.user);

    logger.info('Login no painel web realizado', {
      username: authResult.user.username
    });

    return {
      ok: true,
      user: user || authResult.user,
      sessionToken: session.token,
      expiresAt: session.expiresAt
    };
  }

  async getAuthenticatedUser(req) {
    const token = this.getSessionToken(req);
    if (!token) return null;

    const session = this.sessions.get(token);
    if (!session) return null;

    if (Number(session.expiresAt || 0) <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }

    const user = await botDatabase.getPanelUserById(session.userId);
    if (!user) {
      this.sessions.delete(token);
      return null;
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return user;
  }

  async logout(req, res) {
    const token = this.getSessionToken(req);
    if (token) {
      this.sessions.delete(token);
    }

    this.clearSessionCookie(res);
  }

  invalidateUserSessions(userId, options = {}) {
    const numericId = Number(userId);
    const exceptToken = String(options.exceptToken || '').trim();

    for (const [token, session] of this.sessions.entries()) {
      if (Number(session.userId) !== numericId) continue;
      if (exceptToken && token === exceptToken) continue;
      this.sessions.delete(token);
    }
  }
}

export const panelAuth = new PanelAuthService();
