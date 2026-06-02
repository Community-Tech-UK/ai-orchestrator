// Runs in the page's MAIN world at document_start (see manifest content_scripts).
//
// Many components attach a *closed* shadow root (`attachShadow({mode:'closed'})`),
// which makes `element.shadowRoot` return null and hides their internals from the
// Browser Gateway's deepQuerySelector / snapshot traversal (which can only walk
// open roots). We coerce closed roots to open so automation can see and act on
// elements inside web components — the same behaviour Playwright/Puppeteer rely on.
//
// This only changes external *visibility* of the root; page code keeps the
// reference it received from attachShadow regardless, so functionality is
// preserved. It must run before the page creates its shadow roots, hence
// document_start + MAIN world.
(() => {
  try {
    const proto = Element.prototype;
    const original = proto.attachShadow;
    if (typeof original !== 'function' || original.__aioOpenShadow) {
      return;
    }
    const patched = function attachShadow(init) {
      const options = init && init.mode === 'closed'
        ? Object.assign({}, init, { mode: 'open' })
        : init;
      return original.call(this, options);
    };
    patched.__aioOpenShadow = true;
    proto.attachShadow = patched;
  } catch (error) {
    // If anything goes wrong, leave the native behaviour untouched.
    void error;
  }
})();
