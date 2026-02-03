/**
 * Shared popup dismissal logic.
 * Strategy: click close buttons + move overlays offscreen.
 * Does NOT remove from DOM (breaks React) or use CSS !important (gets overridden).
 * Moving offscreen with `left:-9999px` is the most reliable way to hide
 * without fighting React or !important CSS.
 */

export async function dismissPopups(page: any): Promise<number> {
  const closed = await page.evaluate(() => {
    let count = 0

    // 1. Click all close/dismiss buttons
    const closeTexts = [
      "close", "x", "dismiss", "ok", "got it", "accept",
      "no thanks", "not now", "skip", "cancel", "decline",
    ]
    for (const el of document.querySelectorAll('button, [role="button"], a')) {
      const htmlEl = el as HTMLElement
      try {
        const style = window.getComputedStyle(htmlEl)
        if (style.display === "none" || style.visibility === "hidden") continue
      } catch { continue }
      const text = htmlEl.innerText?.trim().toLowerCase() || ""
      const aria = (htmlEl.getAttribute("aria-label") || "").toLowerCase()
      const cls = (htmlEl.className || "").toString().toLowerCase()
      const isClose =
        closeTexts.includes(text) ||
        aria.includes("close") || aria.includes("dismiss") ||
        cls.includes("close") || cls.includes("dismiss") ||
        text === "\u00d7" || text === "\u2715" || text === "\u2716"
      if (isClose) {
        // Don't click submit/verify buttons
        if (text === "submit" || text === "enter" || text === "verify" || text === "check") continue
        try { htmlEl.click(); count++ } catch {}
      }
    }

    // 2. Move overlay elements offscreen (don't remove — breaks React)
    for (const el of document.querySelectorAll("div, section, aside")) {
      try {
        const style = window.getComputedStyle(el)
        if (style.position !== "fixed" && style.position !== "absolute") continue
        const z = parseInt(style.zIndex || "0", 10)
        const cls = ((el as HTMLElement).className || "").toString().toLowerCase()
        const role = (el.getAttribute("role") || "").toLowerCase()
        if (z > 50 || cls.includes("modal") || cls.includes("overlay") ||
            cls.includes("backdrop") || cls.includes("popup") || cls.includes("dialog") ||
            cls.includes("toast") || cls.includes("banner") ||
            role === "dialog" || role === "alertdialog" ||
            el.getAttribute("aria-modal") === "true") {
          // Protect challenge content
          const text = (el as HTMLElement).innerText || ""
          if (text.includes("Step") && text.includes("of 30")) continue
          if (el.querySelector("input, textarea, select")) continue
          // Move offscreen — React-safe, can't be overridden by !important on display/visibility
          const h = el as HTMLElement
          h.style.setProperty("left", "-9999px", "important")
          h.style.setProperty("top", "-9999px", "important")
          h.style.setProperty("pointer-events", "none", "important")
          h.style.setProperty("width", "0", "important")
          h.style.setProperty("height", "0", "important")
          h.style.setProperty("overflow", "hidden", "important")
          count++
        }
      } catch {}
    }
    return count
  })

  // Escape key for any remaining native-ish dialogs
  await page.keyboard.press("Escape").catch(() => {})

  return closed
}
