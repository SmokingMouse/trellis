// React does not unmount a document entering the back/forward cache. Release
// HTTP/1 SSE connections on pagehide and reconnect when that document returns.
export function bindPageStream(target: EventTarget, stop: () => void, resume: () => void): () => void {
  const show = (event: Event) => { if ((event as PageTransitionEvent).persisted) resume(); };
  target.addEventListener("pagehide", stop);
  target.addEventListener("pageshow", show);
  return () => { target.removeEventListener("pagehide", stop); target.removeEventListener("pageshow", show); stop(); };
}
