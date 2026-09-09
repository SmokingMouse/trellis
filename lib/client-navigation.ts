export class NavigationOwner {
  private controller?: AbortController;
  begin() {
    this.controller?.abort(new DOMException("Navigation superseded", "AbortError"));
    const controller = this.controller = new AbortController();
    return { signal: controller.signal, current: () => this.controller === controller && !controller.signal.aborted };
  }
  cancel() { this.controller?.abort(new DOMException("Navigation cancelled", "AbortError")); }
}
export type NavigationTicket = ReturnType<NavigationOwner["begin"]>;

export async function fetchWithRetry(url: string, ms: number, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("请求超时", "TimeoutError")); }, ms);
    try { return await fetch(url, { signal: controller.signal }); }
    catch (error) {
      if (signal?.aborted || !timedOut || attempt === 1) throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
}
