import { EventEmitter } from 'node:events';

export const stateEvents = new EventEmitter();

const state = {
  whatsappStatus: 'iniciando',
  qrDataUrl: null,
  lastError: null,
  startedAt: new Date().toISOString()
};

export function getRuntimeState() {
  return { ...state };
}

export function updateRuntimeState(partial) {
  Object.assign(state, partial);
  stateEvents.emit('state', getRuntimeState());
}
