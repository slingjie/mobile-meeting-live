export class LiveBoundaryTracker {
  constructor() {
    this.counts = new Map();
  }

  sent(session) {
    this.counts.set(session, this.pending(session) + 1);
  }

  completed(session) {
    const count = this.pending(session);
    if (count <= 1) this.counts.delete(session);
    else this.counts.set(session, count - 1);
  }

  pending(session) {
    return this.counts.get(session) || 0;
  }

  hasPending(session) {
    return this.pending(session) > 0;
  }

  clear(session) {
    if (session === undefined) this.counts.clear();
    else this.counts.delete(session);
  }
}
