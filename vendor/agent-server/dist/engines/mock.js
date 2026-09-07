import { AsyncQueue } from "./session.js";
export class MockEngine {
    script;
    backend;
    events = new AsyncQueue();
    engineThreadId = null;
    spawnCount = 0;
    attachCount = 0;
    options;
    sent = [];
    steered = [];
    interrupted = [];
    closed = false;
    active = null;
    generation = 0;
    constructor(script, backend = "claude") {
        this.script = script;
        this.backend = backend;
    }
    async spawn(options) {
        this.options = options;
        this.spawnCount++;
        this.engineThreadId = options.forkSession ? `mock_${crypto.randomUUID()}` : options.engineThreadId ?? `mock_${options.threadId}`;
        this.events.push({ type: "metadata", engineThreadId: this.engineThreadId });
    }
    async attach() { this.attachCount++; }
    async sendTurn(turnId, input, options) {
        this.sent.push({ turnId, input, options });
        this.active = turnId;
        if (this.script)
            void this.play(this.script(turnId, input, this), ++this.generation);
    }
    async play(steps, generation) {
        try {
            for await (const step of steps) {
                if (this.closed || generation !== this.generation)
                    break;
                if ("waitMs" in step)
                    await new Promise(resolve => setTimeout(resolve, step.waitMs));
                else if ("approval" in step) {
                    await new Promise(resolve => this.events.push({ type: "approval", request: step.approval, respond: decision => { step.onDecision?.(decision); resolve(); } }));
                }
                else
                    this.emit(step);
            }
        }
        catch (error) {
            this.events.push({ type: "exit", error: { code: -32015, message: String(error), data: { retryable: false } } });
        }
    }
    emit(event) { if (event.type === "turnCompleted" && event.turnId === this.active)
        this.active = null; this.events.push(event); }
    async steer(turnId, input) { this.steered.push({ turnId, input }); }
    async interrupt(turnId) {
        this.interrupted.push(turnId);
        this.generation++;
        this.emit({ type: "turnCompleted", turnId, status: "interrupted" });
    }
    async close(_reason) { this.closed = true; this.generation++; this.events.end(); }
}
//# sourceMappingURL=mock.js.map