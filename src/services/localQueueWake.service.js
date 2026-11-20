import { EventEmitter } from 'node:events';

const signals = new EventEmitter();
export const wakeLocalQueue = queue => signals.emit(queue);
export const subscribeLocalQueue = (queue, wake) => {
  signals.on(queue, wake);
  return () => signals.off(queue, wake);
};
