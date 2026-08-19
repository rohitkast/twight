// In-page prompt on Reddit post pages. Isolated in a shadow root so Reddit CSS cannot restyle it.

const HOST_ID = "twight-thread-chip";

const CHIP_CSS = `
:host {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 10px 0 12px;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid #ffc9a8;
  border-radius: 10px;
  background: #fff4ed;
  color: #141417;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 220px;
  min-width: 0;
}
.brand img {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  flex-shrink: 0;
}
.copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kicker {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: #e85d04;
}
.line {
  font-size: 13px;
  line-height: 1.35;
  font-weight: 500;
  color: #141417;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.cta {
  appearance: none;
  border: none;
  border-radius: 8px;
  background: #e85d04;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 7px 12px;
  cursor: pointer;
  white-space: nowrap;
}
.cta:hover { background: #d45303; }
.cta:focus-visible {
  outline: 2px solid #ffc9a8;
  outline-offset: 2px;
}
.dismiss {
  appearance: none;
  border: none;
  background: transparent;
  color: #6b7280;
  font-size: 18px;
  line-height: 1;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
}
.dismiss:hover { background: rgba(20, 20, 23, 0.06); color: #141417; }
`;

const dismissedUrls = new Set<string>();
let navHooked = false;
let mountTimer = 0;
let observer: MutationObserver | null = null;

function isPostPage(): boolean {
  const path = location.pathname;
  return /\/comments\//.test(path) || /\/r\/[^/]+\/s\//.test(path);
}

function findAnchor(): Element | null {
  const post = document.querySelector("shreddit-post");
  if (post) return post;

  const commentTree =
    document.querySelector("shreddit-comment-tree") ||
    document.querySelector("#comment-flow-container") ||
    document.querySelector(".commentarea");
  if (commentTree) return commentTree;

  const oldTitle = document.querySelector(".commentarea .panestack-title");
  return oldTitle;
}

function removeChip(): void {
  document.getElementById(HOST_ID)?.remove();
}

function placeHost(host: HTMLElement, anchor: Element): void {
  if (anchor.tagName.toLowerCase() === "shreddit-post") {
    anchor.insertAdjacentElement("afterend", host);
    return;
  }
  if (anchor.classList.contains("commentarea")) {
    anchor.insertAdjacentElement("afterbegin", host);
    return;
  }
  anchor.insertAdjacentElement("beforebegin", host);
}

function mountChip(): void {
  if (!isPostPage() || dismissedUrls.has(location.href.split("?")[0])) {
    removeChip();
    return;
  }

  const existing = document.getElementById(HOST_ID);
  if (existing?.isConnected) return;

  const anchor = findAnchor();
  if (!anchor) return;

  removeChip();
  const host = document.createElement("div");
  host.id = HOST_ID;
  placeHost(host, anchor);

  const shadow = host.attachShadow({ mode: "open" });
  const iconUrl = chrome.runtime.getURL("icons/icon-48.png");

  const style = document.createElement("style");
  style.textContent = CHIP_CSS;
  shadow.appendChild(style);

  const bar = document.createElement("div");
  bar.className = "bar";

  const brand = document.createElement("div");
  brand.className = "brand";

  const img = document.createElement("img");
  img.src = iconUrl;
  img.alt = "";
  img.width = 20;
  img.height = 20;

  const copy = document.createElement("div");
  copy.className = "copy";

  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = "Twight";

  const line = document.createElement("div");
  line.className = "line";
  line.textContent = "Find people in this thread who might want what you offer";

  copy.append(kicker, line);
  brand.append(img, copy);

  const actions = document.createElement("div");
  actions.className = "actions";

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "cta";
  cta.textContent = "Find potential customers";
  cta.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }, () => {
      void chrome.runtime.lastError;
    });
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dismissedUrls.add(location.href.split("?")[0]);
    removeChip();
  });

  actions.append(cta, dismiss);
  bar.append(brand, actions);
  shadow.appendChild(bar);
}

function scheduleMount(): void {
  if (mountTimer) window.clearTimeout(mountTimer);
  mountTimer = window.setTimeout(() => {
    mountTimer = 0;
    mountChip();
  }, 80);
}

function hookSpaNavigation(): void {
  if (navHooked) return;
  navHooked = true;

  let href = location.href;
  const onMaybeNav = (): void => {
    if (location.href === href) return;
    href = location.href;
    scheduleMount();
  };

  window.addEventListener("popstate", onMaybeNav);

  const wrap = (fn: History["pushState"]): History["pushState"] =>
    function (this: History, ...args: Parameters<History["pushState"]>) {
      const ret = fn.apply(this, args);
      queueMicrotask(onMaybeNav);
      return ret;
    };

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = wrap(origPush);
  history.replaceState = wrap(origReplace);

  const nav = (window as Window & { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigate", () => queueMicrotask(onMaybeNav));
}

export function initThreadChip(): void {
  hookSpaNavigation();
  scheduleMount();

  if (observer) return;
  observer = new MutationObserver(() => {
    if (!isPostPage()) {
      if (document.getElementById(HOST_ID)) removeChip();
      return;
    }
    if (!document.getElementById(HOST_ID)?.isConnected) scheduleMount();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
