// Layout smoke test for the product shell.
//
// Scope is narrow on purpose: the shell renders, it fills the window, and the
// sidebar is the width it claims to be. There is no Tauri runtime in a plain
// browser, so every IPC call rejects — App.refresh() catches that and shows a
// notice, and the shell still renders. Assert on geometry, never on host data.

import { expect, type Page, test } from "@playwright/test";

// react-resizable-panels v4 puts `data-panel` on the flex-sized element itself
// and mirrors the panel's `id` prop onto it, so this addresses the exact box
// whose width is under test.
const SIDEBAR = "[data-panel]#sidebar";
const GROUP = "[data-group]";
const SEPARATOR = "[data-separator]";

// The contract these numbers come from lives in ui/src/App.tsx. Restated here
// rather than imported: a test that derives its expectation from the code under
// test cannot fail when that code is wrong.
const SIDEBAR_PCT = 22;
const SIDEBAR_MIN_PX = 200;
const SIDEBAR_MAX_PX = 420;

/**
 * Sub-pixel slack. Flex distributes fractional leftovers, so a clamped panel
 * lands on 420.01 rather than 420 — but every regression this file exists to
 * catch is off by tens or hundreds of pixels, not by one.
 */
const EPSILON_PX = 2;

/** Navigate to the app, collecting anything the page reports as an error. */
async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto("/");
  await expect(page.locator(SIDEBAR)).toBeVisible();
  return errors;
}

/**
 * Width of the sidebar panel, and the space the group had to divide.
 *
 * The separator is laid out before the panels get their share, so a percentage
 * size resolves against `group - separator` (at 1280px the sidebar measures
 * 281.38 = 22% of 1279, not of 1280). Measuring the separator instead of
 * hardcoding its 1px keeps the arithmetic honest if the handle ever gains
 * width.
 */
function measureSidebar(page: Page) {
  return page.evaluate(
    ([sidebarSel, groupSel, separatorSel]) => {
      const width = (sel: string) =>
        document.querySelector(sel)?.getBoundingClientRect().width ?? Number.NaN;
      const group = width(groupSel);
      return { sidebar: width(sidebarSel), available: group - width(separatorSel) };
    },
    [SIDEBAR, GROUP, SEPARATOR],
  );
}

const CASES = [
  {
    width: 1280,
    height: 800,
    why: `honours the ${SIDEBAR_PCT}% default`,
    expected: (available: number) => (available * SIDEBAR_PCT) / 100,
  },
  {
    width: 820,
    height: 800,
    why: `clamps up to the ${SIDEBAR_MIN_PX}px minimum`,
    expected: () => SIDEBAR_MIN_PX,
  },
  {
    width: 2560,
    height: 900,
    why: `clamps down to the ${SIDEBAR_MAX_PX}px maximum`,
    expected: () => SIDEBAR_MAX_PX,
  },
];

for (const { width, height, why, expected } of CASES) {
  test.describe(`sidebar at ${width}px`, () => {
    // Sets the viewport before the page exists, so the app *loads* at this
    // size. Deliberate: sizing a loaded page with page.setViewportSize() would
    // exercise the resize path (which measured correct at these widths), while
    // the bug this file exists for lived entirely in first paint — the group
    // measures 0 before layout, `defaultSize` is dropped, and the panel is left
    // pinned to whatever `maxSize` says. Only a cold load at each width reaches
    // that. Resize is a separate path and is knowingly not covered here.
    test.use({ viewport: { width, height } });

    test(why, async ({ page }) => {
      await openApp(page);

      // The panel renders once at a provisional size before the group has
      // measured itself — the same first-render gap that makes `defaultSize`
      // unreliable and pushed the initial split onto `defaultLayout`. Poll
      // rather than sleep, so this settles as fast as the browser allows.
      await expect(async () => {
        const { sidebar, available } = await measureSidebar(page);
        const want = expected(available);
        expect(
          Math.abs(sidebar - want),
          `sidebar measured ${sidebar.toFixed(2)}px, expected ~${want.toFixed(2)}px ` +
            `(group had ${available.toFixed(2)}px to divide)`,
        ).toBeLessThanOrEqual(EPSILON_PX);
      }).toPass({ timeout: 5_000 });
    });
  });
}

test("the shell fills the viewport", async ({ page }) => {
  await openApp(page);

  // `html, body, #root { height: 100% }` in index.css is the only thing making
  // the shell's `h-full` resolve to anything. Drop that rule and every box
  // collapses to content height, which no unit test would notice.
  const boxes = await page.evaluate(() => {
    const measure = (label: string, el: Element | null) => {
      const rect = el?.getBoundingClientRect();
      return {
        label,
        width: rect?.width ?? Number.NaN,
        height: rect?.height ?? Number.NaN,
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      elements: [
        measure("html", document.documentElement),
        measure("body", document.body),
        measure("#root", document.getElementById("root")),
        measure("shell", document.querySelector("#root > div")),
      ],
    };
  });

  for (const { label, width, height } of boxes.elements) {
    expect(width, `${label} width`).toBeCloseTo(boxes.viewport.width, 0);
    expect(height, `${label} height`).toBeCloseTo(boxes.viewport.height, 0);
  }
});

test("loads without console errors", async ({ page }) => {
  const errors = await openApp(page);

  // Every IPC call fails here, so this also pins the promise: the failure is
  // caught and surfaced as a notice, never left to reject unhandled.
  await expect(page.locator(SIDEBAR)).toBeVisible();
  expect(errors).toEqual([]);
});
