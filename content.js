(() => {
  if (window !== window.top) {
    console.log("EasyLMS: viewer frame content script loaded", location.href);
    setInterval(() => {
      chrome.runtime.sendMessage({
        type: "EasyLMS_EXTRACT_FROM_FRAME"
      }).catch(() => {
      });
    }, 500);
    return;
  }

  const BUTTON_LABEL = "Click to View";
  const PROCESSED_ATTRIBUTE = "data-EasyLMS-processed";
  const PPT_URL_PATTERN =
    /\.(pptx?|ppsx?|potx?|odp)(?:[?#]|$)|[?&](?:filetype|type|format)=pptx?(?:[&#]|$)|[?&](?:file|url|src|path)=[^&#]*\.(?:pptx?|ppsx?|potx?|odp)(?:[&#]|$)/i;
  let activeRequest = null;
  let extractionTimer = null;
  let framesBeforeClick = new Map();

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.type !== "EasyLMS_RESULT" ||
      !activeRequest
    ) {
      return;
    }

    const url = message.url;
    console.log("EasyLMS: received viewer URL", url);
    if (!/^https?:\/\//i.test(url)) {
      console.error("EasyLMS: viewer returned an invalid URL");
      activeRequest = null;
      return;
    }

    const filename = `${activeRequest.filenameBase}${
      PPT_URL_PATTERN.test(url) ? ".pptx" : ".pdf"
    }`;

    chrome.runtime.sendMessage({
      type: "EasyLMS_DOWNLOAD",
      url,
      filename
    }).catch((error) => {
      console.error("EasyLMS: download request failed", error);
    });

    closeNewViewerFrames();

    if (extractionTimer) {
      clearInterval(extractionTimer);
      extractionTimer = null;
    }
    activeRequest = null;
  });

  function findViewButtons() {
    return [...document.querySelectorAll("ed-primary-button")]
      .filter((element) => {
        const text = element.textContent || "";
        return text.toLowerCase().includes(BUTTON_LABEL.toLowerCase());
      });
  }

  function findClickableButton(element) {
    let current = element;

    while (current) {
      if (current.shadowRoot) {
        const nativeButton = current.shadowRoot.querySelector("button");
        if (nativeButton) {
          return nativeButton;
        }

        current = current.shadowRoot.querySelector("ion-button");
        continue;
      }

      current = current.querySelector?.("ion-button");
    }

    return null;
  }

  function addDownloadButton(viewButton) {
    if (viewButton.hasAttribute(PROCESSED_ATTRIBUTE)) {
      return;
    }

    viewButton.setAttribute(PROCESSED_ATTRIBUTE, "");

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "EasyLMS-download-button";
    downloadButton.textContent = "Download";
    downloadButton.title = "Download document";

    downloadButton.addEventListener("click", () => {
      const nativeButton = findClickableButton(viewButton);

      if (!nativeButton) {
        console.error("EasyLMS: could not find the portal view button", viewButton);
        return;
      }

      console.log("EasyLMS: view button found; triggering portal action");
      framesBeforeClick = new Map(
        [...document.querySelectorAll("iframe")].map((frame) => [
          frame,
          frame.src
        ])
      );
      activeRequest = {
        requestId: crypto.randomUUID(),
        filenameBase: suggestFilename(viewButton)
      };

      nativeButton.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          composed: true
        })
      );

      requestMainWorldExtraction();
    });

    viewButton.insertAdjacentElement("afterend", downloadButton);
  }

  function closeNewViewerFrames() {
    for (const frame of document.querySelectorAll("iframe")) {
      const previousSrc = framesBeforeClick.get(frame);
      const changed = previousSrc !== undefined && previousSrc !== frame.src;
      const isNew = !framesBeforeClick.has(frame);
      const looksLikeViewer = /pdf|viewer|document/i.test(frame.src);

      if ((isNew || changed) && looksLikeViewer) {
        removeViewerContainer(frame);
      }
    }

    const dialogs = document.querySelectorAll(
      "ion-modal, [role='dialog'], .modal-wrapper, .cdk-overlay-pane"
    );

    for (const dialog of dialogs) {
      const textContent = dialog.textContent || "";
      const text = textContent.toLowerCase();
      const hasPdfViewer = text.includes("pdf") ||
        dialog.querySelector("iframe, ngx-extended-pdf-viewer, pdf-viewer");

      if (hasPdfViewer) {
        removeViewerContainer(dialog);
      }
    }

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      composed: true
    }));

    for (const backdrop of document.querySelectorAll(
      "ion-backdrop, .modal-backdrop, .cdk-overlay-backdrop, .backdrop"
    )) {
      backdrop.remove();
    }

    document.body.classList.remove(
      "modal-open",
      "cdk-global-scrollblock",
      "overflow-hidden"
    );
    document.body.style.removeProperty("pointer-events");
    document.documentElement.style.removeProperty("overflow");
    document.body.style.removeProperty("overflow");
  }

  function removeViewerContainer(element) {
    const container = element.closest(
      "ion-modal, [role='dialog'], .modal-wrapper, .cdk-overlay-pane"
    );

    (container || element).remove();
  }

  function requestMainWorldExtraction() {
    if (!activeRequest) {
      return;
    }

    const request = () => {
      if (!activeRequest) {
        clearInterval(extractionTimer);
        extractionTimer = null;
        return;
      }

      chrome.runtime.sendMessage({
        type: "EasyLMS_EXTRACT_FROM_FRAME",
        requestId: activeRequest.requestId
      }).catch((error) => {
        console.error("EasyLMS: extraction request failed", error);
      });
    };

    request();
    extractionTimer = setInterval(request, 500);
    setTimeout(() => {
      if (extractionTimer) {
        clearInterval(extractionTimer);
        extractionTimer = null;
        console.warn("EasyLMS: viewer URL was not found");
      }
    }, 15000);
  }

  function suggestFilename(viewButton) {
    const panel = viewButton.closest("nz-collapse-panel");
    const titleElement = panel?.querySelector("h6");
    const text = (titleElement?.textContent || "document")
      .replace(/^\s*\d+\.\s*/, "")
      .trim();
    const safeText = text.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const date = new Date().toISOString().slice(0, 10);
    return `${safeText || "document"} - ${date}`;
  }

  function scan() {
    findViewButtons().forEach(addDownloadButton);
  }

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  scan();
  console.log("EasyLMS: content script loaded");
})();
