/**
 * The World page's side of the link: the `window.velxio` object, injected at
 * the top of `world.html` before its own scripts, and the srcdoc that wraps
 * the page (Content-Security-Policy, runtime).
 *
 * The API follows the public World spec of velxio.dev (`world/1`):
 * ready, onFrame, set, press, release, display, on, telemetry, forwarded
 * console. Written for this fork from that description. Two additions:
 *
 *   velxio.touch(id, x, y, pressed)  touch a screen (display pixels)
 *   velxio.asset(name) -> Promise<url>  a file of the World (a .glb, a
 *                                       texture) as a blob: URL
 *   velxio.assets() -> Promise<[{name, mime, size}]>
 *
 * Messages are { velxio: 'world/1', ... }: requests carry an id and get
 * { id, result } or { id, error } back; everything else is a notification.
 */

export const WORLD_CHANNEL = 'world/1';

/** Where a World may load scripts, styles and files from (besides itself). */
export const WORLD_CDNS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
];

export const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
export const THREE_ADDONS_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/';

const cdns = WORLD_CDNS.join(' ');

export const WORLD_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${cdns}`,
  `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com`,
  `font-src data: blob: ${cdns} https://fonts.gstatic.com`,
  `img-src data: blob: ${cdns}`,
  'media-src data: blob:',
  `connect-src data: blob: ${cdns}`,
  'worker-src blob:',
].join('; ');

// Runs in the iframe, as a classic script before the page's own. Plain ES2017
// so it runs as written, whatever the page does afterwards.
export const WORLD_RUNTIME_JS = String.raw`(function () {
  'use strict';
  var CHANNEL = 'world/1';
  var parent = window.parent;
  var seq = 0;
  var waiting = new Map();
  var handlers = new Map();
  var frameFns = [];
  var canvases = new Map();
  var assetUrls = new Map();
  var info = null;
  var gotReady;
  var readyP = new Promise(function (r) { gotReady = r; });

  function send(msg) {
    msg.velxio = CHANNEL;
    try { parent.postMessage(msg, '*'); } catch (e) { /* the host went away */ }
  }
  function call(method, params) {
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      waiting.set(id, { resolve: resolve, reject: reject });
      send({ id: id, method: method, params: params });
    });
  }
  function emit(name, arg) {
    var list = handlers.get(name);
    if (!list) return;
    list.slice().forEach(function (fn) {
      try { fn(arg); } catch (e) { log('error', [e]); }
    });
  }

  // console.* -> the World log of the host (the page's console keeps working).
  var inLog = false;
  function show(v) {
    if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function log(level, args) {
    if (inLog) return;
    inLog = true;
    try {
      send({ method: 'log', params: { level: level,
        text: Array.prototype.slice.call(args, 0, 10).map(show).join(' ').slice(0, 4000) } });
    } finally { inLog = false; }
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () { log(level, arguments); orig.apply(null, arguments); };
  });
  window.addEventListener('error', function (e) {
    log('error', [e.error || (e.message + ' (' + e.filename + ':' + e.lineno + ')')]);
  });
  window.addEventListener('unhandledrejection', function (e) { log('error', [e.reason]); });

  // The iframe has an opaque origin, where Web Storage throws: pages that keep
  // a setting or a score get one that lasts as long as the page.
  function memoryStorage() {
    var data = new Map();
    return {
      get length() { return data.size; },
      key: function (i) { return Array.from(data.keys())[i] || null; },
      getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name].length; } catch (e) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e2) {}
    }
  });

  function onHost(msg) {
    if (msg.id && waiting.has(msg.id)) {
      var w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.result);
      return;
    }
    var p = msg.params;
    switch (msg.method) {
      case 'info':
        info = p;
        gotReady(p);
        break;
      case 'frame':
        for (var i = 0; i < frameFns.length; i++) {
          try { frameFns[i](p); } catch (e) { log('error', [e]); }
        }
        break;
      case 'display': {
        var c = canvases.get(p.id);
        var bmp = p.bitmap;
        if (!c || !bmp) { if (bmp && bmp.close) bmp.close(); break; }
        if (c.width !== bmp.width || c.height !== bmp.height) {
          c.width = bmp.width;
          c.height = bmp.height;
        }
        c.getContext('2d').drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        emit('display:' + p.id, { canvas: c, id: p.id });
        break;
      }
      case 'reset': emit('reset'); break;
      case 'theme': if (info) info.theme = p; emit('theme', p); break;
      case 'visibility': emit('visibility', p); break;
      case 'parts': info = p; emit('parts', p); break;
    }
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var msg = e.data;
    if (!msg || msg.velxio !== CHANNEL) return;
    onHost(msg);
  });

  var velxio = {
    version: CHANNEL,
    ready: function () { return readyP; },
    get info() { return info; },
    onFrame: function (fn) {
      frameFns.push(fn);
      return function () { frameFns = frameFns.filter(function (f) { return f !== fn; }); };
    },
    on: function (name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return function () { velxio.off(name, fn); };
    },
    off: function (name, fn) {
      var l = handlers.get(name);
      if (l) handlers.set(name, l.filter(function (f) { return f !== fn; }));
    },
    set: function (id, values) { send({ method: 'set', params: { id: id, values: values || {} } }); },
    press: function (id) { send({ method: 'press', params: { id: id } }); },
    release: function (id) { send({ method: 'release', params: { id: id } }); },
    touch: function (id, x, y, pressed) {
      send({ method: 'touch', params: { id: id, x: +x || 0, y: +y || 0, pressed: !!pressed } });
    },
    display: function (id, opts) {
      var c = canvases.get(id);
      if (!c) {
        c = document.createElement('canvas');
        var d = null;
        if (info) {
          (info.parts || []).concat(info.boards || []).forEach(function (x) { if (x.id === id && x.display) d = x.display; });
        }
        c.width = d ? d.w : 2;
        c.height = d ? d.h : 2;
        canvases.set(id, c);
      }
      send({ method: 'display', params: { id: id, fps: (opts && opts.fps) || 15 } });
      return c;
    },
    telemetry: function (data) { send({ method: 'telemetry', params: data || {} }); },
    asset: function (name) {
      if (assetUrls.has(name)) return Promise.resolve(assetUrls.get(name));
      return call('asset', { name: name }).then(function (r) {
        var url = URL.createObjectURL(new Blob([r.buffer], { type: r.mime }));
        assetUrls.set(name, url);
        return url;
      });
    },
    assets: function () { return call('assets', {}); }
  };
  Object.defineProperty(window, 'velxio', { value: Object.freeze(velxio), enumerable: true });
  // Say hello until the host answers: the page may start before the host
  // listens.
  var helloTries = 0;
  (function hello() {
    if (info || helloTries++ > 200) return;
    send({ method: 'hello', params: {} });
    setTimeout(hello, 50);
  })();
})();`;

/**
 * The iframe's srcdoc: the page with the CSP and the runtime in front of its
 * own scripts. A page without <head> gets one.
 */
export function buildWorldSrcdoc(html: string): string {
  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${WORLD_CSP}">` +
    `<script>${WORLD_RUNTIME_JS.replace(/<\/script/gi, '<\\/script')}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + '<head>' + inject + '</head>' + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return html.slice(0, at) + '<head>' + inject + '</head>' + html.slice(at);
  }
  return '<!doctype html><head>' + inject + '</head>' + html;
}
