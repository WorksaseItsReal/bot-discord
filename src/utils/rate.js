'use strict';

/**
 * Fenêtre glissante d'événements horodatés. Pur → testable.
 */
class SlidingWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    /** @type {number[]} */
    this.times = [];
  }

  /** Ajoute un événement et renvoie le nombre d'événements dans la fenêtre. */
  hit(now = Date.now()) {
    this.times.push(now);
    this.prune(now);
    return this.times.length;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.times = this.times.filter((t) => t > cutoff);
  }

  count(now = Date.now()) {
    this.prune(now);
    return this.times.length;
  }

  reset() {
    this.times = [];
  }
}

/**
 * @returns {boolean} true si le nombre d'événements dans la fenêtre atteint la limite.
 */
function exceedsRate(times, limit, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  const recent = times.filter((t) => t > cutoff);
  return recent.length >= limit;
}

module.exports = { SlidingWindow, exceedsRate };
