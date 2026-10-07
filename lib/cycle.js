'use strict';

module.exports = class LotusCycle {
  constructor({ config, now, setTimeout, clearTimeout, available, retryWhenBusy = () => true, send, record }) {
    Object.assign(this, { config, now, setTimeout, clearTimeout, available, retryWhenBusy, send, record });
    this.buffs = new Map(); this.cooldowns = new Map(); this.reuse = new Map();
    this.premiumReuse = new Map();
    this.last = null; this.armed = false; this.timer = null; this.pending = null;
    this.attempts = new Map();
    this.knownCooldowns = new Set(); this.suspended = false;
  }
  activeUntil() { return Math.max(0, ...this.buffs.values()); }
  readyAt(effect) { return Math.max(this.cooldowns.get(effect.cooldownId) || 0,
    this.reuse.get(effect.key) || 0, this.premiumReuse.get(effect.key) || 0); }
  buff(id, duration) {
    const effect = this.config.effects.find(e => e.buffId === id || e.cooldownId === id);
    if (!effect) return;
    if (effect.buffId === id) {
      this.buffs.set(id, this.now() + duration); this.last = effect.key; this.armed = true;
      this.pending = null; this.attempts.clear();
      this.record('BLESSING_CONFIRMED', { kind: effect.key, duration });
    } else { this.cooldowns.set(id, this.now() + duration); this.knownCooldowns.add(id); }
    this.wake();
  }
  end(id) {
    const effect = this.config.effects.find(e => e.cooldownId === id);
    const observedRecharge = effect && this.cooldowns.has(id);
    this.buffs.delete(id); this.cooldowns.delete(id);
    if (observedRecharge) {
      this.attempts.delete(effect.key);
      this.record('LOTUS_RECHARGE_ENDED', { kind: effect.key });
    }
    this.wake();
  }
  skillCooldown(id, milliseconds) {
    const effect = this.config.effects.find(e => e.skillId === id);
    if (effect) { this.reuse.set(effect.key, this.now() + milliseconds); this.wake(); }
  }
  manual(id) {
    const effect = this.config.effects.find(e => e.skillId === id);
    if (!effect) return;
    this.pending = { kind: effect.key, until: this.now() + this.config.acknowledgementMs, manual: true };
    this.wake();
  }
  reject(id) {
    if (this.pending && this.config.effects.find(e => e.key === this.pending.kind)?.skillId === id) {
      this.record('LOTUS_REJECTED', { kind: this.pending.kind });
      this.pending.until = this.now() + this.config.retryDelayMs;
      this.wake();
    }
  }
  desired() { return this.last ? this.config.effects.find(e => e.key !== this.last) : this.config.effects.find(e => e.key === this.config.first); }
  reportMissingConfirmation() {
    if (this.pending && this.pending.until <= this.now() && !this.pending.timeoutReported) {
      this.pending.timeoutReported = true;
      this.record('LOTUS_CONFIRMATION_MISSING', { kind: this.pending.kind, manual: !!this.pending.manual,
        attempts: this.attempts.get(this.pending.kind) || 0 });
    }
  }
  wake(immediate = false) {
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null;
    if (this.suspended || !this.config.enabled || !this.armed) return;
    const time = this.now(), active = this.activeUntil(), effect = this.desired();
    this.reportMissingConfirmation();
    if (active > time) { this.timer = this.setTimeout(() => this.tick(), active - time); return; }
    if (!effect) return;
    const ready = this.readyAt(effect), pending = this.pending?.until || 0;
    if (ready > time || pending > time) {
      this.timer = this.setTimeout(() => this.tick(), Math.max(ready, pending) - time); return;
    }
    if (!this.available()) {
      // Keep looking during combat; an unavailable action must not stop the cycle.
      // Lifecycle/contract guards can stop polling until their own resume event.
      if (this.retryWhenBusy()) this.timer = this.setTimeout(() => this.tick(), 50);
      return;
    }
    // A real action end is a narrow opportunity: do not yield it to the next skill.
    if (immediate) { this.tick(); return; }
    this.timer = this.setTimeout(() => this.tick(), 1);
  }
  tick() {
    this.timer = null;
    this.reportMissingConfirmation();
    if (this.suspended || !this.config.enabled || !this.armed || this.activeUntil() > this.now() || !this.available()) { this.wake(); return; }
    const effect = this.desired(), time = this.now();
    if (!effect || this.readyAt(effect) > time || (this.pending?.until || 0) > time) { this.wake(); return; }
    const count = this.attempts.get(effect.key) || 0;
    this.attempts.set(effect.key, count + 1);
    // Fixed pacing, unlimited attempts. Only the real speed blessing completes a cast.
    this.pending = { kind: effect.key, until: time + Math.max(this.config.acknowledgementMs, this.config.retryDelayMs) };
    this.record('AUTO_LOTUS_REQUEST', { kind: effect.key, skillId: effect.skillId, attempt: count + 1 });
    try {
      if (this.send(effect) === false) this.record('LOTUS_SEND_BLOCKED', { kind: effect.key });
    } catch (error) { this.record('SEND_ERROR', { message: error.message }); }
    this.wake();
  }
  reset(clear = false) {
    if (this.timer !== null) this.clearTimeout(this.timer);
    this.timer = null; this.pending = null; this.suspended = true;
    if (clear) {
      this.buffs.clear(); this.cooldowns.clear(); this.reuse.clear(); this.attempts.clear();
      this.premiumReuse.clear();
      this.knownCooldowns.clear(); this.armed = false; this.last = null;
    }
  }
  resume() { this.suspended = false; this.wake(); }
};
