/** @aegis/census/alerts — Telegram alerts domain (pure). IO adapters live in @aegis/census/node. */
export * from './model.js';
export { observe, levelOf, worstNadoBuffer } from './observe.js';
export { evaluate, admit, rateAllow, dedupKey } from './engine.js';
export { formatAlert, eventLine, riskLine, provenance, watchLine, ageText } from './format.js';
export { parseCommand, handleCommand, HELP_TEXT, COMMANDS, type Command, type CommandDeps, type Parsed } from './commands.js';
export { TestTransport, type AlertsTransport, type IncomingMessage, type SendResult } from './transport.js';
export { runAlerts, unreadableObservation, type RunDeps, type RunReport } from './run.js';
export { FOOTER_TEXT } from './text.js';
