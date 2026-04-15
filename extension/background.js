/**
 * background.js — Service Worker for Tab Out VETA
 *
 * Updates the toolbar badge with the current tab count.
 * Color:
 *   ≤ 10 → sage green
 *   11-25 → amber
 *   > 25  → rose
 *
 * No server polling, no external calls — just chrome.tabs events.
 */

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    // Count only real web tabs (exclude chrome://, extension pages, about:, etc.)
    const realTabs = tabs.filter(t => {
      const url = t.url || '';
      return !url.startsWith('chrome://')
          && !url.startsWith('chrome-extension://')
          && !url.startsWith('edge://')
          && !url.startsWith('about:');
    });

    const count = realTabs.length;
    if (count === 0) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    chrome.action.setBadgeText({ text: String(count) });

    let color;
    if (count <= 10) color = '#3d7a4a';
    else if (count <= 25) color = '#b8892e';
    else color = '#b35a5a';

    chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Update on install, startup, and every tab change
chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener(updateBadge);

// Initial call when service worker wakes up
updateBadge();
