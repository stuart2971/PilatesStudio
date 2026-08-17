/**
 * Tiny JSON-file datastore.
 *
 * Everything the studio owns (users, memberships, bookings, payments) lives in
 * data/db.json. Writes are serialised through a promise chain and land via a
 * temp file + rename so a crash mid-write can never leave a half-written db.
 *
 * Swapping this for Postgres later means reimplementing read()/mutate() only —
 * nothing above this layer touches the file system.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const seed = require('./seed');

let cache = null;
let writeChain = Promise.resolve();

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_FILE)) {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    cache = seed.build();
    fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
  }

  // Catalogue (plans, class types, instructors, weekly grid) is code-owned, so
  // edits to lib/seed.js show up on restart without wiping customer records.
  const fresh = seed.build();
  cache.plans = fresh.plans;
  cache.dropIn = fresh.dropIn;
  cache.classTypes = fresh.classTypes;
  cache.instructors = fresh.instructors;
  cache.scheduleTemplate = fresh.scheduleTemplate;
  cache.studio = fresh.studio;
  if (!cache.secret) cache.secret = crypto.randomBytes(32).toString('hex');

  return cache;
}

function read() {
  return load();
}

function persist() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        const tmp = DB_FILE + '.' + process.pid + '.tmp';
        fs.writeFile(tmp, snapshot, (err) => {
          if (err) {
            console.error('[store] write failed:', err.message);
            return resolve();
          }
          fs.rename(tmp, DB_FILE, (err2) => {
            if (err2) console.error('[store] rename failed:', err2.message);
            resolve();
          });
        });
      })
  );
  return writeChain;
}

/** Mutate the db inside fn, then flush to disk. Returns fn's return value. */
function mutate(fn) {
  const db = load();
  const result = fn(db);
  persist();
  return result;
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

module.exports = { read, mutate, id, DB_FILE };
