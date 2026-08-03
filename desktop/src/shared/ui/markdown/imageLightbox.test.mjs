/**
 * Regression test for buzz#57: the spoiler-gallery lightbox nav-button race.
 *
 * Revealing a spoiler flips `data-revealed` to `"true"` synchronously, then
 * kicks off a ~200ms CSS fade-in on that same image. If the gallery scan in
 * `visibleImageGalleryForTrigger` runs before the transition's first frame
 * lands, `getComputedStyle` can still report `opacity: 0` for an image that
 * is, per `data-revealed`, already revealed. See the comment on
 * `isVisibleImageLightboxTrigger` in imageLightbox.ts for why that transient
 * opacity must not be used to re-exclude it.
 */

import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {
  ...globalThis.window,
  getComputedStyle: (element) => element.style,
};

import { visibleImageGalleryForTrigger } from "./imageLightbox.ts";

class FakeElement {
  constructor({ tag = "DIV", attrs = {}, style = {}, rect, dataset = {} }) {
    this.tagName = tag;
    this.attrs = attrs;
    this.style = {
      display: "block",
      visibility: "visible",
      opacity: "1",
      borderBottomLeftRadius: "0px",
      borderBottomRightRadius: "0px",
      borderTopLeftRadius: "0px",
      borderTopRightRadius: "0px",
      ...style,
    };
    this._rect = rect ?? { width: 100, height: 100 };
    this.dataset = dataset;
    this.children = [];
    this.parent = null;
    this.isConnected = true;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  getBoundingClientRect() {
    return this._rect;
  }

  _matches(selector) {
    const tokens = selector.match(/\.[\w-]+|\[[^\]]+\]|^[a-zA-Z][\w-]*/g) ?? [];
    return tokens.every((token) => {
      if (token.startsWith(".")) {
        return (this.attrs.class ?? "").split(/\s+/).includes(token.slice(1));
      }
      if (token.startsWith("[")) {
        const inner = token.slice(1, -1);
        const eq = inner.match(/^([\w-]+)=["']([^"']*)["']$/);
        return eq ? this.attrs[eq[1]] === eq[2] : inner in this.attrs;
      }
      return this.tagName.toLowerCase() === token.toLowerCase();
    });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node._matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  _descendants() {
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector) {
    return this._descendants().find((node) => node._matches(selector)) ?? null;
  }

  querySelectorAll(selector) {
    return this._descendants().filter((node) => node._matches(selector));
  }
}

function buildScopeWithTwoImages({ hiddenImageOpacity, spoilerRevealed }) {
  const scope = new FakeElement({ tag: "DIV" });

  const visibleTrigger = new FakeElement({
    tag: "BUTTON",
    attrs: { "data-image-lightbox-trigger": "" },
    dataset: { imageLightboxResolvedSrc: "visible-src" },
  });
  const visibleImg = new FakeElement({ tag: "IMG" });
  visibleTrigger.appendChild(visibleImg);
  scope.appendChild(visibleTrigger);

  const spoiler = new FakeElement({
    tag: "SPAN",
    attrs: {
      class: "buzz-spoiler",
      "data-spoiler": "",
      "data-revealed": spoilerRevealed ? "true" : "false",
    },
  });
  const hiddenTrigger = new FakeElement({
    tag: "BUTTON",
    attrs: { "data-image-lightbox-trigger": "" },
    dataset: { imageLightboxResolvedSrc: "hidden-src" },
  });
  const hiddenImg = new FakeElement({
    tag: "IMG",
    style: { opacity: String(hiddenImageOpacity) },
  });
  hiddenTrigger.appendChild(hiddenImg);
  spoiler.appendChild(hiddenTrigger);
  scope.appendChild(spoiler);

  return { scope, visibleTrigger, hiddenTrigger };
}

const fallbackItem = {
  alt: undefined,
  resolvedSrc: "visible-src",
  src: "visible-src",
};

test("visibleImageGalleryForTrigger includes a just-revealed spoiler image even mid fade-in transition", () => {
  const { scope, visibleTrigger } = buildScopeWithTwoImages({
    spoilerRevealed: true,
    // Simulates the CSS transition's first-frame read: data-revealed is
    // already "true" but the opacity animation hasn't ticked yet.
    hiddenImageOpacity: 0,
  });

  const result = visibleImageGalleryForTrigger(
    visibleTrigger,
    fallbackItem,
    scope,
  );

  assert.ok(result.galleryItems, "expected a multi-item gallery once revealed");
  assert.equal(result.galleryItems.length, 2);
  assert.deepEqual(
    result.galleryItems.map((item) => item.resolvedSrc),
    ["visible-src", "hidden-src"],
  );
  assert.equal(result.galleryIndex, 0);
});

test("visibleImageGalleryForTrigger still excludes an unrevealed spoiler image", () => {
  const { scope, visibleTrigger } = buildScopeWithTwoImages({
    spoilerRevealed: false,
    hiddenImageOpacity: 0,
  });

  const result = visibleImageGalleryForTrigger(
    visibleTrigger,
    fallbackItem,
    scope,
  );

  assert.equal(
    result.galleryItems,
    undefined,
    "a single visible image must not produce a multi-item gallery",
  );
});

test("visibleImageGalleryForTrigger excludes a display:none trigger unrelated to spoilers", () => {
  const scope = new FakeElement({ tag: "DIV" });
  const visibleTrigger = new FakeElement({
    tag: "BUTTON",
    attrs: { "data-image-lightbox-trigger": "" },
    dataset: { imageLightboxResolvedSrc: "visible-src" },
  });
  scope.appendChild(visibleTrigger);

  const hiddenTrigger = new FakeElement({
    tag: "BUTTON",
    attrs: { "data-image-lightbox-trigger": "" },
    dataset: { imageLightboxResolvedSrc: "display-none-src" },
    style: { display: "none" },
  });
  scope.appendChild(hiddenTrigger);

  const result = visibleImageGalleryForTrigger(
    visibleTrigger,
    fallbackItem,
    scope,
  );

  assert.equal(
    result.galleryItems,
    undefined,
    "a display:none trigger must stay excluded from the gallery",
  );
});
