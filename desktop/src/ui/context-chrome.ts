export function nextContextInfoToggle({
  infoOpen,
  sidebarCollapsed,
}: {
  infoOpen: boolean;
  sidebarCollapsed: boolean;
}) {
  const nextInfoOpen = !infoOpen;
  return {
    infoOpen: nextInfoOpen,
    collapseSidebar: nextInfoOpen && !sidebarCollapsed,
  };
}

export function nextContextSidebarToggle({
  infoOpen,
  sidebarCollapsed,
}: {
  infoOpen: boolean;
  sidebarCollapsed: boolean;
}) {
  const expandingSidebar = sidebarCollapsed;
  return {
    panelMode: null,
    infoOpen: expandingSidebar ? false : infoOpen,
  };
}

export function nextContextTabOpenVisibility({
  bottomCollapsed,
  sidebarCollapsed,
  infoOpen,
}: {
  bottomCollapsed: boolean;
  sidebarCollapsed: boolean;
  infoOpen: boolean;
}) {
  return {
    collapseBottom: !bottomCollapsed,
    expandSidebar: sidebarCollapsed,
    infoOpen: infoOpen ? false : infoOpen,
  };
}

export function nextSideChatSend({
  text,
  ready,
}: {
  text: string;
  ready: boolean;
}) {
  const trimmed = text.trim();
  if (!trimmed || !ready) return null;
  return {
    question: trimmed,
  } as const;
}
