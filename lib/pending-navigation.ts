// Shared by the desktop rail and mobile sheet. Keep navigation errors visible
// to the caller; only reveal a card after the store's navigation has finished.
export async function openPendingItem(
  target: { sessionId: string; nodeId: string },
  closeSheet: () => void,
  store: { openNodeInSession: (sessionId: string, nodeId: string) => Promise<void> },
  revealCard: (nodeId: string) => void,
): Promise<void> {
  closeSheet();
  await store.openNodeInSession(target.sessionId, target.nodeId);
  revealCard(target.nodeId);
}
