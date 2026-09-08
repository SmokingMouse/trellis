/** A daemon must never lend its pane or another contract's identity to an engine. */
export function sessionEnvironment(options, source = process.env) {
    const env = { ...source };
    for (const key of Object.keys(env))
        if (key.startsWith("HERDR_") || key.startsWith("FENJUE_"))
            delete env[key];
    if (options.fjContext) {
        env.FENJUE_ROOT = options.fjContext.root;
        env.FENJUE_CID = options.fjContext.cid;
        if (options.fjContext.seat)
            env.FENJUE_SEAT = options.fjContext.seat;
    }
    return env;
}
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
