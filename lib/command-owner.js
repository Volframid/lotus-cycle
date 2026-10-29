'use strict';

// CommandBase is shared by modules on one connection. Never evict another owner.
const leaseKey = Symbol.for('lotus-cycle.command-owner.v1');
module.exports = function commandOwner(command, dispatch, warn) {
  const primary = 'lotuscycle', alias = 'lotus';
  const base = command.base || command;
  const hooks = base.hooks;
  const inspectable = hooks && typeof hooks.get === 'function' && typeof hooks.has === 'function';
  const token = {}, owned = new Set();
  let active = false, closed = false, notified = '';
  const handler = (...args) => dispatch(...args);
  const owns = name => owned.has(name) && (!inspectable || hooks.get(name) === handler);
  function notify(text) {
    if (notified !== text) { notified = text; warn(text); }
  }
  function register(name) {
    if (owns(name)) return true;
    if (inspectable && hooks.has(name)) return false;
    try { command.add(name, handler); }
    catch (error) {
      if (error && error.message === `Command already registered: ${name}`) return false;
      throw error;
    }
    owned.add(name);
    return true;
  }
  function ready() {
    return !closed && active && base[leaseKey] === token && owns(primary) && owns(alias);
  }
  function reason() {
    if (!active || !owns(primary) || base[leaseKey] !== token)
      return 'Another instance owns lotuscycle. Keep only one Lotus Cycle module enabled.';
    return 'Command lotus is in use by another module. Automatic Lotus is paused. Disable the conflicting module, then use /8 lotuscycle on or /8 lotuscycle reload.';
  }
  function retry() {
    if (!closed && active && base[leaseKey] === token && owns(primary)) register(alias);
    if (ready()) notified = '';
    else notify(reason());
    return ready();
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const name of owned) {
      if (owns(name)) command.remove(name);
      // Toolbox later destroys this wrapper too: don't let its stale Set delete a new owner.
      else if (command.commands && typeof command.commands.delete === 'function') command.commands.delete(name);
    }
    owned.clear();
    if (base[leaseKey] === token) delete base[leaseKey];
    active = false;
  }
  try {
    if (!base[leaseKey] && register(primary)) {
      Object.defineProperty(base, leaseKey, { value: token, configurable: true });
      active = true;
      retry();
    } else notify(reason());
  } catch (error) { close(); throw error; }
  return { active, ready, retry, reason, close };
};
