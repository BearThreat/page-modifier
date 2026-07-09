chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    openclawPageModifierInstalledAt: new Date().toISOString(),
  });
});
