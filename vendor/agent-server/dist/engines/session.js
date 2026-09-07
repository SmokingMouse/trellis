/** Single-consumer stream, shared by engines and transport-neutral connections. */
export class AsyncQueue {
    values = [];
    waiters = [];
    ended = false;
    push(value) {
        if (this.ended)
            return;
        const waiter = this.waiters.shift();
        if (waiter)
            waiter({ value, done: false });
        else
            this.values.push(value);
    }
    end() { this.ended = true; for (const resolve of this.waiters.splice(0))
        resolve({ value: undefined, done: true }); }
    next() {
        if (this.values.length)
            return Promise.resolve({ value: this.values.shift(), done: false });
        if (this.ended)
            return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
    }
    [Symbol.asyncIterator]() { return this; }
}
//# sourceMappingURL=session.js.map