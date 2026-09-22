chrome.runtime.onInstalled.addListener(() => {
  console.log("Portal PDF Downloader installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EasyLMS_PING") {
    sendResponse({
      ok: true,
      tabId: sender.tab?.id ?? null
    });
    return;
  }

  if (message?.type === "EasyLMS_DOWNLOAD") {
    if (!sender.tab?.id || typeof message.url !== "string") {
      return;
    }

    console.log("EasyLMS: starting download", message.url);
    chrome.downloads.download({
      url: message.url,
      filename: typeof message.filename === "string"
        ? message.filename
        : "document.pdf",
      saveAs: false
    }).then((downloadId) => {
      console.log("EasyLMS: download started", downloadId);
    }).catch((error) => {
      console.error("EasyLMS: download failed", error);
    });
    return;
  }

  if (message?.type !== "EasyLMS_EXTRACT_FROM_FRAME" || !sender.tab?.id) {
    return;
  }

  /** @type {number} */
  const tabId = sender.tab.id;
  /** @type {number} */
  const frameId = sender.frameId ?? 0;
  console.log("EasyLMS: extracting from frame", frameId);

  chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: /** @type {`${chrome.scripting.ExecutionWorld}`} */ ("MAIN"),
    func: () => {
      return window["PDFViewerApplication"]?.url ||
        [...document.querySelectorAll("iframe")]
          .map((frame) => frame.src)
          .find((src) => /^https?:\/\//i.test(src)) ||
        null;
    }
  }).then(([result]) => {
    const url = result?.result;
    console.log("EasyLMS: extracted URL", url);

    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return;
    }

    chrome.tabs.sendMessage(tabId, {
      type: "EasyLMS_RESULT",
      requestId: message.requestId,
      url
    }, { frameId: 0 }).catch(() => {
      // The listing page may have been closed before extraction completed.
    });
  }).catch((error) => {
    console.warn("EasyLMS: viewer extraction failed", error);
  });
});
