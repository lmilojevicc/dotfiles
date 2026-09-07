export function calculateCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
class EventStream {
  queue = [];
  waiters = [];
  ended = false;
  resultPromise;
  resolveResult;
  constructor() {
    this.resultPromise = new Promise((resolve) => { this.resolveResult = resolve; });
  }
  push(value) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }
  end(result) {
    if (this.ended) return;
    this.ended = true;
    this.resolveResult(result);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
  result() { return this.resultPromise; }
}
export function createAssistantMessageEventStream() { return new EventStream(); }
