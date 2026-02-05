/**
 * Shared Playwright browser singleton.
 *
 * All tools run in the same process, so they share this module's singleton variables directly.
 * The first tool call (scan_page_for_code with a url param) triggers browser launch.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"

let browser: Browser | null = null
let context: BrowserContext | null = null
let page: Page | null = null

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const headed = process.env.HEADED === "true"
    browser = await chromium.launch({
      headless: !headed,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })
  }
  return browser
}

export async function getContext(): Promise<BrowserContext> {
  if (!context) {
    const b = await getBrowser()
    context = await b.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    })

    // Override native dialogs
    await context.addInitScript(`
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => null;
    `)
  }
  return context
}

export async function getPage(): Promise<Page> {
  if (!page || page.isClosed()) {
    const ctx = await getContext()
    const pages = ctx.pages()
    page = pages.length > 0 ? pages[0] : await ctx.newPage()

    // Auto-dismiss native browser dialogs
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => {})
    })
  }
  return page
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
    context = null
    page = null
  }
}
