// Entrypoint. Start with: node server.js
//
// Deliberately tiny: it installs logging and NOTHING else, then imports the app
// dynamically. ESM hoists static imports, so anything imported here directly
// would be evaluated BEFORE the first line of this file runs — and a module
// that throws while initialising (an unreadable config.json, a locked SQLite
// file, a port already taken) is precisely the crash that used to leave no
// evidence at all on a Mac started by double-clicking.

import { initLogging, log } from './src/logger.js';

const { logPath } = initLogging();

try {
  await import('./src/app.js');
} catch (err) {
  log('app').error('failed to start — the app did not come up', err);
  process.stderr.write(`\nStartup failed. The reason is in ${logPath}\n`);
  process.exit(1);
}
