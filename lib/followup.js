'use strict';

// Experimental native Lotus cancellation after a real blessing, with bounded follow-up.
// Original inputs remain forwarded normally; no fake buff/action acknowledgement is sent.
module.exports = class LotusFollowup {
  constructor({ config, now, setTimeout, clearTimeout, canSend, intent, match, send, record, blockRoute, sendBlock }) {
    Object.assign(this, { config, now, setTimeout, clearTimeout, canSend, intent, match, send, record, blockRoute, sendBlock });
    this.window = null; this.timer = null; this.expiry = null;
    this.blockTimer = null; this.blockExpiry = null;
  }
  reset(reason = 'reset') {
    if (this.timer !== null) this.clearTimeout(this.timer);
    if (this.expiry !== null) this.clearTimeout(this.expiry);
    this.clearBlockTimer();
    if (this.blockExpiry !== null) this.clearTimeout(this.blockExpiry);
    this.blockExpiry = null;
    this.timer = null; this.expiry = null;
    if (this.window) this.record('LOTUS_FOLLOWUP_WINDOW_CLOSED', {
      reason, skillId: this.window.input?.id ?? null, confirmed: !!this.window.acceptedAt });
    this.window = null;
  }
  begin(effect) {
    this.reset('next-lotus-attempt');
    this.window = { lotusId: effect.skillId, buffId: effect.buffId, sentAt: this.now(),
      actionId: null, stageAt: null, buffAt: null, endAt: null, input: null,
      fastSent: false, fallbackSent: false, acceptedAt: null, superseded: false,
      lotusSkill: null, buffIntent: null, cancelSent: false, cancelAt: null,
      cancelForwarded: false, cancelBlocked: false, cancelIntent: null, block: null, endType: null };
    this.expiry = this.setTimeout(() => this.reset('observation-timeout'), 4000);
  }
  input(name, version, packet, id) {
    const w = this.window;
    if (!w || w.superseded || w.acceptedAt || !Number.isInteger(id) || id <= 0 || id >= 60000000) return;
    if (packet.press === false) { this.cancelInput(id, 'button-released'); return; }
    if (packet.skill?.type !== undefined && packet.skill.type !== 1) return;
    // A naturally forwarded request after buff confirmation gets no immediate duplicate.
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
    if (w.buffAt !== null) w.cancelBlocked = true;
    if (w.buffAt !== null) this.clearBlockTimer();
    w.input = { name, version, packet: copy(packet), id, at: this.now(), intent: this.intent() };
    this.record('LOTUS_FOLLOWUP_INPUT', { name, skillId: id, afterBuff: w.buffAt !== null, fake: packet.$fake === true });
  }
  cancelInput(id, reason) {
    if (!this.window?.input || !this.match(this.window.input.id, id)) return;
    if (this.window.buffAt !== null) this.window.cancelBlocked = true;
    this.clearBlockTimer();
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null; this.window.input = null;
    this.record('LOTUS_FOLLOWUP_INPUT_CLEARED', { skillId: id, reason });
  }
  clearInput(reason) {
    if (this.window) this.window.cancelBlocked = true;
    this.clearBlockTimer();
    const input = this.window?.input;
    if (input) this.cancelInput(input.id, reason);
  }
  buff(id) {
    const w = this.window;
    if (!w || w.buffId !== id || w.buffAt !== null) return;
    w.buffAt = this.now(); w.buffIntent = this.intent();
    this.record('LOTUS_FOLLOWUP_BUFF_CONFIRMED', { lotusId: w.lotusId, actionId: w.actionId,
      fromRequestMs: w.buffAt - w.sentAt, fromStageMs: w.stageAt === null ? null : w.buffAt - w.stageAt });
    this.queueFast();
  }
  buffEnded(id) {
    if (this.window?.buffId === id) this.reset('real-speed-buff-removed');
  }
  queueFast() {
    const w = this.window;
    if (!this.config().enabled || !w || w.buffAt === null || w.actionId === null ||
        w.endAt !== null || w.superseded || this.timer !== null || w.cancelSent) return;
    const cancel = this.config().cancelAfterBuff && !w.cancelBlocked;
    const block = cancel && this.blockRoute?.();
    if (block && !w.block && this.blockTimer === null) {
      this.blockTimer = this.setTimeout(() => {
        this.blockTimer = null; this.cancelWithBlock(block);
      }, Math.max(1, w.buffAt + this.config().blockCancel.delayAfterBuffMs - this.now()));
    }
    const replay = w.input && w.input.at <= w.buffAt && !w.fastSent;
    if (!cancel && !replay) return;
    // Run after all native abnormality hooks have updated speed/emulation state.
    this.timer = this.setTimeout(() => {
      this.timer = null;
      this.cancelLotus();
      // Cancellation can be ignored. The already queued pre-buff input gets its
      // bounded fast retry without waiting for a natural Lotus action end.
      if (this.window?.input?.at <= this.window?.buffAt) this.replay('buff-confirmed');
    },
      Math.max(1, w.buffAt + this.config().delayAfterBuffMs - this.now()));
  }
  stage(id, actionId, alreadySeen, skill) {
    const w = this.window;
    if (!w) return;
    if (id === w.lotusId) {
      if (w.actionId !== null && w.actionId !== actionId) return;
      w.actionId = actionId;
      if (skill) w.lotusSkill = copy(skill);
      if (w.stageAt === null) w.stageAt = this.now();
      this.queueFast(); // Native buff and stage packets can arrive in either order.
      return;
    }
    if (alreadySeen) return;
    if (w.input && this.match(w.input.id, id)) {
      w.acceptedAt = this.now();
      this.record('LOTUS_FOLLOWUP_ACCEPTED', { skillId: id, actionId,
        fromBuffMs: w.buffAt === null ? null : w.acceptedAt - w.buffAt,
        fromLotusStageMs: w.stageAt === null ? null : w.acceptedAt - w.stageAt,
        beforeLotusEnd: w.endAt === null, replaySent: w.fastSent || w.fallbackSent });
    } else this.record('LOTUS_FOLLOWUP_OTHER_ACTION', { skillId: id, actionId,
      fromBuffMs: w.buffAt === null ? null : this.now() - w.buffAt,
      fromLotusStageMs: w.stageAt === null ? null : this.now() - w.stageAt,
      beforeLotusEnd: w.endAt === null });
    w.superseded = true;
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
  }
  end(id, actionId, type) {
    const w = this.window;
    if (!w || id !== w.lotusId || w.actionId !== actionId || w.endAt !== null) return;
    w.endAt = this.now(); w.endType = type;
    this.clearBlockTimer();
    this.record('LOTUS_FOLLOWUP_LOTUS_END', { actionId, fromBuffMs: w.buffAt === null ? null : w.endAt - w.buffAt,
      durationMs: w.stageAt === null ? null : w.endAt - w.stageAt, type,
      cancelSent: w.cancelSent, cancelForwarded: w.cancelForwarded,
      fromCancelMs: w.cancelAt === null ? null : w.endAt - w.cancelAt });
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
    // A block request can end Lotus before its own stage/end arrives. Never
    // replay into that intervening block; wait for its real matching end.
    if (w.block?.pending) return;
    // An end can belong to an already forwarded next skill. Only replay a request
    // captured before our own cancellation, with unchanged physical intent.
    if (w.cancelForwarded) {
      if (w.input && w.input.at <= w.cancelAt && w.input.intent === w.cancelIntent)
        this.replay(type === 0 ? 'natural-end-fallback' : 'cancel-end-followup');
    } else if (type === 0) this.replay('natural-end-fallback');
  }
  cancelLotus() {
    const w = this.window, cfg = this.config();
    if (this.blockRoute?.()) return false;
    if (!cfg.enabled || !cfg.cancelAfterBuff || !w || !w.lotusSkill || w.cancelSent ||
        w.cancelBlocked || w.buffAt === null || w.endAt !== null || w.superseded ||
        w.acceptedAt || w.buffIntent !== this.intent() || !this.canSend(w)) return false;
    // C_CANCEL_SKILL v3 has no actionId field. canSend checks the current native
    // action locally; the wire packet retains the native Lotus SkillID exactly.
    w.cancelSent = true; w.cancelAt = this.now(); w.cancelIntent = this.intent();
    try {
      const result = this.send('C_CANCEL_SKILL', 3, { skill: copy(w.lotusSkill), type: cfg.cancelType });
      w.cancelForwarded = result === true;
      this.record('LOTUS_BUFF_CANCEL_SENT', { lotusId: w.lotusId, expectedActionId: w.actionId,
        type: cfg.cancelType, fromBuffMs: this.now() - w.buffAt, forwarded: w.cancelForwarded });
    } catch (error) { this.record('LOTUS_BUFF_CANCEL_ERROR', { message: error.message }); }
    // A forwarded request is not proof of server cancellation. Wait for a real
    // matching action end, leaving all fresh player inputs free to pass normally.
    return w.cancelForwarded;
  }
  clearBlockTimer() {
    if (this.blockTimer !== null) this.clearTimeout(this.blockTimer);
    this.blockTimer = null;
  }
  cancelWithBlock(route) {
    const w = this.window, cfg = this.config(), current = this.blockRoute?.();
    if (!cfg.enabled || !cfg.cancelAfterBuff || !current || current.skillId !== route.skillId ||
        !w || w.block || w.cancelBlocked || w.buffAt === null || w.actionId === null ||
        w.endAt !== null || w.superseded || w.acceptedAt || w.buffIntent !== this.intent() || !this.canSend(w)) return;
    w.block = { ...route, requestedAt: this.now(), until: this.now() + 500,
      actionId: null, endedAt: null, pending: true, intent: this.intent(), hide: false };
    this.blockExpiry = this.setTimeout(() => {
      this.blockExpiry = null;
      if (this.window !== w || !w.block.pending) return;
      w.block.pending = false;
      this.record('LOTUS_BLOCK_ACK_TIMEOUT', { skillId: route.skillId, actionId: w.block.actionId });
      if (w.block.actionId === null && w.endAt !== null) this.replay('block-timeout-followup');
    }, 500);
    try {
      const result = this.sendBlock(route.skillId);
      Object.assign(w.block, result);
      w.block.hide = result.pressForwarded && result.releaseForwarded;
      this.record('LOTUS_BLOCK_CANCEL_SENT', { ...result, skillId: route.skillId, class: route.class,
        expectedLotusActionId: w.actionId, fromBuffMs: this.now() - w.buffAt });
      if (!result.pressForwarded) w.block.pending = false;
    } catch (error) {
      w.block.pending = false;
      this.record('LOTUS_BLOCK_CANCEL_ERROR', { message: error.message });
    }
  }
  blockStage(id, actionId, alreadySeen) {
    const w = this.window, b = w?.block;
    if (!b || w.superseded || b.endedAt !== null || !b.pressForwarded ||
        b.intent !== this.intent() || !b.skillIds.includes(id)) return false;
    if (b.actionId === actionId) return true;
    if (alreadySeen || b.actionId !== null || !b.pending || this.now() > b.until ||
        w.endAt === null || w.endType !== 6) return false;
    b.actionId = actionId;
    this.record('LOTUS_BLOCK_ACTION_CONFIRMED', { skillId: id, actionId,
      fromBlockRequestMs: this.now() - b.requestedAt, lotusDurationMs: w.endAt - w.stageAt });
    return true;
  }
  blockEnd(id, actionId) {
    const w = this.window, b = w?.block;
    if (!b || b.actionId !== actionId || !b.skillIds.includes(id) || b.endedAt !== null) return false;
    b.endedAt = this.now(); b.pending = false;
    if (this.blockExpiry !== null) this.clearTimeout(this.blockExpiry);
    this.blockExpiry = null;
    this.record('LOTUS_BLOCK_ACTION_END', { skillId: id, actionId, fromBlockRequestMs: this.now() - b.requestedAt });
    if (b.intent === this.intent() && w.input?.at <= b.requestedAt) this.replay('block-end-followup');
    return true;
  }
  reject(id) {
    const w = this.window;
    const b = w?.block;
    if (b?.pending && b.actionId === null && b.skillIds.includes(id)) {
      b.pending = false;
      if (this.blockExpiry !== null) this.clearTimeout(this.blockExpiry);
      this.blockExpiry = null;
      this.record('LOTUS_BLOCK_REJECTED', { skillId: id, fromBlockRequestMs: this.now() - b.requestedAt });
      if (w.endAt !== null) this.replay('block-reject-followup');
    }
    if (!w?.input || !this.match(w.input.id, id)) return;
    this.record('LOTUS_FOLLOWUP_MATCHING_REJECT', { skillId: id,
      fromBuffMs: w.buffAt === null ? null : this.now() - w.buffAt,
      replaySent: w.fastSent || w.fallbackSent });
    // There are no request sequence IDs: this can also be an earlier matching input.
  }
  replay(source) {
    const w = this.window, input = w?.input;
    if (!this.config().enabled || !w || !input || w.buffAt === null || w.actionId === null ||
        w.acceptedAt || w.superseded || !this.canSend(w)) return;
    if (input.intent !== this.intent() || this.now() - input.at > 1000) {
      this.clearInput('stale-or-newer-player-intent'); return;
    }
    const fast = source === 'buff-confirmed';
    if (fast ? w.fastSent : w.fallbackSent) return;
    if (fast) w.fastSent = true; else w.fallbackSent = true;
    try {
      const result = this.send(input.name, input.version, copy(input.packet));
      this.record('LOTUS_FOLLOWUP_REPLAY', { source, skillId: input.id, name: input.name,
        fromBuffMs: this.now() - w.buffAt, fromInputMs: this.now() - input.at, forwarded: result === true });
    } catch (error) { this.record('LOTUS_FOLLOWUP_SEND_ERROR', { source, message: error.message }); }
  }
  state() {
    const w = this.window;
    return w ? { lotusId: w.lotusId, actionId: w.actionId, buffAt: w.buffAt, endAt: w.endAt,
      skillId: w.input?.id ?? null, fastSent: w.fastSent, fallbackSent: w.fallbackSent,
      acceptedAt: w.acceptedAt, superseded: w.superseded, cancelSent: w.cancelSent,
      cancelAt: w.cancelAt, cancelForwarded: w.cancelForwarded, block: w.block } : null;
  }
};

function copy(value) {
  if (!value || typeof value !== 'object') return value;
  if (typeof value.clone === 'function') return value.clone();
  if (Array.isArray(value)) return value.map(copy);
  const result = {};
  for (const [key, entry] of Object.entries(value)) if (!key.startsWith('$')) result[key] = copy(entry);
  return result;
}
