/**
 * Registers happy-dom as the global DOM for node:test runs of the desktop
 * renderer. The repo test runner is Node's native runner (no jsdom/vitest),
 * and `@happy-dom/global-registrator` is not a dependency — this file mirrors
 * that package's documented global registration using happy-dom's own
 * `GlobalWindow`, so React 19 `createRoot` and Testing Library find
 * window/document at import time.
 *
 * Imported BEFORE the test files via
 * `node --import tsx --import ./desktop/renderer/test-setup/register-dom.ts --test …`.
 * Registration is idempotent: a second import is a no-op.
 */

import React from 'react'
import { GlobalWindow, PropertySymbol } from 'happy-dom'

// The repo test runner invokes tsx from the repository root, where tsx's
// cwd-based tsconfig lookup resolves the ROOT tsconfig.json — its `include`
// ("src", "vite.config.ts") does not cover desktop/renderer, so esbuild falls
// back to the CLASSIC JSX transform (`React.createElement`) for every
// renderer .tsx file under test (App.tsx and the pages included). Provide the
// React global that transform references; the Vite build is unaffected (it
// compiles with the renderer tsconfig's automatic JSX runtime).
;(globalThis as { React?: typeof React }).React = React

// Same ignore list as @happy-dom/global-registrator: these keys must keep
// pointing at the real Node.js globals.
const IGNORED_KEYS = new Set(['constructor', 'undefined', 'NaN', 'global', 'globalThis'])

type GlobalRecord = Record<PropertyKey, unknown>

function register(): void {
  const global = globalThis as GlobalRecord & {
    __returnAppHappyDomRegistered?: boolean
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  if (global.__returnAppHappyDomRegistered) return

  const window = new GlobalWindow({
    url: 'http://localhost/',
    console: globalThis.console,
  })

  // Copy every own property of the GlobalWindow onto globalThis. Where the
  // property is the window itself (`window`, `self`, `top`, …) substitute
  // globalThis so browser-style `window === globalThis` holds. Properties
  // Node already provides with an identical value (e.g. `console`, passed in
  // above) are left untouched.
  const descriptors = Object.getOwnPropertyDescriptors(window)
  for (const key of Object.keys(descriptors)) {
    if (IGNORED_KEYS.has(key)) continue
    const descriptor = descriptors[key]
    if (descriptor.value === window) {
      descriptor.value = globalThis
      ;(window as unknown as GlobalRecord)[key] = globalThis
    }
    const existing = Object.getOwnPropertyDescriptor(globalThis, key)
    if (existing?.value !== undefined && existing.value === descriptor.value) continue
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true })
  }

  // Symbol-keyed internals (mutation observers, element caches, …) must also
  // live on globalThis because happy-dom resolves them through
  // `document.defaultView`, which we point at globalThis below.
  for (const symbol of Object.getOwnPropertySymbols(window)) {
    const descriptor = Object.getOwnPropertyDescriptor(window, symbol)
    if (!descriptor) continue
    if (descriptor.value === window) {
      descriptor.value = globalThis
      ;(window as unknown as GlobalRecord)[symbol] = globalThis
    }
    Object.defineProperty(globalThis, symbol, { ...descriptor, configurable: true })
  }

  // `document.defaultView === globalThis` is what makes copied symbol
  // internals resolvable (same trick as @happy-dom/global-registrator).
  ;(globalThis.document as unknown as GlobalRecord)[PropertySymbol.defaultView] = globalThis

  // React's `act()` (used by Testing Library render/fireEvent) requires this
  // flag in development builds.
  global.IS_REACT_ACT_ENVIRONMENT = true

  // happy-dom implements no EventSource (the SSE client the Dashboard log
  // stream opens at GET /api/logs/stream) and Node has no global one either.
  // An inert stand-in lets components mount; it never emits, which matches the
  // "engine offline" reality these tests model, and close() is a no-op.
  if (global.EventSource === undefined) {
    class InertEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readonly url: string
      readonly withCredentials = false
      readonly readyState: number = InertEventSource.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      constructor(url: string | URL) {
        this.url = String(url)
      }

      close(): void {
        Object.defineProperty(this, 'readyState', { value: InertEventSource.CLOSED })
      }

      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return false
      }
    }
    global.EventSource = InertEventSource as unknown as typeof EventSource
  }

  // happy-dom leaves scrollIntoView unimplemented; pages smooth-scroll to a
  // form section after saving. A no-op keeps those handlers from crashing.
  const elementPrototype = globalThis.HTMLElement?.prototype as unknown as Record<string, unknown>
  if (elementPrototype && typeof elementPrototype.scrollIntoView !== 'function') {
    elementPrototype.scrollIntoView = () => undefined
  }

  global.__returnAppHappyDomRegistered = true
}

register()
