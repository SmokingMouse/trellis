/** The initial replay is a single indivisible frame and is not live backpressure. */
export function createShadowSseBuffer(onClose: () => void) {
  const encoder = new TextEncoder();
  const replay = new WeakSet<Uint8Array>();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { controller?.close(); } catch { /* Cancellation already closed it. */ }
    onClose();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel: close,
  }, { highWaterMark: 1024 * 1024, size: chunk => !chunk || replay.has(chunk) ? 0 : chunk.byteLength });
  return { stream, close, send(data: string, initialSnapshot = false) {
    if (closed) return;
    if (!initialSnapshot && (controller.desiredSize ?? 0) <= 0) { close(); return; }
    const bytes = encoder.encode(data);
    if (initialSnapshot) replay.add(bytes);
    controller.enqueue(bytes);
  } };
}
