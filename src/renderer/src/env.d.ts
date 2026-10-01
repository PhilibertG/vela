/// <reference types="svelte" />
/// <reference path="../../preload/api.d.ts" />

declare namespace svelteHTML {
  interface IntrinsicElements {
    'browser-action-list': { partition?: string; alignment?: string; tab?: string }
  }
}
