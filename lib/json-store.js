'use strict';

const path = require('path');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

function decode(raw) {
  if (typeof raw === 'string') return raw.replace(/^\uFEFF/, '');
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    const data = Buffer.from(raw.subarray(2));
    if (data.length % 2) throw new Error('Truncated UTF-16 data.');
    data.swap16();
    return data.toString('utf16le');
  }
  // Some Windows editors save UTF-16 without a byte-order mark.
  if (raw.length >= 2 && raw[1] === 0 && /[\s{[]/.test(String.fromCharCode(raw[0])))
    return raw.toString('utf16le');
  if (raw.length >= 2 && raw[0] === 0 && /[\s{[]/.test(String.fromCharCode(raw[1]))) {
    const data = Buffer.from(raw);
    if (data.length % 2) throw new Error('Truncated UTF-16 data.');
    data.swap16();
    return data.toString('utf16le');
  }
  return raw.toString('utf8').replace(/^\uFEFF/, '');
}

function validateState(data) {
  if (!object(data)) throw new Error('State must be a JSON object.');
  for (const state of Object.values(data)) {
    if (!object(state)) throw new Error('Invalid character state.');
    for (const field of ['buffs', 'cooldowns', 'reuse']) {
      if (state[field] === undefined) continue;
      if (!object(state[field]) || Object.values(state[field]).some(value => !Number.isFinite(value) || value < 0))
        throw new Error(`Invalid saved ${field}.`);
    }
    if (state.knownCooldowns !== undefined && (!Array.isArray(state.knownCooldowns) ||
        state.knownCooldowns.some(id => !Number.isSafeInteger(id) || id <= 0)))
      throw new Error('Invalid saved knownCooldowns.');
    if (state.armed !== undefined && typeof state.armed !== 'boolean') throw new Error('Invalid saved armed flag.');
    if (state.last !== undefined && state.last !== null && typeof state.last !== 'string') throw new Error('Invalid saved Lotus key.');
  }
  return data;
}

function createStore({ fs, warn = () => {} }) {
  let backupSerial = 0;
  function write(file, data) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(file + '.tmp', file);
  }
  function read(file, fallback, { validate = value => value, recover = false } = {}) {
    let raw;
    try { raw = fs.readFileSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return validate(clone(fallback));
      throw new Error(`Cannot read ${path.basename(file)}: ${error.message}`);
    }
    try { return validate(JSON.parse(decode(raw))); }
    catch (error) {
      const reason = `Invalid ${path.basename(file)}: ${error.message}`;
      if (!recover) throw new Error(reason);
      // Preserve the exact bytes before replacing an unusable local file.
      const backup = file + '.invalid-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + (++backupSerial) + '.bak';
      try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
      catch (backupError) { throw new Error(`${reason} Original file kept; backup failed: ${backupError.message}`); }
      const restored = validate(clone(fallback));
      try { write(file, restored); }
      catch (writeError) { throw new Error(`${reason} Backup: ${backup}. Recovery write failed: ${writeError.message}`); }
      warn(`${reason} Backup: ${backup}. ${path.basename(file) === 'state.json' ? 'Saved timers reset; real server buffs/cooldowns will rebuild them.' : 'Default configuration restored.'}`);
      return restored;
    }
  }
  return { read, write };
}

module.exports = { createStore, decode, validateState };
