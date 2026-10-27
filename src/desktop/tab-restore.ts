import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";
import { type DesktopOpenTab, isDesktopConversationViewId } from "../config.js";

export interface RestorableDesktopTab extends DesktopOpenTab {
  conversationViewId: string;
}

export interface DesktopTabRestorePlan {
  tabs: RestorableDesktopTab[];
  activeConversationViewId: string | undefined;
}

/** Plan after workspace validation, then persist the returned IDs with the restored tabs. */
export function planDesktopTabRestore(
  savedTabs: readonly DesktopOpenTab[],
  startupDir?: string,
): DesktopTabRestorePlan {
  const source = savedTabs.map((tab) => ({ ...tab }));
  // Reserve every saved ID before allocating legacy IDs, including IDs on later tabs.
  const reserved = new Set(
    source.map((tab) => tab.conversationViewId).filter(isDesktopConversationViewId),
  );
  const used = new Set<string>();
  function assignIdentity(tab: DesktopOpenTab, index: number): RestorableDesktopTab {
    let id = tab.conversationViewId;
    if (!isDesktopConversationViewId(id) || used.has(id)) {
      let attempt = 0;
      do {
        const digest = createHash("sha256")
          .update(JSON.stringify([tab.dir, tab.session ?? null, index, attempt++]))
          .digest("hex")
          .slice(0, 32);
        id = `view-${digest}`;
      } while (reserved.has(id) || used.has(id));
    }
    used.add(id);
    return { ...tab, conversationViewId: id };
  }

  // Allocate saved identities before insertion so --dir cannot shift legacy IDs.
  const tabs = source.map(assignIdentity);
  let activeTab = tabs.find((tab) => tab.active === true) ?? tabs[0];
  if (startupDir) {
    const root = process.platform === "win32" ? win32.resolve(startupDir) : resolve(startupDir);
    const directoryKey = (dir: string): string =>
      process.platform === "win32" ? win32.resolve(dir).toLowerCase() : resolve(dir);
    const key = directoryKey(root);
    const matches = tabs.filter((tab) => directoryKey(tab.dir) === key);
    if (matches.length > 0) {
      activeTab = matches.find((tab) => tab.active === true) ?? matches[0];
    } else {
      activeTab = assignIdentity({ dir: root }, tabs.length);
      tabs.unshift(activeTab);
    }
  }
  const activeConversationViewId = activeTab?.conversationViewId;
  return {
    tabs: tabs.map(({ active: _, ...tab }) => ({
      ...tab,
      ...(tab.conversationViewId === activeConversationViewId ? { active: true } : {}),
    })),
    activeConversationViewId,
  };
}
