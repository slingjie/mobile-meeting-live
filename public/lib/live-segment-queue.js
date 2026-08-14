export class LiveSegmentQueue {
  constructor() {
    this.items = [];
  }

  enqueue(id, session) {
    if (!id) throw new TypeError('segment id is required');
    this.items.push({ id, session });
    return id;
  }

  target(session) {
    return this.items.find(item => item.session === session)?.id || null;
  }

  complete(session) {
    const index = this.items.findIndex(item => item.session === session);
    if (index < 0) return null;
    return this.items.splice(index, 1)[0].id;
  }

  expire(id) {
    const index = this.items.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    return true;
  }

  clearSession(session) {
    const removed = this.items.filter(item => item.session === session).map(item => item.id);
    this.items = this.items.filter(item => item.session !== session);
    return removed;
  }

  clear() {
    const removed = this.items.map(item => item.id);
    this.items = [];
    return removed;
  }
}
