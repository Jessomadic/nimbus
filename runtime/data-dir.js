import path from 'node:path';
// The Nimbus data folder. Shared by modules that must not open the database
// just to find it (db.js opens nimbus.db on import).
export const DATA_DIR = path.resolve(process.env.NIMBUS_DATA || './data');
