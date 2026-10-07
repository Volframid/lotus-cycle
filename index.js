'use strict';

const fs = require('fs'), path = require('path');
const Cycle = require('./lib/cycle');
const Followup = require('./lib/followup');
module.exports = function LotusCycle(mod) {
  mod.game.initialize(['me.abnormalities', 'contract']);
  const configFile = path.join(__dirname, 'config.json'), stateFile = path.join(__dirname, 'state.json');
  let config = load(), stored = read(stateFile, {}), character = null;
  let location = null, facing = 0, action = null, inputUntil = 0, inputSkill = null, activityTimer = null, bootTimer = null, bootUntil = 0;
  let sending = false, logFile = null, actionSkill = null, knownSkills = [];
  let clientIntent = 0, consumedIntent = 0;
  let autoDisplayRequest = null;
  let blockSkills = [], blockListSeen = false, manualBlockHeld = false;
  const blockIds = { lancer: [20100, 20200, 20230, 20240], berserker: [20100, 20200, 20230, 20231, 20300] };
  const hiddenBlockActions = new Map();
  let transitionLoading = mod.game.isInLoadingScreen, removalTimer = null;
  const pendingRemovals = new Map(), removalConfirmMs = 250;
  const hiddenLotusActions = new Map();
  const premiumSlots = new Map(), activity = [];
  const seenServerActions = new Set();
  let premiumListSeen = false;
  const native = { order: -9000006, filter: { fake: false, modified: null, silenced: null } };
  const message = text => mod.command.message(`[Lotus Cycle] ${text}`);
  const skillId = packet => typeof packet.skill === 'number' ? packet.skill : packet.skill?.id;
  const effectForSkill = id => config.effects.find(effect => effect.skillId === id);
  const sessionAvailable = () => mod.game.isIngame && !transitionLoading && !mod.game.isInLoadingScreen &&
    pendingRemovals.size === 0 && mod.game.me.alive &&
    !mod.game.me.mounted && !mod.game.contract.active && location !== null && Date.now() >= bootUntil;
  const followup = new Followup({ config: () => config.fastTransition, now: Date.now,
    setTimeout: (fn, ms) => mod.setTimeout(fn, ms), clearTimeout: id => mod.clearTimeout(id), record,
    intent: () => clientIntent, match: (a, b) => a === b,
    canSend: window => config.enabled && sessionAvailable() && (engine.buffs.get(window.buffId) || 0) > Date.now() &&
      !window.block?.pending &&
      (action === window.actionId || window.endAt !== null && action === null),
    blockRoute,
    sendBlock: id => {
      // Same native press/release construction, using this module's fresh position.
      const packet = { skill: { id, type: 1, npc: false, reserved: 0, huntingZoneId: 0 },
        loc: { x: location.x, y: location.y, z: location.z }, w: facing };
      const result = { pressForwarded: false, releaseForwarded: false };
      record('LOTUS_BLOCK_PACKET', { name: 'C_PRESS_SKILL', version: 4,
        pressPacket: { ...packet, press: true }, releasePacket: { ...packet, press: false } });
      sending = true;
      try {
        try { result.pressForwarded = mod.toServer('C_PRESS_SKILL', 4, { ...packet, press: true }) === true; }
        catch (error) { result.pressError = error.message; }
      } finally {
        // Always attempt release, even if another hook blocked or threw on press.
        try { result.releaseForwarded = mod.toServer('C_PRESS_SKILL', 4, { ...packet, press: false }) === true; }
        catch (error) { result.releaseError = error.message; }
        finally { sending = false; }
      }
      return result;
    },
    send: (name, version, packet) => {
      sending = true;
      try { return mod.toServer(name, version, packet); }
      finally { sending = false; }
    }
  });
  function blockRoute() {
    const job = mod.game.me.class, ids = blockIds[job];
    if (!config.fastTransition.blockCancel.enabled || !ids || manualBlockHeld) return null;
    // Use the learned base rank; variants belong to native acknowledgement only.
    const ranks = job === 'berserker' ? [20300, 20200, 20100] : [20200, 20100];
    const id = blockListSeen ? ranks.find(rank => blockSkills.includes(rank)) : 20200;
    return id ? { class: job, skillId: id, skillIds: ids } : null;
  }
  const engine = new Cycle({ config, now: Date.now,
    setTimeout: (fn, ms) => mod.setTimeout(fn, ms), clearTimeout: id => mod.clearTimeout(id), record,
    available: () => sessionAvailable() && action === null && inputUntil <= Date.now(),
    retryWhenBusy: sessionAvailable,
    send: effect => {
      followup.begin(effect);
      autoDisplayRequest = config.hideAutoAnimation ? { skillId: effect.skillId,
        until: Date.now() + config.acknowledgementMs } : null;
      const slot = premiumSlots.get(effect.key)?.id === effect.skillId ? premiumSlots.get(effect.key) : null;
      if (slot) {
        const packet = { set: slot.set, slot: slot.slot, type: 3, id: slot.id };
        record('AUTO_LOTUS_PACKET', { name: 'C_USE_PREMIUM_SLOT', version: 1, route: 'server-premium-slot',
          packet, state: snapshot() });
        return forward('C_USE_PREMIUM_SLOT', 1, packet, effect.key);
      }
      // Exact native C_START_SKILL fields observed in both accepted manual casts; fresh position/facing.
      const packet = { skill: { id: effect.skillId, type: 1, npc: false, reserved: 0, huntingZoneId: 0 },
        loc: { x: location.x, y: location.y, z: location.z }, w: facing, dest: { x: 0, y: 0, z: 0 },
        unk: true, moving: false, continue: false, target: 0n, unk2: false };
      record('AUTO_LOTUS_PACKET', { name: 'C_START_SKILL', version: 7, route: 'direct-skill', packet, state: snapshot() });
      return forward('C_START_SKILL', 7, packet, effect.key);
    }
  });
  function forward(name, version, packet, kind) {
    sending = true;
    try {
      const result = mod.toServer(name, version, packet);
      if (result === false) { autoDisplayRequest = null; followup.reset('lotus-send-blocked'); }
      record('AUTO_LOTUS_TRANSPORT', { kind, name, forwarded: result === true,
        result: typeof result === 'boolean' ? result : 'unknown' });
      return result;
    } catch (error) {
      autoDisplayRequest = null; followup.reset('lotus-send-error'); throw error;
    } finally { sending = false; }
  }
  function observeActivity(name, packet) {
    if (!logFile) return;
    const entry = { at: Date.now(), name, skill: skillId(packet) ?? null,
      actionId: packet.id ?? null, press: packet.press ?? null, type: packet.type ?? null, fake: packet.$fake === true };
    activity.push(entry);
    while (activity.length > 32 || activity[0]?.at < Date.now() - 15000) activity.shift();
    if (followup.window || engine.pending && Date.now() <= engine.pending.until + 2000)
      record('LOTUS_NEARBY_ACTIVITY', entry);
  }
  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  function inputMatchesAction(id, alreadySeenAction) {
    if (inputSkill === null) return false;
    // A repeated stage of an older action cannot acknowledge a new alias input.
    if (alreadySeenAction) return false;
    return inputSkill === id;
  }
  function load() {
    const data = read(configFile, null);
    if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.effects) || data.effects.length !== 2 ||
        !data.effects.some(e => e.key === data.first)) throw new Error('Invalid Lotus Cycle config.');
    const ids = new Set(), keys = new Set();
    for (const effect of data.effects) {
      if (typeof effect.key !== 'string' || keys.has(effect.key)) throw new Error('Invalid Lotus keys.');
      keys.add(effect.key);
      for (const field of ['skillId', 'buffId', 'cooldownId']) {
        if (!Number.isInteger(effect[field]) || effect[field] <= 0 || ids.has(effect[field])) throw new Error('Invalid/duplicate Lotus ID.');
        ids.add(effect[field]);
      }
    }
    for (const [key, min, max] of [['acknowledgementMs', 500, 5000], ['retryDelayMs', 500, 5000]])
      if (!Number.isInteger(data[key]) || data[key] < min || data[key] > max) throw new Error(`Invalid ${key}.`);
    delete data.maxAttempts; // Old configs cannot reintroduce the removed attempt cap.
    data.hideAutoAnimation ??= true;
    if (typeof data.hideAutoAnimation !== 'boolean') throw new Error('Invalid hideAutoAnimation.');
    data.fastTransition ??= { enabled: true, delayAfterBuffMs: 0 };
    data.fastTransition.cancelAfterBuff ??= true;
    // Trial value, not a verified Lotus cancellation mode; live action ends decide success.
    data.fastTransition.cancelType ??= 0;
    data.fastTransition.blockCancel ??= { enabled: true, delayAfterBuffMs: 100 };
    if (typeof data.fastTransition.blockCancel.enabled !== 'boolean' ||
        !Number.isInteger(data.fastTransition.blockCancel.delayAfterBuffMs) ||
        data.fastTransition.blockCancel.delayAfterBuffMs < 0 || data.fastTransition.blockCancel.delayAfterBuffMs > 400)
      throw new Error('Invalid blockCancel settings.');
    if (typeof data.fastTransition.enabled !== 'boolean' || !Number.isInteger(data.fastTransition.delayAfterBuffMs) ||
        data.fastTransition.delayAfterBuffMs < 0 || data.fastTransition.delayAfterBuffMs > 400 ||
        typeof data.fastTransition.cancelAfterBuff !== 'boolean' || !Number.isInteger(data.fastTransition.cancelType) ||
        data.fastTransition.cancelType < 0 || data.fastTransition.cancelType > 2147483647)
      throw new Error('Invalid fastTransition settings.');
    return data;
  }
  function save(file, data) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n'); fs.renameSync(file + '.tmp', file);
  }
  function record(stage, data = {}) {
    if (!logFile) return;
    try { fs.appendFileSync(logFile, JSON.stringify({ utc: new Date().toISOString(), stage, character, ...data },
      (_, value) => typeof value === 'bigint' ? value.toString() : value) + '\n'); }
    catch (error) { logFile = null; mod.error(error.message); }
  }
  function persist() {
    if (!character) return;
    const future = map => Object.fromEntries([...map].filter(([, until]) => until > Date.now()));
    stored[character] = { buffs: future(engine.buffs), cooldowns: future(engine.cooldowns), reuse: future(engine.reuse),
      last: engine.last, armed: engine.armed, knownCooldowns: [...engine.knownCooldowns] };
    try { save(stateFile, stored); } catch (error) { mod.error(`Lotus state save failed: ${error.message}`); }
  }
  function clearRemovalTimer() {
    if (removalTimer !== null) mod.clearTimeout(removalTimer);
    removalTimer = null;
  }
  function queueRemovalConfirmation() {
    clearRemovalTimer();
    if (!pendingRemovals.size || transitionLoading || mod.game.isInLoadingScreen || !mod.game.isIngame) return;
    const deadline = Math.max(bootUntil, Math.min(...pendingRemovals.values()));
    removalTimer = mod.setTimeout(confirmRemovals, Math.max(1, deadline - Date.now()));
  }
  function confirmRemovals() {
    clearRemovalTimer();
    if (transitionLoading || mod.game.isInLoadingScreen || !mod.game.isIngame) return;
    for (const [id, deadline] of pendingRemovals) {
      if (deadline > Date.now() || bootUntil > Date.now()) continue;
      const remaining = Number(mod.game.me.abnormalities?.[id]?.remaining);
      pendingRemovals.delete(id);
      if (Number.isFinite(remaining) && remaining > 0 && remaining <= 86400000) {
        engine.buff(id, remaining);
        record('LOTUS_REMOVAL_REBOUND', { id, remaining, source: 'native-cache' });
      } else {
        engine.end(id); followup.buffEnded(id);
        record('LOTUS_REMOVAL_CONFIRMED', { id });
      }
    }
    persist(); queueRemovalConfirmation(); engine.wake();
  }
  function update(name, packet) {
    if (packet.target !== mod.game.me.gameId) return;
    if ([97950017, 99950017].includes(packet.id)) {
      record('LOTUS_COSMETIC_AURA', { event: name, id: packet.id, duration: packet.duration }); return;
    }
    if (!config.effects.some(e => e.buffId === packet.id || e.cooldownId === packet.id)) return;
    record(name, { id: packet.id, duration: packet.duration });
    const duration = Number(packet.duration);
    if (name === 'S_ABNORMALITY_END') {
      const until = engine.buffs.get(packet.id) || engine.cooldowns.get(packet.id) || 0;
      // Zone teardown can remove a live buff before the loading event arrives.
      // Preserve its real deadline; an ordinary expiry needs no extra delay.
      if (until > Date.now() || transitionLoading || mod.game.isInLoadingScreen) {
        if (!pendingRemovals.has(packet.id)) pendingRemovals.set(packet.id,
          Math.min(until > Date.now() ? until : Infinity, Date.now() + removalConfirmMs));
        followup.reset('lotus-removal-pending');
        record('LOTUS_REMOVAL_PENDING', { id: packet.id, until });
        queueRemovalConfirmation(); engine.wake();
      } else { engine.end(packet.id); followup.buffEnded(packet.id); }
    }
    else if (Number.isFinite(duration) && duration > 0 && duration <= 86400000) {
      if (pendingRemovals.delete(packet.id)) record('LOTUS_REMOVAL_REBOUND', { id: packet.id, remaining: duration, source: 'native-packet' });
      engine.buff(packet.id, duration); followup.buff(packet.id);
      queueRemovalConfirmation();
    }
    persist();
  }
  mod.hook('S_ABNORMALITY_BEGIN', mod.majorPatchVersion <= 106 ? 4 : 5, native, packet => update('S_ABNORMALITY_BEGIN', packet));
  mod.hook('S_ABNORMALITY_REFRESH', 2, native, packet => update('S_ABNORMALITY_REFRESH', packet));
  mod.hook('S_ABNORMALITY_END', 1, native, packet => update('S_ABNORMALITY_END', packet));
  mod.hook('S_START_COOLTIME_SKILL', 3, native, packet => {
    if (Number.isFinite(packet.cooldown) && packet.cooldown >= 0 && config.effects.some(e => e.skillId === skillId(packet))) {
      record('SERVER_LOTUS_SKILL_COOLDOWN', { packet });
      engine.skillCooldown(skillId(packet), packet.cooldown); persist();
    }
  });
  mod.hook('S_CANNOT_START_SKILL', 4, native, packet => {
    observeActivity('S_CANNOT_START_SKILL', packet);
    followup.reject(skillId(packet));
    if (effectForSkill(skillId(packet))) record('SERVER_LOTUS_REJECT', { packet, pending: engine.pending, state: snapshot() });
    if (inputSkill === skillId(packet)) clearActivity();
    if (autoDisplayRequest?.skillId === skillId(packet)) autoDisplayRequest = null;
    engine.reject(skillId(packet)); engine.wake();
  });
  mod.hook('S_SYSTEM_MESSAGE', 1, native, packet => {
    if (!logFile || !followup.window && (!engine.pending || Date.now() > engine.pending.until + 2000)) return;
    let parsed = null;
    try { parsed = mod.parseSystemMessage(packet.message); } catch (_) {}
    record('SERVER_LOTUS_SYSTEM_MESSAGE', { message: packet.message, parsed, pending: engine.pending });
  });
  mod.hook('S_SKILL_LIST', 2, native, packet => {
    blockListSeen = true;
    blockSkills = packet.skills.filter(skill => skill.active === true).map(skill => Number(skill.id));
    knownSkills = packet.skills.filter(skill => Number(skill.id) >= 60000000 && Number(skill.id) < 70000000);
    record('LOTUS_SKILL_LIST', { skills: knownSkills });
  });
  mod.hook('S_PREMIUM_SLOT_DATALIST', 2, native, packet => {
    premiumListSeen = true; premiumSlots.clear(); engine.premiumReuse.clear();
    for (const set of packet.sets) {
      for (const slot of set.inventory) {
        const effect = slot.type === 3 && effectForSkill(slot.id);
        if (!effect || !Number.isInteger(set.id) || set.id < 0 || !Number.isInteger(slot.slot) || slot.slot < 0 ||
            !Number.isInteger(slot.amount) || slot.amount < -1 || slot.amount === 0) continue;
        const remaining = Number(slot.cooldownRemaining);
        if (!Number.isFinite(remaining) || remaining < 0 || remaining > 86400000) continue;
        const readyAt = Date.now() + remaining;
        premiumSlots.set(effect.key, { set: set.id, slot: slot.slot, type: 3, id: slot.id, amount: slot.amount, readyAt });
        engine.premiumReuse.set(effect.key, readyAt);
      }
    }
    record('LOTUS_PREMIUM_SLOTS', { slots: Object.fromEntries(premiumSlots), reuse: Object.fromEntries(engine.premiumReuse) });
    engine.wake();
  });
  mod.hook('S_PREMIUM_SLOT_OFF', 'event', () => {
    premiumSlots.clear(); engine.premiumReuse.clear(); premiumListSeen = false;
    record('LOTUS_PREMIUM_SLOTS_OFF'); engine.wake();
  });
  mod.hook('C_USE_PREMIUM_SLOT', 1, native, packet => {
    if (packet.type !== 3) return;
    if (effectForSkill(packet.id)) { autoDisplayRequest = null; followup.reset('manual-lotus'); }
    record('CLIENT_PREMIUM_SKILL_INPUT', { packet, kind: effectForSkill(packet.id)?.key ?? null, state: snapshot() });
  });
  mod.hook('C_USE_PREMIUM_SLOT', 1, { order: 9000001, filter: { fake: null, modified: null, silenced: false } }, packet => {
    if (sending || packet.type !== 3) return;
    const effect = effectForSkill(packet.id);
    if (!effect) return;
    autoDisplayRequest = null;
    followup.reset('manual-lotus');
    record('LOTUS_MANUAL_PREMIUM_INPUT', { packet, kind: effect.key });
    clearActivity(); inputUntil = Date.now() + 2000; inputSkill = packet.id;
    activityTimer = mod.setTimeout(() => { clearActivity(); engine.wake(); }, 2000);
    engine.manual(packet.id);
  });
  function clearActivity() {
    if (activityTimer !== null) mod.clearTimeout(activityTimer);
    activityTimer = null; inputUntil = 0; inputSkill = null;
  }
  for (const [name, version] of [['C_START_SKILL', 7], ['C_START_TARGETED_SKILL', 7], ['C_START_INSTANCE_SKILL', 7], ['C_PRESS_SKILL', 4]]) {
    mod.hook(name, version, native, packet => {
      if (name === 'C_PRESS_SKILL' && blockIds[mod.game.me.class]?.includes(skillId(packet))) {
        manualBlockHeld = packet.press !== false;
        // A real manual block must retain its normal presentation, including
        // a held continuation of the same native action.
        hiddenBlockActions.clear();
        followup.clearInput('manual-block');
      }
      if (packet.press !== false) clientIntent++;
      if (followup.window || config.enabled && engine.armed && engine.activeUntil() <= Date.now())
        record('LOTUS_PHYSICAL_SKILL_INPUT', { name, skill: skillId(packet), press: packet.press ?? null,
          intent: clientIntent, pendingInput: inputSkill, inputRemainingMs: Math.max(0, inputUntil - Date.now()) });
      if (effectForSkill(skillId(packet))) { autoDisplayRequest = null; followup.reset('manual-lotus'); }
      if (packet.press === false) followup.cancelInput(skillId(packet), 'physical-release');
      if (logFile && effectForSkill(skillId(packet))) record('CLIENT_LOTUS_INPUT', { name, packet, state: snapshot() });
    });
    mod.hook(name, version, { order: 9000001, filter: { fake: null, modified: null, silenced: false } }, packet => {
      if (sending) return;
      observeActivity(name, packet);
      if (effectForSkill(skillId(packet))) {
        autoDisplayRequest = null;
        followup.reset('manual-lotus');
        record('LOTUS_MANUAL_INPUT', { name, packet, state: snapshot() });
      }
      followup.input(name, version, packet, skillId(packet));
      if (packet.press === false) {
        if (inputSkill === skillId(packet)) clearActivity();
        engine.wake(); return;
      }
      // A new physical input can intentionally repeat the same skill. It must not
      // be mistaken for a leftover synthetic retry.
      const freshIntent = clientIntent > consumedIntent;
      consumedIntent = clientIntent;
      // A synthetic retry of an already acknowledged action is not a new intent.
      // Distinct phases and real player presses continue to get their own guard.
      if (packet.$fake === true && !freshIntent && action !== null && inputSkill === null &&
          skillId(packet) === actionSkill) {
        engine.wake(); return;
      }
      // Repeated retries of the same unanswered input cannot extend its deadline forever.
      if (packet.$fake === true && !freshIntent && inputSkill === skillId(packet) && inputUntil > Date.now()) {
        engine.wake(); return;
      }
      clearActivity();
      inputUntil = Date.now() + 2000; inputSkill = skillId(packet);
      activityTimer = mod.setTimeout(() => { clearActivity(); engine.wake(); }, 2000);
      if (config.effects.some(e => e.skillId === skillId(packet))) engine.manual(skillId(packet));
      engine.wake();
    });
  }
  mod.hook('S_ACTION_STAGE', 9, native, packet => {
    if (packet.gameId !== mod.game.me.gameId) return;
    const alreadySeenAction = seenServerActions.has(packet.id);
    seenServerActions.add(packet.id);
    if (seenServerActions.size > 64) seenServerActions.delete(seenServerActions.values().next().value);
    observeActivity('S_ACTION_STAGE', packet);
    location = packet.loc; facing = packet.w; action = packet.id; actionSkill = skillId(packet);
    if (followup.blockStage(actionSkill, packet.id, alreadySeenAction)) {
      record('SERVER_LOTUS_BLOCK_STAGE', { packet });
      if (config.hideAutoAnimation && followup.window.block.hide) {
        hiddenBlockActions.set(packet.id, actionSkill);
        if (hiddenBlockActions.size > 16) hiddenBlockActions.delete(hiddenBlockActions.keys().next().value);
      }
    } else followup.stage(actionSkill, packet.id, alreadySeenAction, packet.skill);
    if (effectForSkill(actionSkill)) record('SERVER_LOTUS_ACTION_STAGE', { packet });
    if (inputMatchesAction(skillId(packet), alreadySeenAction) || inputUntil <= Date.now()) {
      clearActivity();
    }
    engine.wake();
  });
  mod.hook('S_ACTION_END', 5, native, packet => {
    if (packet.gameId !== mod.game.me.gameId) return;
    observeActivity('S_ACTION_END', packet);
    if (effectForSkill(skillId(packet))) record('SERVER_LOTUS_ACTION_END', { packet });
    const currentEnded = action === packet.id;
    if (currentEnded) { action = null; actionSkill = null; }
    location = packet.loc; facing = packet.w;
    if (followup.blockEnd(skillId(packet), packet.id)) record('SERVER_LOTUS_BLOCK_END', { packet });
    else followup.end(skillId(packet), packet.id, packet.type);
    // Fake client animation ends and older action ends never create a free slot.
    // Keep a different, already forwarded attack input guarded until its own reply.
    if (currentEnded && engine.armed && config.enabled && engine.activeUntil() <= Date.now() &&
        (engine.pending?.until || 0) <= Date.now() && engine.desired() && engine.readyAt(engine.desired()) <= Date.now())
      record('LOTUS_COMBAT_OPPORTUNITY', { actionId: packet.id, skill: skillId(packet),
        pendingInput: inputSkill, inputRemainingMs: Math.max(0, inputUntil - Date.now()) });
    engine.wake(currentEnded);
  });
  // Presentation only: keep early native tracking/buff/reuse hooks intact.
  // No synthetic action or speed buff is created, and no attack is cancelled.
  const presentation = { order: 9000002, filter: { fake: false, modified: null, silenced: false } };
  mod.hook('S_ACTION_STAGE', 9, presentation, packet => {
    const id = skillId(packet);
    if (packet.gameId !== mod.game.me.gameId) return;
    if (hiddenBlockActions.has(packet.id) && hiddenBlockActions.get(packet.id) === id) return false;
    if (!effectForSkill(id)) return;
    if (hiddenLotusActions.get(packet.id) === id) return false;
    if (!config.hideAutoAnimation || autoDisplayRequest?.skillId !== id || Date.now() > autoDisplayRequest.until) return;
    autoDisplayRequest = null;
    hiddenLotusActions.set(packet.id, id);
    if (hiddenLotusActions.size > 16) hiddenLotusActions.delete(hiddenLotusActions.keys().next().value);
    record('LOTUS_AUTO_ANIMATION_HIDDEN', { actionId: packet.id, skillId: id, class: mod.game.me.class });
    return false;
  });
  mod.hook('S_ACTION_END', 5, presentation, packet => {
    if (packet.gameId === mod.game.me.gameId && hiddenBlockActions.has(packet.id) &&
        hiddenBlockActions.get(packet.id) === skillId(packet)) {
      hiddenBlockActions.delete(packet.id); return false;
    }
    if (packet.gameId !== mod.game.me.gameId || !hiddenLotusActions.has(packet.id) ||
        hiddenLotusActions.get(packet.id) !== skillId(packet)) return;
    hiddenLotusActions.delete(packet.id);
    record('LOTUS_AUTO_ANIMATION_END_HIDDEN', { actionId: packet.id, skillId: skillId(packet) });
    return false;
  });
  mod.hook('C_CANCEL_SKILL', 3, { order: 9000001, filter: { fake: null, modified: null, silenced: false } },
    packet => {
      observeActivity('C_CANCEL_SKILL', packet);
      if (sending) return;
      if (followup.window?.lotusId === skillId(packet)) followup.reset('external-lotus-cancel');
      else followup.cancelInput(skillId(packet), 'skill-cancelled');
    });
  mod.hook('C_USE_ITEM', 3, { order: 9000001, filter: { fake: null, modified: null, silenced: false } },
    () => followup.clearInput('item-use'));
  mod.hook('C_USE_PREMIUM_SLOT', 1, { order: 9000001, filter: { fake: null, modified: null, silenced: false } },
    () => { if (!sending) followup.clearInput('premium-use'); });
  mod.hook('C_PLAYER_LOCATION', 5, { filter: { fake: false } }, packet => {
    location = packet.loc; facing = packet.w; engine.wake();
  });
  function boot() {
    if (bootTimer !== null) mod.clearTimeout(bootTimer);
    bootUntil = Date.now() + 2000; bootTimer = mod.setTimeout(() => {
      bootTimer = null; syncNativeBuffs(); confirmRemovals(); engine.resume();
    }, 2000);
  }
  function snapshot() {
    return { gameId: mod.game.me.gameId, class: mod.game.me.class, combat: mod.game.me.status === 1, ingame: mod.game.isIngame,
      loading: mod.game.isInLoadingScreen, alive: mod.game.me.alive, mounted: mod.game.me.mounted,
      transitionLoading, pendingRemovals: [...pendingRemovals.keys()],
      contract: mod.game.contract.active, hasLocation: location !== null, action, actionSkill,
      inputSkill, inputRemainingMs: Math.max(0, inputUntil - Date.now()), bootRemainingMs: Math.max(0, bootUntil - Date.now()),
      buffs: Object.fromEntries(engine.buffs), cooldowns: Object.fromEntries(engine.cooldowns),
      reuse: Object.fromEntries(engine.reuse), knownCooldowns: [...engine.knownCooldowns],
      premiumListSeen, premiumSlots: Object.fromEntries(premiumSlots), premiumReuse: Object.fromEntries(engine.premiumReuse),
      hideAutoAnimation: config.hideAutoAnimation, hiddenLotusActions: [...hiddenLotusActions.keys()],
      fastTransition: config.fastTransition, followup: followup.state(),
      blockRoute: blockRoute(), manualBlockHeld, hiddenBlockActions: [...hiddenBlockActions.keys()],
      recentActivity: activity.filter(entry => entry.at >= Date.now() - 15000),
      attempts: Object.fromEntries(engine.attempts), last: engine.last, armed: engine.armed, skills: knownSkills,
      nativeBuffs: Object.values(mod.game.me.abnormalities || {}).filter(buff =>
        config.effects.some(effect => effect.buffId === buff.id || effect.cooldownId === buff.id))
        .map(buff => ({ id: buff.id, remaining: buff.remaining })) };
  }
  function syncNativeBuffs() {
    for (const buff of Object.values(mod.game.me.abnormalities || {})) {
      if (!config.effects.some(effect => effect.buffId === buff.id || effect.cooldownId === buff.id)) continue;
      const remaining = Number(buff.remaining);
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 86400000) continue;
      if (pendingRemovals.delete(buff.id)) record('LOTUS_REMOVAL_REBOUND', { id: buff.id, remaining, source: 'native-snapshot' });
      engine.buff(buff.id, remaining);
    }
    record('NATIVE_LOTUS_SNAPSHOT', { state: snapshot() }); persist();
  }
  function login(packet) {
    clearRemovalTimer(); pendingRemovals.clear(); transitionLoading = mod.game.isInLoadingScreen;
    seenServerActions.clear();
    clientIntent = 0; consumedIntent = 0;
    blockSkills = []; blockListSeen = false; manualBlockHeld = false; hiddenBlockActions.clear();
    autoDisplayRequest = null; hiddenLotusActions.clear();
    followup.reset('login');
    if (character !== null) { premiumSlots.clear(); premiumListSeen = false; }
    activity.length = 0;
    engine.reset(true); clearActivity(); location = null; action = null; actionSkill = null; knownSkills = [];
    for (const [key, slot] of premiumSlots) engine.premiumReuse.set(key, slot.readyAt);
    character = `${packet.serverId ?? mod.serverId}:${packet.playerId ?? mod.game.me.playerId}`;
    const saved = stored[character] || {};
    for (const field of ['buffs', 'cooldowns', 'reuse'])
      for (const [id, until] of Object.entries(saved[field] || {}))
        if (Number.isFinite(until) && until > Date.now()) engine[field].set(field === 'reuse' ? id : Number(id), until);
    for (const id of saved.knownCooldowns || Object.keys(saved.cooldowns || {}).map(Number))
      if (config.effects.some(effect => effect.cooldownId === id)) engine.knownCooldowns.add(id);
    engine.last = config.effects.some(e => e.key === saved.last) ? saved.last : null; engine.armed = saved.armed === true;
    boot();
  }
  mod.hook('S_LOGIN', mod.majorPatchVersion >= 86 ? 14 : 13, login);
  mod.hook('S_LOAD_TOPO', 'event', native, () => { transitionLoading = true; pause(); });
  mod.hook('S_SPAWN_ME', 3, packet => { action = null; actionSkill = null; location = packet.loc; facing = packet.w; engine.wake(); });
  function pause() {
    clearRemovalTimer();
    persist(); engine.reset(); clearActivity(); location = null; action = null; actionSkill = null;
    autoDisplayRequest = null; hiddenLotusActions.clear();
    followup.reset('pause');
    hiddenBlockActions.clear(); manualBlockHeld = false;
    if (bootTimer !== null) mod.clearTimeout(bootTimer); bootTimer = null;
  }
  function leave() {
    pause(); pendingRemovals.clear(); engine.reset(true); premiumSlots.clear(); seenServerActions.clear();
    premiumListSeen = false; activity.length = 0; character = null;
  }
  const ready = () => { boot(); engine.wake(); };
  const loaded = () => { transitionLoading = false; ready(); };
  const loading = () => { transitionLoading = true; pause(); };
  mod.game.on('enter_loading_screen', loading); mod.game.on('leave_loading_screen', loaded); mod.game.on('leave_game', leave);
  mod.game.me.on('die', pause); mod.game.me.on('resurrect', ready); mod.game.me.on('dismount', ready); mod.game.contract.on('end', ready);
  mod.command.add('lotus', (command = 'status', value = '') => {
    command = command.toLowerCase();
    if (command === 'on' || command === 'off') {
      config.enabled = command === 'on'; engine.config = config;
      if (!config.enabled) followup.reset('disabled');
      if (config.enabled) { syncNativeBuffs(); engine.armed = true; engine.attempts.clear(); }
      try {
        save(configFile, config); persist(); engine.wake();
        record('CYCLE_COMMAND', { command, state: snapshot() }); message(command.toUpperCase());
      } catch (error) { message(error.message); }
    } else if (command === 'fast') {
      value = value.toLowerCase();
      if (value !== 'on' && value !== 'off') { message('lotus fast on/off'); return; }
      config.fastTransition.enabled = value === 'on';
      if (!config.fastTransition.enabled) followup.reset('fast-disabled');
      try {
        save(configFile, config); record('FAST_TRANSITION_COMMAND', { enabled: config.fastTransition.enabled });
        message(`Post-blessing skill retry ${config.fastTransition.enabled ? 'ON' : 'OFF'}.`);
      } catch (error) { message(error.message); }
    } else if (command === 'cancel') {
      value = value.toLowerCase();
      if (value !== 'on' && value !== 'off') { message('lotus cancel on/off'); return; }
      config.fastTransition.cancelAfterBuff = value === 'on';
      followup.reset('cancel-setting-changed');
      try {
        save(configFile, config); record('BUFF_CANCEL_COMMAND', { enabled: config.fastTransition.cancelAfterBuff });
        message(`Post-blessing Lotus cancel ${config.fastTransition.cancelAfterBuff ? 'ON (experimental)' : 'OFF'}.`);
      } catch (error) { message(error.message); }
    } else if (command === 'animation') {
      value = value.toLowerCase();
      if (value !== 'on' && value !== 'off') { message('lotus animation on/off (on = hide automatic animation)'); return; }
      config.hideAutoAnimation = value === 'on'; autoDisplayRequest = null;
      try {
        save(configFile, config); record('ANIMATION_COMMAND', { hidden: config.hideAutoAnimation });
        message(`Automatic Lotus animation ${config.hideAutoAnimation ? 'hidden' : 'normal'}.`);
      } catch (error) { message(error.message); }
    } else if (command === 'reload') {
      try {
        config = load(); engine.config = config;
        followup.reset('config-reloaded');
        for (const [key, slot] of premiumSlots) {
          if (!config.effects.some(effect => effect.key === key && effect.skillId === slot.id)) {
            premiumSlots.delete(key); engine.premiumReuse.delete(key);
          }
        }
        syncNativeBuffs(); engine.wake(); message('Configuration reloaded.');
      } catch (error) { message(error.message); }
    } else if (command === 'log') {
      if (logFile) { record('SESSION_END'); logFile = null; message('Log OFF.'); }
      else try {
        const folder = path.join(__dirname, 'logs'); fs.mkdirSync(folder, { recursive: true });
        logFile = path.join(folder, `lotus-cycle-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
          record('SESSION_START', { config, state: snapshot() }); message('Log ON.');
      } catch (error) { message(error.message); }
    } else if (command === 'status') {
      record('STATUS_QUERY', { state: snapshot() });
      message(`${config.enabled ? 'ON' : 'OFF'} | cycle ${engine.armed ? 'armed' : 'waiting for a real blessing or lotus on'} | ` +
        `automatic animation ${config.hideAutoAnimation ? 'hidden' : 'normal'}`);
      message(`Post-blessing retry ${config.fastTransition.enabled ? 'ON' : 'OFF'} | delay ${config.fastTransition.delayAfterBuffMs}ms`);
      message(`Lotus cancel ${config.fastTransition.cancelAfterBuff ? 'ON (experimental)' : 'OFF'} | type ${config.fastTransition.cancelType}`);
      message(`Block cancel ${config.fastTransition.blockCancel.enabled ? 'ON' : 'OFF'} | ` +
        `${blockRoute()?.class ?? 'native cancel route'} | delay ${config.fastTransition.blockCancel.delayAfterBuffMs}ms`);
      for (const effect of config.effects) message(`${effect.key}: buff ${Math.max(0, Math.ceil(((engine.buffs.get(effect.buffId) || 0) - Date.now()) / 1000))}s | ` +
        `recharge ${engine.knownCooldowns.has(effect.cooldownId) ? Math.max(0, Math.ceil((engine.readyAt(effect) - Date.now()) / 1000)) + 's' : 'unknown'} | ` +
        `attempts ${engine.attempts.get(effect.key) || 0} | route ${premiumSlots.has(effect.key) ? 'premium slot' : 'direct skill'}`);
    } else message('lotus on/off/status/reload/log | lotus animation on/off | lotus fast on/off | lotus cancel on/off');
  });
  if (mod.game.isIngame && mod.game.me.gameId && mod.game.me.playerId != null)
    login({ serverId: mod.game.me.serverId ?? mod.serverId, playerId: mod.game.me.playerId });
  this.destructor = () => {
    clearRemovalTimer(); pendingRemovals.clear();
    persist(); engine.reset(true); clearActivity(); if (bootTimer !== null) mod.clearTimeout(bootTimer);
    autoDisplayRequest = null; hiddenLotusActions.clear();
    followup.reset('unload');
    hiddenBlockActions.clear();
    for (const [event, fn] of [['enter_loading_screen', loading], ['leave_loading_screen', loaded], ['leave_game', leave]]) mod.game.removeListener(event, fn);
    mod.game.me.removeListener('die', pause); mod.game.me.removeListener('resurrect', ready);
    mod.game.me.removeListener('dismount', ready); mod.game.contract.removeListener('end', ready);
    mod.command.remove('lotus'); record('MODULE_UNLOAD'); logFile = null;
  };
};
