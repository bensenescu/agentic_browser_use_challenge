/**
 * Drag and drop tool (Playwright-backed).
 *
 * Strategy order:
 * 1. "react" — Call React onDragStart/onDrop handlers directly (fastest, most reliable for React apps)
 * 2. "dataTransfer" — Dispatch synthetic DragEvent with DataTransfer
 * 3. "mouse" — Raw mouse move from source center to target center
 * 4. "dragTo" — Playwright's built-in dragTo
 *
 * "auto" tries react -> dataTransfer -> mouse -> dragTo, stopping at first success.
 */
import { toolDefinition } from "@tanstack/ai"
import { z } from "zod"
import { getPage } from "./browser"
import { dismissPopups } from "./dismiss-helper"

type Strategy = "auto" | "react" | "dragTo" | "mouse" | "dataTransfer"

interface DragPair {
  sourceSelector?: string
  sourceText?: string
  sourceIndex?: number
  targetSelector?: string
  targetText?: string
  targetIndex?: number
}

const dragAndDropDef = toolDefinition({
  name: "drag_and_drop",
  description:
    "Drag and drop from a source element to a target element using Playwright. Supports multiple strategies (react, dragTo, mouse, dataTransfer). The 'react' strategy calls React handlers directly and is fastest/most reliable for React apps.",
  inputSchema: z.object({
    pairs: z.array(
      z.object({
        sourceSelector: z.string().optional(),
        sourceText: z.string().optional(),
        sourceIndex: z.number().optional(),
        targetSelector: z.string().optional(),
        targetText: z.string().optional(),
        targetIndex: z.number().optional(),
      })
    ).optional().describe("Optional list of drag pairs to run in order."),
    sourceSelector: z.string().optional().describe("CSS selector for the draggable source element."),
    sourceText: z.string().optional().describe("Visible text for the draggable source element."),
    sourceIndex: z.number().optional().describe("Zero-based index to disambiguate source matches."),
    targetSelector: z.string().optional().describe("CSS selector for the drop target element."),
    targetText: z.string().optional().describe("Visible text for the drop target element."),
    targetIndex: z.number().optional().describe("Zero-based index to disambiguate target matches."),
    strategy: z.enum(["auto", "react", "dragTo", "mouse", "dataTransfer"]).optional().describe("DnD strategy. 'auto' tries react -> dataTransfer -> mouse -> dragTo. Default: auto."),
    steps: z.number().optional().describe("Mouse move steps (for mouse strategy). Default 12."),
    timeoutMs: z.number().optional().describe("Timeout for each strategy attempt (ms). Default 3000."),
  }),
})

export const dragAndDrop = dragAndDropDef.server(async (args) => {
  const page = await getPage()
  const timeout = args.timeoutMs ?? 3000
  const steps = args.steps ?? 12

  if (!args.pairs && !args.sourceSelector && !args.sourceText) {
    return JSON.stringify({ error: "provide pairs or sourceSelector/sourceText and targetSelector/targetText" })
  }

  await dismissPopups(page)

  // Build pairs array
  const pairs: DragPair[] =
    args.pairs && args.pairs.length > 0
      ? args.pairs
      : [
          {
            sourceSelector: args.sourceSelector,
            sourceText: args.sourceText,
            sourceIndex: args.sourceIndex,
            targetSelector: args.targetSelector,
            targetText: args.targetText,
            targetIndex: args.targetIndex,
          },
        ]

  if (!pairs[0]?.sourceSelector && !pairs[0]?.sourceText) {
    return JSON.stringify({ error: "provide pairs or sourceSelector/sourceText and targetSelector/targetText" })
  }

  const strategies: Strategy[] =
    args.strategy && args.strategy !== "auto"
      ? [args.strategy]
      : ["react", "dataTransfer", "mouse", "dragTo"]

  // ---- React strategy: run ALL pairs in one page.evaluate call ----
  if (strategies.includes("react")) {
    try {
      const result = await page.evaluate(
        async ({ pairs, delayMs }: { pairs: DragPair[]; delayMs: number }) => {
          const findElement = (
            selector: string | undefined,
            text: string | undefined,
            index: number,
            kind: "source" | "target"
          ): Element | null => {
            if (selector) {
              const els = document.querySelectorAll(selector)
              return els[index] || null
            }
            if (text) {
              let candidates: Element[]
              if (kind === "source") {
                candidates = [
                  ...document.querySelectorAll(
                    '[draggable="true"], [class*="piece"], [class*="drag"], [role="button"][class*="cursor"]'
                  ),
                ]
              } else {
                candidates = [
                  ...document.querySelectorAll(
                    '[class*="slot"], [class*="drop"], [class*="zone"], [class*="border-dashed"]'
                  ),
                ]
              }
              const matches = candidates.filter((el) =>
                (el as HTMLElement).innerText?.trim().includes(text)
              )
              return matches[index] || null
            }
            return null
          }

          const getReactProps = (el: Element): Record<string, any> | null => {
            const key = Object.keys(el).find((k) =>
              k.startsWith("__reactProps")
            )
            return key ? (el as any)[key] : null
          }

          const outputs: string[] = []

          for (let i = 0; i < pairs.length; i++) {
            const p = pairs[i]
            const source = findElement(
              p.sourceSelector,
              p.sourceText,
              p.sourceIndex ?? 0,
              "source"
            )
            const target = findElement(
              p.targetSelector,
              p.targetText,
              p.targetIndex ?? 0,
              "target"
            )

            if (!source || !target) {
              outputs.push(
                `pair:${i}:error:${!source ? "source" : "target"}-not-found`
              )
              continue
            }

            const sourceProps = getReactProps(source)
            const targetProps = getReactProps(target)

            if (
              !sourceProps?.onDragStart ||
              !targetProps?.onDrop
            ) {
              outputs.push(
                `pair:${i}:error:no-react-handlers(src:${!!sourceProps?.onDragStart},tgt:${!!targetProps?.onDrop})`
              )
              continue
            }

            const dt = new DataTransfer()
            const fakeEvt = (extra?: Record<string, any>) => ({
              dataTransfer: dt,
              preventDefault: () => {},
              stopPropagation: () => {},
              ...extra,
            })

            // Call onDragStart
            sourceProps.onDragStart(fakeEvt())

            // Wait for React to flush state from onDragStart
            await new Promise((r) => setTimeout(r, delayMs))

            // Re-query target since React may have re-rendered
            const freshTarget = findElement(
              p.targetSelector,
              p.targetText,
              p.targetIndex ?? 0,
              "target"
            )
            const freshTargetProps = freshTarget
              ? getReactProps(freshTarget)
              : null

            if (freshTargetProps?.onDragOver) {
              freshTargetProps.onDragOver(fakeEvt())
            }

            if (freshTargetProps?.onDrop) {
              freshTargetProps.onDrop(fakeEvt())
            } else if (targetProps?.onDrop) {
              targetProps.onDrop(fakeEvt())
            }

            // Wait for React to process the drop
            await new Promise((r) => setTimeout(r, delayMs))

            outputs.push(`pair:${i}:react:ok`)
          }

          // Return page state info
          const pageText = document.body.innerText
          const filledMatch = pageText.match(/(\d+)\/(\d+)\s*filled/)
          const codeMatch = pageText.match(
            /(?:code\s*(?:is)?[:\s]*)\s*([A-Z0-9]{4,8})/i
          )
          const sixCharCodes = [
            ...new Set(pageText.match(/\b[A-Z0-9]{6}\b/g) || []),
          ]

          return {
            results: outputs,
            filled: filledMatch ? `${filledMatch[1]}/${filledMatch[2]}` : null,
            revealedCode: codeMatch?.[1] || null,
            sixCharCodes: sixCharCodes.slice(0, 5),
          }
        },
        { pairs, delayMs: 100 }
      )

      // If react strategy worked for all pairs, return immediately
      const allOk = result.results.every((r: string) => r.includes(":ok"))
      if (allOk) {
        return JSON.stringify({ strategy: "react", status: "ok", ...result })
      }
      // If some pairs failed, fall through to next strategy
      if (result.results.some((r: string) => r.includes(":ok"))) {
        return JSON.stringify({ strategy: "react", status: "partial", ...result })
      }
      // All failed — fall through
    } catch (e: any) {
      // React strategy failed entirely — fall through
      if (strategies.length === 1) {
        return JSON.stringify({ strategy: "react", error: e.message })
      }
    }
  }

  // ---- Non-react strategies: use Playwright locators ----
  const resolveLocator = (
    selector?: string,
    text?: string,
    index?: number,
    kind?: "source" | "target"
  ) => {
    if (selector) return page.locator(selector).nth(index ?? 0)
    if (text) {
      if (kind === "source") {
        return page
          .locator(
            '[draggable="true"], [class*="piece"], [class*="drag"], [role="button"]'
          )
          .filter({ hasText: text })
          .nth(index ?? 0)
      }
      if (kind === "target") {
        return page
          .locator(
            '[data-slot], [class*="slot"], [class*="drop"], [aria-label*="Slot"], [role="button"]'
          )
          .filter({ hasText: text })
          .nth(index ?? 0)
      }
      return page.getByText(text, { exact: false }).nth(index ?? 0)
    }
    return null
  }

  const ensureVisible = async (locator: any, label: string) => {
    try {
      await locator.first().waitFor({ state: "visible", timeout: Math.min(1500, timeout) })
      return null
    } catch {
      return `${label}-not-found`
    }
  }

  const runOne = async (pair: DragPair, index: number) => {
    const source = resolveLocator(pair.sourceSelector, pair.sourceText, pair.sourceIndex, "source")
    const target = resolveLocator(pair.targetSelector, pair.targetText, pair.targetIndex, "target")

    if (!source || !target) return `pair:${index}:error:missing-locator`

    const sourceErr = await ensureVisible(source, "source")
    if (sourceErr) return `pair:${index}:error:${sourceErr}`
    const targetErr = await ensureVisible(target, "target")
    if (targetErr) return `pair:${index}:error:${targetErr}`

    const remainingStrategies = strategies.filter(
      (s) => s !== "react" && s !== "auto"
    )
    const results: string[] = []

    for (const strat of remainingStrategies) {
      try {
        if (strat === "dataTransfer") {
          const sourceHandle = await source.elementHandle()
          const targetHandle = await target.elementHandle()
          if (!sourceHandle || !targetHandle) throw new Error("missing handle")
          await page.evaluate(
            (args: any[]) => {
              const [src, dst] = args
              const dt = new DataTransfer()
              const fire = (el: Element, type: string) => {
                el.dispatchEvent(
                  new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
                )
              }
              fire(src, "dragstart")
              fire(dst, "dragenter")
              fire(dst, "dragover")
              fire(dst, "drop")
              fire(src, "dragend")
            },
            [sourceHandle, targetHandle]
          )
          results.push("dataTransfer:ok")
          return `pair:${index}:${results.join(",")}`
        }

        if (strat === "mouse") {
          const sb = await source.boundingBox()
          const tb = await target.boundingBox()
          if (!sb || !tb) throw new Error("missing bounding box")
          await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
          await page.mouse.down()
          await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps })
          await page.mouse.up()
          results.push("mouse:ok")
          return `pair:${index}:${results.join(",")}`
        }

        if (strat === "dragTo") {
          await source.dragTo(target, { timeout, force: true })
          results.push("dragTo:ok")
          return `pair:${index}:${results.join(",")}`
        }
      } catch (e: any) {
        results.push(`${strat}:error:${e.message.substring(0, 80)}`)
      }
    }

    return `pair:${index}:${results.join(",") || "no-strategy-ran"}`
  }

  const outputs: string[] = []
  for (let i = 0; i < pairs.length; i++) {
    outputs.push(await runOne(pairs[i], i))
  }

  return JSON.stringify({ result: outputs.join(" | ") })
})
