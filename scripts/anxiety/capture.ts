// The window in a real browser, over raw CDP: the automation Brave on 127.0.0.1:9333, the same
// instance browser-use and jev-browse drive, never Karim's daily Brave and never a headless
// launch of /Applications/Brave Browser.app (the 2026-09-16 Dock tile rule).
//
// Each scene gets a window of its own (Target.createTarget newWindow), which is what keeps
// requestAnimationFrame and CSS transitions running: a tab that is not frontmost pauses both
// and a screenshot of it shows the last painted frame (vault Gotcha, 2026-09-14). The page is
// brought to the front of its own window before every shot and document.hidden is checked.
//
// The fixture unit is the CONVERSATION COLUMN'S width, not the viewport: the dock and the card
// were verified at 860 and 400 px columns (vault State, 2026-09-18), and the column is a size
// container (ui/design/layout.css). The harness sets --conv on .stage, the same custom property
// split.js writes when a person drags the handle, and widens --conv-max for the 860 fixture.
// Node's own WebSocket (24+) carries the protocol, so this needs no dependency.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Json } from './app.ts';

export const CDP_URL = process.env.ANXIETY_CDP_URL ?? 'http://127.0.0.1:9333';
const LAUNCHER = path.join(os.homedir(), '.claude', 'scripts', 'browser', 'brave-automation');

export const VIEWPORT = { width: 1440, height: 900 };
export const SCALE = 2;

export type Clip = 'conversation' | 'world' | 'page' | { x: number; y: number; width: number; height: number };

type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };

export type Page = {
  targetId: string;
  goto(url: string): Promise<void>;
  eval<T = Json>(expression: string): Promise<T>;
  // Polls `expression` until it is truthy. Throws with the expression past the deadline.
  waitFor(expression: string, timeoutMs: number, what?: string): Promise<void>;
  // A real click, at the centre of the element, through the input pipeline.
  click(selector: string): Promise<void>;
  clickText(text: string, within?: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  column(px: number): Promise<void>;
  viewport(width: number, height: number): Promise<void>;
  front(): Promise<void>;
  shot(file: string, clip: Clip): Promise<{ width: number; height: number }>;
  text(selector: string): Promise<string>;
  close(): Promise<void>;
};

export type Browser = {
  open(url?: string): Promise<Page>;
  close(): Promise<void>;
};

async function up(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/* The launcher is idempotent and answers in under a second when the browser is already up.
   Without it (another machine, ANXIETY_CDP_URL pointed elsewhere) the endpoint has to be up
   already, and the error says so rather than launching anything of its own. */
export async function ensureBrowser(): Promise<void> {
  if (await up()) return;
  if (!fs.existsSync(LAUNCHER)) throw new Error(`no browser on ${CDP_URL} and no launcher at ${LAUNCHER}: start a Chromium with --remote-debugging-port and point ANXIETY_CDP_URL at it`);
  const started = spawnSync(LAUNCHER, ['start'], { encoding: 'utf8', timeout: 30_000 });
  if (started.status !== 0 || !(await up())) throw new Error(`the automation browser did not start: ${started.stdout}${started.stderr}`);
}

export async function connectBrowser(): Promise<Browser> {
  await ensureBrowser();
  const version = (await (await fetch(`${CDP_URL}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`could not open ${version.webSocketDebuggerUrl}`));
  });
  let seq = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(params: Json) => void>>();
  ws.onmessage = (message) => {
    const msg = JSON.parse(String(message.data)) as { id?: number; result?: Json; error?: Json; method?: string; params?: Json; sessionId?: string };
    if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id) as Pending;
      pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(new Error(`CDP ${JSON.stringify(msg.error)}`));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined) {
      const key = `${msg.sessionId ?? ''}:${msg.method}`;
      for (const fn of listeners.get(key) ?? []) fn(msg.params);
    }
  };
  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Json> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }
  function on(sessionId: string, method: string, fn: (params: Json) => void): () => void {
    const key = `${sessionId}:${method}`;
    const set = listeners.get(key) ?? new Set();
    set.add(fn);
    listeners.set(key, set);
    return () => set.delete(fn);
  }

  const opened: string[] = [];

  async function open(url: string = 'about:blank'): Promise<Page> {
    const { targetId } = (await send('Target.createTarget', { url: 'about:blank', newWindow: true, width: VIEWPORT.width, height: VIEWPORT.height })) as { targetId: string };
    opened.push(targetId);
    const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: SCALE, mobile: false }, sessionId);
    // Animations still run; a motion-reduced page would not be the page a person sees.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);

    const evaluate = async <T,>(expression: string): Promise<T> => {
      const out = (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)) as Json;
      if (out.exceptionDetails !== undefined) throw new Error(`page threw: ${out.exceptionDetails.text ?? ''} ${out.exceptionDetails.exception?.description ?? ''}`.trim());
      return out.result?.value as T;
    };

    const goto = async (target: string): Promise<void> => {
      const loaded = new Promise<void>((resolve) => {
        const off = on(sessionId, 'Page.loadEventFired', () => {
          off();
          resolve();
        });
      });
      await send('Page.navigate', { url: target }, sessionId);
      await Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
    };

    const waitFor = async (expression: string, timeoutMs: number, what?: string): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let value: unknown = false;
        try {
          value = await evaluate(expression);
        } catch {
          value = false;
        }
        if (value) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what ?? expression}`);
    };

    const centre = async (selector: string): Promise<{ x: number; y: number }> => {
      const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
        `(function () { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      );
      if (rect === null) throw new Error(`no element matches ${selector}`);
      if (rect.width === 0 || rect.height === 0) throw new Error(`${selector} has no size to click`);
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };

    const clickAt = async (x: number, y: number): Promise<void> => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    };

    const page: Page = {
      targetId,
      goto,
      eval: evaluate,
      waitFor,
      click: async (selector) => {
        const at = await centre(selector);
        await clickAt(at.x, at.y);
      },
      /* The visible element whose own text is exactly `text`, buttons first, the way a person
         finds it. `within` narrows the search to one host so two screens with a "Continue" do
         not collide. */
      clickText: async (text, within) => {
        const marked = await evaluate<boolean>(
          `(function () {
            var host = ${within === undefined ? 'document' : `document.querySelector(${JSON.stringify(within)})`};
            if (!host) return false;
            var want = ${JSON.stringify(text)}.trim();
            var nodes = host.querySelectorAll('button, a, [role="button"], label, .choice');
            for (var i = 0; i < nodes.length; i += 1) {
              var el = nodes[i];
              if (el.offsetParent === null) continue;
              if ((el.innerText || el.textContent || '').trim() === want) { el.setAttribute('data-anxiety-target', '1'); return true; }
            }
            return false;
          })()`,
        );
        if (!marked) throw new Error(`no visible control reads "${text}"${within === undefined ? '' : ` inside ${within}`}`);
        try {
          const at = await centre('[data-anxiety-target="1"]');
          await clickAt(at.x, at.y);
        } finally {
          await evaluate('(function () { var el = document.querySelector("[data-anxiety-target]"); if (el) el.removeAttribute("data-anxiety-target"); return 1; })()').catch(() => undefined);
        }
      },
      type: async (selector, text) => {
        const at = await centre(selector);
        await clickAt(at.x, at.y);
        await send('Input.insertText', { text }, sessionId);
      },
      press: async (key) => {
        const keys: Record<string, { code: string; keyCode: number }> = { Enter: { code: 'Enter', keyCode: 13 }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 } };
        const k = keys[key] ?? { code: key, keyCode: 0 };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode }, sessionId);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode }, sessionId);
      },
      column: async (px) => {
        await evaluate(
          `(function () { var s = document.querySelector('.stage'); if (!s) return false;
            s.style.setProperty('--conv', '${px}px'); s.style.setProperty('--conv-min', '${px}px'); s.style.setProperty('--conv-max', '${px}px'); return true; })()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      },
      viewport: async (width, height) => {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: SCALE, mobile: false }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 250));
      },
      front: async () => {
        await send('Page.bringToFront', {}, sessionId);
      },
      shot: async (file, clip) => {
        await send('Page.bringToFront', {}, sessionId);
        const hidden = await evaluate<boolean>('document.hidden');
        if (hidden) throw new Error('the page is hidden, so its animations are paused and a shot would show a stale frame');
        // Fonts, one more frame, then the picture.
        await evaluate('document.fonts.ready.then(function () { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); })');
        let region: { x: number; y: number; width: number; height: number } | undefined;
        if (clip === 'conversation' || clip === 'world') {
          const selector = clip === 'conversation' ? '.conversation' : '.world';
          region = await evaluate(`(function () { var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
        } else if (clip !== 'page') {
          region = clip;
        }
        const out = (await send(
          'Page.captureScreenshot',
          region === undefined ? { format: 'png' } : { format: 'png', clip: { ...region, scale: 1 } },
          sessionId,
        )) as { data: string };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(out.data, 'base64'));
        return region === undefined ? { width: VIEWPORT.width * SCALE, height: VIEWPORT.height * SCALE } : { width: Math.round(region.width * SCALE), height: Math.round(region.height * SCALE) };
      },
      text: (selector) => evaluate<string>(`(function () { var el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`),
      close: async () => {
        await send('Target.closeTarget', { targetId }).catch(() => undefined);
        const at = opened.indexOf(targetId);
        if (at !== -1) opened.splice(at, 1);
      },
    };
    if (url !== 'about:blank') await goto(url);
    return page;
  }

  return {
    open,
    close: async () => {
      // Only the windows this run opened. A peer session's tabs are never touched.
      for (const targetId of [...opened]) await send('Target.closeTarget', { targetId }).catch(() => undefined);
      opened.length = 0;
      ws.close();
    },
  };
}

/* End of the browser job, the shared-instance protocol from ~/.claude/references/browsing.md:
   our own windows are closed above, then the launcher's `done` quits the browser only when no
   other session can still be using it. Never `stop`. */
export function browserDone(): string {
  if (!fs.existsSync(LAUNCHER)) return 'no launcher, browser left as found';
  const out = spawnSync(LAUNCHER, ['done'], { encoding: 'utf8', timeout: 30_000 });
  return `${out.stdout ?? ''}${out.stderr ?? ''}`.trim();
}
