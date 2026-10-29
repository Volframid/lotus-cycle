'use strict';

// Read existing Toolbox bookkeeping only. Do not load modules or touch callbacks.
const clean = value => String(value || '').replace(/[<>\x00-\x1f\x7f]/g, '').slice(0, 100);
module.exports = function commandDiagnostic(mod, name = 'lotus') {
  if (name !== 'lotus' && name !== 'lotuscycle') return { available: false, candidates: [] };
  try {
    const registry = mod.manager && mod.manager.loadedMods;
    const own = mod.command;
    const base = own && own.base;
    const present = base && base.hooks && typeof base.hooks.has === 'function' ? base.hooks.has(name) : null;
    if (!registry || typeof registry.values !== 'function' || !base)
      return { available: false, commandPresent: present, candidates: [] };
    const candidates = [];
    for (const loaded of registry.values()) {
      // Never read the lazy .command/.require accessors: they can create instances.
      const network = loaded && loaded.networkInstances && typeof loaded.networkInstances.get === 'function'
        ? loaded.networkInstances.get(mod.dispatch) : null;
      const descriptor = network && Object.getOwnPropertyDescriptor(network, '_command');
      const instance = descriptor && descriptor.value;
      if (!instance || instance.base !== base || !instance.commands || typeof instance.commands.values !== 'function') continue;
      if (!Array.from(instance.commands.values()).some(command => typeof command === 'string' && command.toLowerCase() === name)) continue;
      const info = loaded.info || {};
      candidates.push({ id: clean(info.name), name: clean(info.options && (info.options.niceName || info.options.cliName) || info.rawName || info.name),
        folder: clean(String(info.path || '').split(/[\\/]/).filter(Boolean).pop()) });
    }
    // Sets can be stale after another module edits the shared registry directly.
    // Report claims as candidates instead of certifying an unknown callback owner.
    return { available: true, commandPresent: present, candidates };
  } catch (_) { return { available: false, candidates: [] }; }
};
