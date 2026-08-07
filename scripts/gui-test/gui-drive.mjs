// Drives the live GUI with REAL input events, so the app's own handlers run
// exactly as they do under a human's hands. Synthetic `element.click()` and
// `textarea.value = …` bypass the very keyboard paths a UI test needs to check.
//
// Usage: node gui-drive.mjs <actions.json>
// Actions: {wait:ms} {dom:true} {eval:"expr"} {click:"sel",nth:n} {focus:"sel"}
//          {type:"text"} {key:"Enter",modifiers:0} {shot:"name.png"} {note:"…"}
import { readFileSync, writeFileSync } from "node:fs";
import { connect, DOM_STATE_EXPRESSION } from "./cdp.mjs";

const actionsPath = process.argv[2];
if (!actionsPath) throw new Error("usage: node gui-drive.mjs <actions.json>");
const actions = JSON.parse(readFileSync(actionsPath, "utf8"));

const cdp = await connect();
const results = [];

const rectOf = async (selector, nth = 0) =>
  cdp.evaluate(`(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)});
    const node = nodes[${nth}];
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const box = node.getBoundingClientRect();
    return {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      width: Math.round(box.width),
      height: Math.round(box.height),
      visible: box.width > 0 && box.height > 0,
      className: node.className,
      label: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 80),
      disabled: node.disabled ?? null,
    };
  })()`);

/** Menus are keyed by their label, not by a stable position in the DOM. */
const rectOfText = async (text, scope = "body") =>
  cdp.evaluate(`(() => {
    const scope = document.querySelector(${JSON.stringify(scope)});
    if (!scope) return null;
    const wanted = ${JSON.stringify(text)};
    const node = [...scope.querySelectorAll('button, [role="menuitem"], a')]
      .filter((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .find((candidate) =>
        (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '')
          .trim()
          .startsWith(wanted));
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      className: node.className,
      label: (node.getAttribute('aria-label') ?? node.textContent).trim().slice(0, 60),
    };
  })()`);

const KEY_CODES = {
  Enter: { windowsVirtualKeyCode: 13, code: "Enter", key: "Enter", text: "\r" },
  Escape: { windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" },
  Tab: { windowsVirtualKeyCode: 9, code: "Tab", key: "Tab", text: "\t" },
  Backspace: {
    windowsVirtualKeyCode: 8,
    code: "Backspace",
    key: "Backspace",
  },
  ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown", key: "ArrowDown" },
  ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp", key: "ArrowUp" },
  ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft", key: "ArrowLeft" },
  ArrowRight: {
    windowsVirtualKeyCode: 39,
    code: "ArrowRight",
    key: "ArrowRight",
  },
  Home: { windowsVirtualKeyCode: 36, code: "Home", key: "Home" },
  End: { windowsVirtualKeyCode: 35, code: "End", key: "End" },
};

/**
 * The per-stage model picker opens on a right-click within 14px of the range
 * thumb, so the event has to land on the computed thumb position rather than
 * the element centre.
 */
const thumbPointOf = async (nth) =>
  cdp.evaluate(`(() => {
    const slider = document.querySelectorAll('.composer-effort-slider')[${nth}];
    if (!slider) return null;
    const range = slider.querySelector('input[type="range"]');
    const box = range.getBoundingClientRect();
    const progress = Number(range.value) / Number(range.max);
    return {
      x: Math.round(box.left + 9 + (box.width - 18) * progress),
      y: Math.round(box.top + box.height / 2),
      model: slider.dataset.model,
      effortIndex: Number(range.value),
    };
  })()`);

for (const action of actions) {
  const label = JSON.stringify(action).slice(0, 160);
  try {
    if (action.wait) {
      await new Promise((resolve) => setTimeout(resolve, action.wait));
      results.push({ action: label, ok: true });
    } else if (action.note) {
      results.push({ action: label, ok: true, note: action.note });
    } else if (action.dom) {
      results.push({
        action: label,
        ok: true,
        dom: await cdp.evaluate(DOM_STATE_EXPRESSION),
      });
    } else if (action.eval) {
      results.push({
        action: label,
        ok: true,
        value: await cdp.evaluate(action.eval),
      });
    } else if (action.click) {
      const rect = await rectOf(action.click, action.nth ?? 0);
      if (!rect || !rect.visible) {
        results.push({ action: label, ok: false, error: "not visible", rect });
      } else {
        for (const type of ["mousePressed", "mouseReleased"])
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: rect.x,
            y: rect.y,
            button: "left",
            clickCount: 1,
          });
        results.push({ action: label, ok: true, rect });
      }
    } else if (action.wheel) {
      // A provider-váltás görgetésre történik, ezt szintetikus eventtel nem
      // lehet hitelesen kipróbálni.
      const rect = await rectOf(action.wheel, action.nth ?? 0);
      if (!rect) {
        results.push({ action: label, ok: false, error: "no such element" });
      } else {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: rect.x,
          y: rect.y,
          deltaX: 0,
          deltaY: action.deltaY ?? 100,
        });
        results.push({ action: label, ok: true, rect });
      }
    } else if (action.modelMenu !== undefined) {
      const point = await thumbPointOf(action.modelMenu);
      if (!point) {
        results.push({ action: label, ok: false, error: "no slider" });
      } else {
        for (const type of ["mousePressed", "mouseReleased"])
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: point.x,
            y: point.y,
            button: "right",
            clickCount: 1,
          });
        results.push({ action: label, ok: true, point });
      }
    } else if (action.clickText) {
      const rect = await rectOfText(action.clickText, action.scope ?? "body");
      if (!rect) {
        results.push({ action: label, ok: false, error: "no match" });
      } else {
        for (const type of ["mousePressed", "mouseReleased"])
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: rect.x,
            y: rect.y,
            button: "left",
            clickCount: 1,
          });
        results.push({ action: label, ok: true, rect });
      }
    } else if (action.hover) {
      // Controls that only exist on hover (row overflow menus) measure 0×0
      // until the pointer arrives, so a click has to be preceded by a move.
      const rect = await rectOf(action.hover, action.nth ?? 0);
      if (!rect) {
        results.push({ action: label, ok: false, error: "no such element" });
      } else {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: rect.x || 1,
          y: rect.y || 1,
        });
        results.push({ action: label, ok: true, rect });
      }
    } else if (action.focus) {
      const rect = await rectOf(action.focus, action.nth ?? 0);
      await cdp.evaluate(
        `document.querySelectorAll(${JSON.stringify(action.focus)})[${action.nth ?? 0}]?.focus()`,
      );
      results.push({ action: label, ok: Boolean(rect), rect });
    } else if (action.type !== undefined) {
      await cdp.send("Input.insertText", { text: action.type });
      results.push({ action: label, ok: true });
    } else if (action.key) {
      const key = KEY_CODES[action.key];
      if (!key) throw new Error(`unmapped key ${action.key}`);
      const modifiers = action.modifiers ?? 0;
      await cdp.send("Input.dispatchKeyEvent", {
        type: key.text ? "keyDown" : "rawKeyDown",
        modifiers,
        ...key,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers,
        ...key,
        text: undefined,
      });
      results.push({ action: label, ok: true });
    } else if (action.metrics) {
      // Layout bugs hide at sizes nobody develops at; the override lets one
      // session sweep several window widths without touching the real window.
      if (action.metrics === "reset")
        await cdp.send("Emulation.clearDeviceMetricsOverride");
      else
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: action.metrics[0],
          height: action.metrics[1],
          deviceScaleFactor: action.scale ?? 1,
          mobile: false,
        });
      results.push({ action: label, ok: true });
    } else if (action.shot) {
      // `clip` turns a screenshot into evidence about one detail: a 3px rule's
      // continuity is invisible in a full-window PNG scaled down for review.
      const clip = action.around
        ? await cdp.evaluate(`(() => {
            const node = document.querySelector(${JSON.stringify(action.around)});
            if (!node) return null;
            const box = node.getBoundingClientRect();
            const pad = ${Number(action.pad ?? 40)};
            return {
              x: Math.max(0, box.left - pad),
              y: Math.max(0, box.top - pad),
              width: Math.min(window.innerWidth, box.width + pad * 2),
              height: Math.min(window.innerHeight, box.height + pad * 2),
              scale: ${Number(action.scale ?? 2)},
            };
          })()`)
        : action.clip;
      if (action.around && !clip) {
        results.push({ action: label, ok: false, error: "clip anchor missing" });
      } else {
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          ...(clip ? { clip } : {}),
          captureBeyondViewport: Boolean(clip),
        });
        writeFileSync(action.shot, Buffer.from(shot.data, "base64"));
        results.push({ action: label, ok: true, file: action.shot, clip });
      }
    } else {
      results.push({ action: label, ok: false, error: "unknown action" });
    }
  } catch (error) {
    results.push({ action: label, ok: false, error: String(error.message ?? error) });
  }
}

console.log(JSON.stringify(results, null, 2));
cdp.close();
