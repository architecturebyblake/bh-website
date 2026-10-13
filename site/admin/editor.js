/* Visual editor for the Blake Hurst website.
 * Loads the real pages in a frame, lets you edit text/photos in place, and
 * publishes all changes to GitHub in one commit (Netlify then rebuilds the site).
 */
(function () {
  'use strict';
  var CFG = { owner: 'architecturebyblake', repo: 'bh-website', branch: 'main', root: 'site' };
  var API = 'https://api.github.com';
  var $ = function (s) { return document.querySelector(s); };

  var NAMES = {
    'index.html': 'Home', 'Profile.html': 'The Firm: Profile', 'Services.html': 'The Firm: Services',
    'People.html': 'The Firm: People', 'Contact.html': 'Contact', 'Inquiries.html': 'Contact: Inquiries',
    'Social.html': 'Contact: Social (Instagram)', 'Places.html': 'Contact: Places We Serve',
    'NewHomes.html': 'Portfolio: New Homes', 'Additions.html': 'Portfolio: Additions',
    'Renovations.html': 'Portfolio: Interior Renovations', 'Design.html': 'In Process: In Design',
    'InConstruction.html': 'In Process: Under Construction', 'Visualizations.html': 'In Process: Visualizations'
  };
  var LISTINGS = ['NewHomes.html', 'Additions.html', 'Renovations.html'];

  var token = null;
  try { token = sessionStorage.getItem('bh_token'); } catch (e) {}
  var S = {
    files: [],            // html page names in the repo (and staged new ones)
    pages: {},            // name -> { html, baseline, isNew }
    current: null,
    pending: {},          // repo path -> Blob (photos not yet published)
    urlToPath: {},        // blob: url -> repo path
    pathToUrl: {},
    deleted: {},          // page name -> true
    undo: [],
    redo: [],
    frame: null, doc: null, win: null, toolbar: null, selEl: null, busy: false
  };

  // ---------------------------------------------------------------- helpers
  function status(msg, kind) {
    var el = $('#status'); el.textContent = msg || ''; el.style.color = kind === 'err' ? '#f2b3a6' : '';
  }
  function slugify(t) { return String(t).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function prettyName(n) {
    if (NAMES[n]) return NAMES[n];
    return n.replace(/\.html$/, '').replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function b64(blobOrText) {
    return new Promise(function (res, rej) {
      var blob = typeof blobOrText === 'string' ? new Blob([blobOrText], { type: 'text/plain;charset=utf-8' }) : blobOrText;
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1] || ''); };
      r.onerror = rej; r.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------- GitHub
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, opts.headers || {});
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body }).then(function (r) {
      if (r.status === 401) { logout(); throw new Error('Your login expired. Please log in again.'); }
      if (!r.ok) { return r.text().then(function (t) { var e = new Error(t || r.statusText); e.status = r.status; throw e; }); }
      return r.status === 204 ? null : (opts.raw ? r.text() : r.json());
    });
  }
  var repoPath = function (p) { return '/repos/' + CFG.owner + '/' + CFG.repo + p; };

  function login() {
    return new Promise(function (resolve, reject) {
      var site = location.host.split(':')[0];
      var url = 'https://api.netlify.com/auth?provider=github&site_id=' + encodeURIComponent(site) + '&scope=repo';
      var w = window.open(url, 'bh-auth', 'width=620,height=760');
      if (!w) { reject(new Error('Your browser blocked the login window. Allow pop-ups for this site and try again.')); return; }
      var done = false;
      function onMsg(e) {
        if (e.origin !== 'https://api.netlify.com') return;
        if (e.data === 'authorizing:github') { w.postMessage('authorizing:github', e.origin); return; }
        var m = typeof e.data === 'string' && /^authorization:github:(success|error):([\s\S]*)$/.exec(e.data);
        if (!m) return;
        done = true; window.removeEventListener('message', onMsg);
        try { w.close(); } catch (x) {}
        if (m[1] === 'success') { try { resolve(JSON.parse(m[2]).token); } catch (x) { reject(new Error('Login failed.')); } }
        else reject(new Error('GitHub did not allow the login.'));
      }
      window.addEventListener('message', onMsg);
      var t = setInterval(function () { if (w.closed) { clearInterval(t); if (!done) { window.removeEventListener('message', onMsg); reject(new Error('Login window was closed.')); } } }, 600);
    });
  }
  function logout() {
    try { sessionStorage.removeItem('bh_token'); } catch (e) {}
    token = null; location.reload();
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    $('#btnLogin').onclick = function () {
      $('#loginMsg').textContent = '';
      login().then(function (t) {
        token = t; try { sessionStorage.setItem('bh_token', t); } catch (e) {}
        return start();
      }).catch(function (e) { $('#loginMsg').textContent = e.message; });
    };
    if (token) start().catch(function (e) { $('#loginMsg').textContent = e.message; $('#login').hidden = false; $('#app').hidden = true; });
  }

  function start() {
    return api(repoPath('')).then(function (r) {
      if (!r.permissions || !r.permissions.push) throw new Error('This GitHub account does not have permission to edit the site.');
      return api(repoPath('/git/trees/' + CFG.branch + '?recursive=1'));
    }).then(function (tree) {
      var pre = CFG.root + '/';
      S.files = tree.tree.filter(function (t) { return t.type === 'blob' && t.path.indexOf(pre) === 0 && /^[^/]+\.html$/.test(t.path.slice(pre.length)); })
        .map(function (t) { return t.path.slice(pre.length); });
      $('#login').hidden = true; $('#app').hidden = false;
      wireBar(); fillSelect();
      return openPage('index.html');
    });
  }

  function fillSelect(selected) {
    var sel = $('#pageSel'); sel.innerHTML = '';
    var order = ['index.html', 'Profile.html', 'Services.html', 'People.html', 'NewHomes.html', 'Additions.html', 'Renovations.html', 'Design.html', 'InConstruction.html', 'Visualizations.html', 'Contact.html', 'Inquiries.html', 'Social.html', 'Places.html'];
  var main = order.filter(function (n) { return S.files.indexOf(n) >= 0; });
    var projects = S.files.filter(function (n) { return order.indexOf(n) < 0; }).sort();
    function add(group, names) {
      if (!names.length) return;
      var g = document.createElement('optgroup'); g.label = group;
      names.forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = prettyName(n) + (S.pages[n] && S.pages[n].isNew ? ' (new, not published)' : ''); g.appendChild(o); });
      sel.appendChild(g);
    }
    add('Pages', main); add('Projects', projects);
    sel.value = selected || S.current || 'index.html';
  }

  function wireBar() {
    if (wireBar.done) return; wireBar.done = true;
    $('#pageSel').onchange = function () { openPage(this.value); };
    $('#btnSave').onclick = save;
    $('#btnOut').onclick = function () { if (dirtyList().length && !confirm('You have changes that are not published. Log out anyway?')) return; logout(); };
    $('#btnUndo').onclick = undo;
    $('#btnRedo').onclick = redo;
    $('#btnTitle').onclick = editPageTitle;
    $('#btnAdd').onclick = addProject;
    $('#btnMenu').onclick = openMenuDialog;
    $('#btnNew').onclick = addPage;
    $('#btnDel').onclick = deleteProject;
    $('#slPrev').onclick = function () { stepSlide(-1); };
    $('#slNext').onclick = function () { stepSlide(1); };
    window.addEventListener('beforeunload', function (e) { if (dirtyList().length) { e.preventDefault(); e.returnValue = ''; } });
  }

  // ---------------------------------------------------------------- serialize
  function serializeDoc(doc) {
    var clone = doc.documentElement.cloneNode(true);
    clone.querySelectorAll('[data-ed]').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('*').forEach(function (el) {
      el.removeAttribute('contenteditable');
      Array.prototype.slice.call(el.attributes).forEach(function (a) { if (a.name.indexOf('data-ed') === 0) el.removeAttribute(a.name); });
    });
    clone.querySelectorAll('.nv.open').forEach(function (n) { n.classList.remove('open'); if (!n.getAttribute('class')) n.removeAttribute('class'); });
    clone.querySelectorAll('.nv [aria-expanded]').forEach(function (n) { n.setAttribute('aria-expanded', 'false'); });
    var slides = clone.querySelectorAll('.slide');
    slides.forEach(function (s, i) { s.classList.toggle('on', i === 0); });
    var html = '<!doctype html>\n' + clone.outerHTML + '\n';
    Object.keys(S.urlToPath).forEach(function (u) { html = html.split(u).join(S.urlToPath[u]); });
    return html;
  }
  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function flushCurrent() {
    if (S.current && S.doc && S.pages[S.current]) S.pages[S.current].html = serializeDoc(S.doc);
  }
  function dirtyList() {
    flushCurrent();
    var out = [];
    Object.keys(S.pages).forEach(function (n) {
      var p = S.pages[n];
      if (S.deleted[n]) return;
      if (p.isNew || norm(p.html) !== norm(p.baseline)) out.push(n);
    });
    return out;
  }
  function refreshDirty() {
    var n = dirtyList().length + Object.keys(S.deleted).length;
    $('#btnSave').textContent = n ? 'Save & publish (' + n + ')' : 'Save & publish';
  }

  // ---------------------------------------------------------------- page loading
  function getHtml(name) {
    if (S.pages[name]) return Promise.resolve(S.pages[name].html);
    return fetch('/' + name, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('Could not load ' + name);
      return r.text();
    }).then(function (t) { S.pages[name] = { html: t, baseline: t, isNew: false, loaded: false }; return t; });
  }

  function openPage(name) {
    flushCurrent();
    status('Loading…');
    return getHtml(name).then(function (html) {
      S.current = name; S.undo = []; S.redo = [];
      fillSelect(name);
      var h = html;
      Object.keys(S.pathToUrl).forEach(function (p) { if (h.indexOf(p) >= 0) h = h.split(p).join(S.pathToUrl[p]); });
      if (S.menu) h = applyMenuToHtml(h, S.menu, true);
      h = h.replace(/<head([^>]*)>/i, '<head$1><base href="/" data-ed><script data-ed>window.__EDIT__=1<\/script>');
      return new Promise(function (resolve) {
        var f = $('#frame');
        f.onload = function () { f.onload = null; try { onFrame(f, name); } catch (e) { console.error(e); status('Could not start editing this page: ' + e.message, 'err'); } refreshDirty(); resolve(); };
        f.srcdoc = h;
      });
    }).catch(function (e) { status(e.message, 'err'); });
  }

  // ---------------------------------------------------------------- frame setup
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SVG: 1, svg: 1, TITLE: 1, HEAD: 1 };
  var PLAIN = (function () { var d = document.createElement('div'); try { d.contentEditable = 'plaintext-only'; } catch (e) {} return d.contentEditable === 'plaintext-only'; })();

  function onFrame(f, name) {
    S.frame = f; S.doc = f.contentDocument; S.win = f.contentWindow; S.selEl = null;
    var doc = S.doc, win = S.win;
    var pg = S.pages[name];
    // restore blob url -> path mapping is done through serializeDoc, nothing to do here.
    if (!pg.loaded) { pg.loaded = true; pg.baseline = serializeDoc(doc); if (!pg.isNew) pg.html = pg.baseline; }
    if (pg.isNew && pg.baseline === undefined) pg.baseline = '';
    // editor styles
    var st = doc.createElement('style'); st.setAttribute('data-ed', '');
    st.textContent = [
      '.splash{display:none!important}',
      '.banner,.wordmark{animation:none!important;opacity:1!important}',
      '.slide{transition:none!important;opacity:0!important}.slide.on{opacity:1!important;z-index:2}',
      '[data-ed-t]{cursor:text;outline:1px dashed transparent;outline-offset:3px;transition:outline-color .15s}',
      '[data-ed-t]:hover{outline-color:rgba(79,102,89,.7)}',
      '[data-ed-t]:focus{outline:2px solid #4F6659}',
      '[data-ed-i]{cursor:pointer;outline:2px solid transparent;outline-offset:-2px}',
      '[data-ed-i]:hover{outline-color:rgba(79,102,89,.85)}',
      '[data-ed-sel]{outline:2px solid #4F6659!important;outline-offset:-2px}',
      '[data-ed-t][data-ed-sel]{outline-offset:3px}',
      '#edtb[hidden]{display:none!important}',
      '#edtb{position:absolute;z-index:2147483000;display:flex;flex-wrap:wrap;gap:2px;background:#1C2421;padding:3px;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:calc(100vw - 16px);font-family:system-ui,sans-serif}',
      '#edtb button{all:unset;box-sizing:border-box;color:#F3F4F1;font:500 13px/1 system-ui,sans-serif;padding:8px 10px;cursor:pointer;white-space:nowrap}',
      '#edtb button:hover{background:#4F6659}',
      '#edtb button.d:hover{background:#9A3412}',
      '#edtb i{width:1px;background:rgba(255,255,255,.25);margin:3px 2px}'
    ].join('\n');
    doc.head.appendChild(st);
    markEditable(doc);
    var tb = doc.createElement('div'); tb.id = 'edtb'; tb.setAttribute('data-ed', ''); tb.hidden = true;
    doc.documentElement.appendChild(tb); S.toolbar = tb;
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('dblclick', onDblClick, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('paste', onPaste, true);
    doc.addEventListener('input', function () { refreshDirty(); }, true);
    win.addEventListener('resize', function () { if (S.selEl) placeToolbar(); });
    // contextual top-bar buttons
    var isListing = LISTINGS.indexOf(name) >= 0;
    var isProject = !!projectListing(doc);
    $('#btnAdd').hidden = !isListing;
    $('#btnDel').hidden = !isProject;
    var slides = doc.querySelectorAll('.slide');
    $('#slideCtl').hidden = !slides.length;
    if (slides.length) slideLabel();
    status('');
    refreshDirty();
  }

  function markEditable(doc) {
    doc.body.querySelectorAll('*').forEach(function (el) {
      var tag = el.tagName;
      if (SKIP[tag] || el.closest('header,svg,.splash,[data-ed],button')) return;
      var hasText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
      if (hasText) {
        el.setAttribute('contenteditable', PLAIN ? 'plaintext-only' : 'true');
        el.setAttribute('data-ed-t', '');
      }
      if (isImgLike(el) && !el.closest('header')) el.setAttribute('data-ed-i', '');
    });
  }
  function bgUrl(el) { var s = el.getAttribute && el.getAttribute('style') || ''; var m = /background(?:-image)?:[^;]*url\(([^)]+)\)/i.exec(s); return m ? m[1] : null; }
  function isImgLike(el) { return el.tagName === 'IMG' || !!bgUrl(el); }

  // ---------------------------------------------------------------- events
  function onKey(e) {
    var t = e.target;
    if (e.key === 'Enter' && t.closest && t.closest('[data-ed-t]')) { e.preventDefault(); t.blur(); }
    if (e.key === 'Escape') { hideToolbar(); }
  }
  function onPaste(e) {
    var t = e.target; if (!t.closest || !t.closest('[data-ed-t]')) return;
    e.preventDefault();
    var txt = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\s*\n+\s*/g, ' ');
    S.doc.execCommand('insertText', false, txt);
  }
  function internalPage(href) {
    if (!href) return null;
    var h = href.split('#')[0].split('?')[0].replace(/^\//, '');
    return /^[^\/:]+\.html$/.test(h) ? h : null;
  }
  function onDblClick(e) {
    var t = e.target;
    if (t.closest && (t.closest('[data-ed]') || t.closest('header,.dd') || t.closest('[data-ed-t]'))) return;
    var stack = S.doc.elementsFromPoint(e.clientX, e.clientY), el = null;
    for (var i = 0; i < stack.length && !el; i++) {
      var c = stack[i];
      if (c.closest && c.closest('[data-ed-t]')) return;
      var sl = c.closest && c.closest('.slide');
      if (sl && !sl.classList.contains('on')) continue;
      if (c.hasAttribute && c.hasAttribute('data-ed-i') && canCrop(c)) el = c;
    }
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    var sel = S.win.getSelection && S.win.getSelection(); if (sel) sel.removeAllRanges();
    select(el); openCrop(el);
  }
  function onClick(e) {
    var t = e.target;
    if (t.closest && t.closest('[data-ed]')) return;
    var a = t.closest && t.closest('a');
    var inNav = t.closest && t.closest('header,.dd');
    if (inNav) {
      if (a) {
        e.preventDefault(); e.stopPropagation();
        var pg = internalPage(a.getAttribute('href'));
        if (pg && S.files.indexOf(pg) >= 0) openPage(pg);
      }
      return; // let nav buttons toggle their menus
    }
    if (a) e.preventDefault();
    e.stopPropagation();
    var el = null;
    var img = t.closest('[data-ed-i]');
    if (img) el = img;
    else { var tx = t.closest('[data-ed-t]'); if (tx) el = tx; }
    if (!el) { var it = findItem(t); if (it) el = it; }
    if (!el && a) el = a;
    if (el) select(el); else hideToolbar();
  }

  // ---------------------------------------------------------------- items
  function sig(el) { return el.tagName + '(' + Array.prototype.map.call(el.children, sig).join(',') + ')'; }
  function similar(a, b) {
    if (a === b || a.tagName !== b.tagName) return false;
    if ((a.classList[0] || '') !== (b.classList[0] || '')) return false;
    if (sig(a) !== sig(b)) return false;
    if (!a.children.length && a.tagName !== 'P' && a.getAttribute('style') !== b.getAttribute('style')) return false;
    return true;
  }
  function similarSiblings(el) {
    var p = el.parentNode; if (!p) return [];
    return Array.prototype.filter.call(p.children, function (c) { return !c.hasAttribute('data-ed') && similar(el, c); });
  }
  function findItem(el) {
    var n = el, body = S.doc.body;
    while (n && n !== body && n !== S.doc.documentElement) {
      var p = n.parentNode;
      if (p && p !== body && !n.hasAttribute('data-ed') && similarSiblings(n).length >= 1) return n;
      n = p;
    }
    return null;
  }

  // ---------------------------------------------------------------- toolbar
  function hideToolbar() {
    if (S.selEl) S.selEl.removeAttribute('data-ed-sel');
    S.selEl = null; if (S.toolbar) S.toolbar.hidden = true;
  }
  function btn(label, fn, cls) {
    var b = S.doc.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls;
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  }
  function sep() { return S.doc.createElement('i'); }
  function select(el) {
    if (S.selEl && S.selEl !== el) S.selEl.removeAttribute('data-ed-sel');
    S.selEl = el; el.setAttribute('data-ed-sel', '');
    var tb = S.toolbar; tb.innerHTML = '';
    var item = findItem(el);
    var link = el.closest && el.closest('a');
    if (isImgLike(el)) {
      tb.appendChild(btn('Replace photo', function () { replacePhoto(el); }));
      if (canCrop(el)) tb.appendChild(btn('Crop / zoom', function () { openCrop(el); }));
      tb.appendChild(btn('Describe photo', function () { describePhoto(el); }));
    }
    if (link && link.getAttribute('href')) {
      tb.appendChild(btn('Change link', function () { editLink(link); }));
      var pg = internalPage(link.getAttribute('href'));
      if (pg && S.files.indexOf(pg) >= 0) tb.appendChild(btn('Open page', function () { openPage(pg); }));
    }
    if (item) {
      if (tb.children.length) tb.appendChild(sep());
      tb.appendChild(btn('◀ Earlier', function () { moveItem(item, -1); }));
      tb.appendChild(btn('Later ▶', function () { moveItem(item, 1); }));
      tb.appendChild(btn('Duplicate', function () { duplicateItem(item); }));
      tb.appendChild(btn('Delete', function () { deleteItem(item); }, 'd'));
    }
    if (!tb.children.length) { tb.hidden = true; return; }
    tb.hidden = false; placeToolbar();
  }
  function placeToolbar() {
    var el = S.selEl, tb = S.toolbar, w = S.win; if (!el || !el.isConnected) { hideToolbar(); return; }
    var r = el.getBoundingClientRect();
    var top = r.top + w.pageYOffset - tb.offsetHeight - 8;
    if (top < w.pageYOffset + 4) top = Math.max(r.top + w.pageYOffset + 8, w.pageYOffset + 4);
    var left = r.left + w.pageXOffset;
    var maxLeft = S.doc.documentElement.clientWidth + w.pageXOffset - tb.offsetWidth - 8;
    tb.style.top = top + 'px'; tb.style.left = Math.max(8, Math.min(left, maxLeft)) + 'px';
  }

  // ---------------------------------------------------------------- undo
  function snap() {
    var tb = S.toolbar; var sel = S.selEl;
    S.undo.push(S.doc.body.innerHTML); if (S.undo.length > 40) S.undo.shift();
    S.redo = [];
  }
  function undo() {
    if (!S.doc || !S.undo.length) { status('Nothing to undo.'); return; }
    hideToolbar();
    S.redo.push(S.doc.body.innerHTML);
    S.doc.body.innerHTML = S.undo.pop();
    markEditable(S.doc); refreshDirty(); status('Undone.');
    if (S.doc.querySelector('.slide')) slideLabel();
  }
  function redo() {
    if (!S.doc || !S.redo.length) { status('Nothing to redo.'); return; }
    hideToolbar();
    S.undo.push(S.doc.body.innerHTML);
    S.doc.body.innerHTML = S.redo.pop();
    markEditable(S.doc); refreshDirty(); status('Redone.');
    if (S.doc.querySelector('.slide')) slideLabel();
  }

  // ---------------------------------------------------------------- actions
  function afterChange() { markEditable(S.doc); refreshDirty(); if (S.selEl) placeToolbar(); }

  function moveItem(item, dir) {
    var sibs = similarSiblings(item).concat([item]);
    sibs.sort(function (a, b) { return (a.compareDocumentPosition(b) & 4) ? -1 : 1; });
    var i = sibs.indexOf(item), j = i + dir;
    if (j < 0 || j >= sibs.length) { status(dir < 0 ? 'Already first.' : 'Already last.'); return; }
    snap();
    var other = sibs[j];
    if (dir < 0) item.parentNode.insertBefore(item, other); else item.parentNode.insertBefore(item, other.nextSibling);
    afterChange(); if (item.classList.contains('slide')) slideLabel();
  }
  function duplicateItem(item) {
    snap();
    var c = item.cloneNode(true);
    c.querySelectorAll('[data-ed-sel]').forEach(function (n) { n.removeAttribute('data-ed-sel'); });
    c.removeAttribute('data-ed-sel');
    item.parentNode.insertBefore(c, item.nextSibling);
    afterChange();
    if (c.classList.contains('slide')) { setSlide(Array.prototype.indexOf.call(S.doc.querySelectorAll('.slide'), c)); }
    var imgs = isImgLike(c) ? [c] : Array.prototype.filter.call(c.querySelectorAll('img'), function (x) { return !x.closest('header'); });
    if (imgs.length === 1) { select(imgs[0]); replacePhoto(imgs[0]); } else { select(c.querySelector('[data-ed-t]') || c); }
    status('Copied. Edit the copy.');
  }
  function deleteItem(item) {
    if (item.classList.contains('slide') && S.doc.querySelectorAll('.slide').length < 2) { alert('A slideshow needs at least one slide.'); return; }
    if (!confirm('Delete this item?')) return;
    snap(); hideToolbar();
    var wasSlide = item.classList.contains('slide');
    var sibs = wasSlide ? S.doc.querySelectorAll('.slide') : null;
    item.remove();
    if (wasSlide) setSlide(0);
    afterChange();
  }

  var picking = null;
  function replacePhoto(el) {
    var input = $('#file'); input.value = '';
    var cur = el.tagName === 'IMG' ? (el.getAttribute('src') || '') : (bgUrl(el) || '');
    var wantPng = /\.png(\?|$)/i.test(cur) || /^blob:/.test(cur) && S.urlToPath[cur] && /\.png$/.test(S.urlToPath[cur]);
    input.onchange = function () {
      var f = input.files && input.files[0]; if (!f) return;
      status('Preparing photo…');
      prepareImage(f, wantPng).then(function (r) {
        snap();
        S.pending[r.path] = r.blob; S.urlToPath[r.url] = r.path; S.pathToUrl[r.path] = r.url;
        if (el.tagName === 'IMG') { el.removeAttribute('srcset'); el.setAttribute('src', r.url); }
        else { el.setAttribute('style', el.getAttribute('style').replace(/url\([^)]+\)/i, 'url(' + r.url + ')')); }
        status('Photo replaced. Remember to Save & publish.'); refreshDirty(); placeToolbar();
      }).catch(function (e) { status('', ''); alert('That photo could not be used: ' + e.message); });
    };
    input.click();
  }
  function prepareImage(file, png) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var max = 2200, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(bmp, 0, 0, w, h);
      return new Promise(function (res, rej) {
        cv.toBlob(function (b) {
          if (!b) { rej(new Error('could not convert the picture')); return; }
          var ext = png ? 'png' : 'jpg';
          var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          res({ blob: b, path: 'images/uploads/' + id + '.' + ext, url: URL.createObjectURL(b) });
        }, png ? 'image/png' : 'image/jpeg', 0.86);
      });
    });
  }

  // ---------------------------------------------------------------- crop / zoom
  function canCrop(el) {
    if (el.tagName === 'IMG') { var cs = S.win.getComputedStyle(el); return cs.objectFit === 'cover' && !!(el.offsetWidth && el.offsetHeight); }
    return !!bgUrl(el);
  }
  function parseCrop(el) {
    var d = (el.getAttribute('data-crop') || '').split(',').map(Number);
    if (d.length >= 3 && d.every(function (x) { return isFinite(x); })) return { z: d[0], px: d[1], py: d[2], ratio: d[3] || 0 };
    var st = el.style, pos = (el.tagName === 'IMG' ? st.objectPosition : st.backgroundPosition) || '';
    var m = /(-?[\d.]+)%\s+(-?[\d.]+)%/.exec(pos);
    return { z: 1, px: m ? +m[1] : 50, py: m ? +m[2] : 50, ratio: 0 };
  }
  function openCrop(el) {
    var isImg = el.tagName === 'IMG';
    var cs = S.win.getComputedStyle(el);
    var par = isImg ? el.parentElement : null;
    var gallery = isImg && cs.position !== 'absolute' && /aspect-ratio/.test(el.getAttribute('style') || '');
    var clipped = false; for (var a = par; a && a !== S.doc.body && !clipped; a = a.parentElement) { if (S.win.getComputedStyle(a).overflow !== 'visible') clipped = true; }
    var canZoom = isImg && (gallery || clipped);
    var st = parseCrop(el);
    var srcAttr = isImg ? (el.getAttribute('data-orig') || el.getAttribute('src')) : bgUrl(el).replace(/^["']|["']$/g, '');
    var origPath = S.urlToPath[srcAttr] || srcAttr;
    var origUrl = S.pathToUrl[origPath] || srcAttr;
    var shownUrl = /^(blob:|data:|https?:|\/)/.test(origUrl) ? origUrl : '/' + origUrl;
    var baseRatio = el.offsetWidth / el.offsetHeight;
    var ratios = [['Keep as is', 0], ['Wide 16:9', 16 / 9], ['Landscape 3:2', 3 / 2], ['Classic 4:3', 4 / 3], ['Square 1:1', 1], ['Portrait 3:4', 3 / 4]];
    var m = { z: Math.max(1, st.z), px: st.px, py: st.py, ratio: gallery ? st.ratio : 0 };

    var dlg = document.createElement('div'); dlg.className = 'modal';
    var box = document.createElement('div'); box.className = 'box'; dlg.appendChild(box);
    box.innerHTML = '<h2>Crop and zoom</h2><p class="hint">Drag the photo to choose what shows. ' + (canZoom ? 'Use the slider to zoom in.' : '') + '</p>';
    var frame = document.createElement('div'); frame.className = 'cropframe';
    var pic = document.createElement('img'); pic.className = 'cropimg'; pic.alt = ''; pic.draggable = false; pic.src = shownUrl;
    frame.appendChild(pic); box.appendChild(frame);
    var row = document.createElement('div'); row.className = 'croprow';
    var zin, zl, shape;
    if (canZoom) {
      zl = document.createElement('label'); zl.textContent = 'Zoom ';
      zin = document.createElement('input'); zin.type = 'range'; zin.min = 100; zin.max = 300; zin.step = 5; zin.value = Math.round(m.z * 100);
      zl.appendChild(zin); row.appendChild(zl);
    }
    if (gallery) {
      var sl = document.createElement('label'); sl.textContent = 'Shape ';
      shape = document.createElement('select');
      ratios.forEach(function (r) { var o = document.createElement('option'); o.value = r[1]; o.textContent = r[0]; shape.appendChild(o); });
      var best = 0; ratios.forEach(function (r) { if (Math.abs(r[1] - m.ratio) < 0.01) best = r[1]; }); shape.value = String(best);
      sl.appendChild(shape); row.appendChild(sl);
    }
    var rs = document.createElement('button'); rs.type = 'button'; rs.textContent = 'Reset'; row.appendChild(rs);
    box.appendChild(row);
    var act = document.createElement('div'); act.className = 'actions';
    var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'primary'; ok.textContent = 'Apply';
    act.appendChild(cancel); act.appendChild(ok); box.appendChild(act);
    document.body.appendChild(dlg);

    function ratioNow() { return (gallery && m.ratio) ? m.ratio : baseRatio; }
    function dims() { return { W: pic.naturalWidth || 1, H: pic.naturalHeight || 1 }; }
    function layout() {
      var r = ratioNow(), maxW = Math.min(640, box.clientWidth - 48), maxH = window.innerHeight * 0.55;
      var w = Math.min(maxW, maxH * r), h = w / r;
      frame.style.width = w + 'px'; frame.style.height = h + 'px';
      pic.style.objectPosition = m.px + '% ' + m.py + '%';
      pic.style.transformOrigin = m.px + '% ' + m.py + '%';
      pic.style.transform = m.z > 1 ? 'scale(' + m.z + ')' : 'none';
    }
    function range() {
      var d = dims(), F = { w: frame.clientWidth, h: frame.clientHeight }, c = Math.max(F.w / d.W, F.h / d.H);
      return { x: m.z * d.W * c - F.w, y: m.z * d.H * c - F.h };
    }
    var drag = null;
    frame.addEventListener('pointerdown', function (e) { frame.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, px: m.px, py: m.py }; });
    frame.addEventListener('pointermove', function (e) {
      if (!drag) return; var rg = range();
      if (rg.x > 1) m.px = Math.max(0, Math.min(100, drag.px - (e.clientX - drag.x) / rg.x * 100));
      if (rg.y > 1) m.py = Math.max(0, Math.min(100, drag.py - (e.clientY - drag.y) / rg.y * 100));
      layout();
    });
    frame.addEventListener('pointerup', function () { drag = null; });
    if (zin) zin.oninput = function () { m.z = zin.value / 100; layout(); };
    if (shape) shape.onchange = function () { m.ratio = parseFloat(shape.value) || 0; layout(); };
    rs.onclick = function () { m.z = 1; m.px = 50; m.py = 50; m.ratio = 0; if (zin) zin.value = 100; if (shape) shape.value = '0'; layout(); };
    function close() { dlg.remove(); }
    cancel.onclick = close;
    dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) close(); });
    pic.onload = layout; layout();

    ok.onclick = function () {
      var px = Math.round(m.px * 10) / 10, py = Math.round(m.py * 10) / 10, z = m.z;
      var d = dims(), r = ratioNow();
      var bake = gallery && (z > 1);
      snap();
      var pos = px + '% ' + py + '%';
      var unchanged = z === 1 && px === 50 && py === 50 && !m.ratio;
      function finish(extra) {
        if (gallery) {
          if (m.ratio) el.style.aspectRatio = Math.round(m.ratio * 1000) + ' / 1000'; else if (st.ratio) el.style.aspectRatio = '';
        }
        if (unchanged && !bake) { el.removeAttribute('data-crop'); } else { el.setAttribute('data-crop', [z, px, py, m.ratio || 0].join(',')); }
        if (extra) extra();
        close(); refreshDirty(); placeToolbar(); status('Crop applied. Remember to Save & publish.');
      }
      if (!isImg) { el.style.backgroundPosition = pos; finish(); return; }
      if (!bake) {
        // CSS-only: restore the original file if an earlier crop baked one in
        finish(function () {
          if (el.hasAttribute('data-orig')) { el.setAttribute('src', origUrl); el.removeAttribute('data-orig'); }
          el.style.objectPosition = pos;
          if (z > 1) { el.style.transformOrigin = pos; el.style.transform = 'scale(' + z + ')'; } else { el.style.transform = ''; el.style.transformOrigin = ''; }
          if (unchanged) { el.style.objectPosition = ''; }
        });
        return;
      }
      status('Cropping…');
      fetch(shownUrl).then(function (x) { return x.blob(); }).then(function (b) { return createImageBitmap(b, { imageOrientation: 'from-image' }); }).then(function (bmp) {
        var F = { w: 1000, h: 1000 / r }, c = Math.max(F.w / bmp.width, F.h / bmp.height);
        var dw = bmp.width * c, dh = bmp.height * c;
        var L = m.px / 100 * (F.w - z * dw), T = m.py / 100 * (F.h - z * dh);
        var k = Math.min(1 / (c * z), 2200 / F.w);
        var cv = document.createElement('canvas'); cv.width = Math.round(F.w * k); cv.height = Math.round(F.h * k);
        var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(bmp, L * k, T * k, z * dw * k, z * dh * k);
        return new Promise(function (res, rej) {
          cv.toBlob(function (bl) {
            if (!bl) { rej(new Error('could not crop the picture')); return; }
            var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            res({ blob: bl, path: 'images/uploads/' + id + '.jpg', url: URL.createObjectURL(bl) });
          }, 'image/jpeg', 0.88);
        });
      }).then(function (n) {
        S.pending[n.path] = n.blob; S.urlToPath[n.url] = n.path; S.pathToUrl[n.path] = n.url;
        finish(function () {
          el.removeAttribute('srcset'); el.setAttribute('data-orig', origPath); el.setAttribute('src', n.url);
          el.style.objectPosition = ''; el.style.transform = ''; el.style.transformOrigin = '';
        });
      }).catch(function (e) { status('', ''); alert('That photo could not be cropped: ' + e.message); });
    };
  }

  function describePhoto(el) {
    var key = el.tagName === 'IMG' ? 'alt' : 'aria-label';
    var v = prompt('Describe this photo in a short sentence. It helps people who use screen readers and helps Google.', el.getAttribute(key) || '');
    if (v === null) return; snap(); el.setAttribute(key, v); refreshDirty();
  }
  function editLink(a) {
    var v = prompt('Where should this link go?\nUse a web address (https://…), a page on this site (like Contact.html), or an email (mailto:you@example.com).', a.getAttribute('href') || '');
    if (v === null) return; snap(); a.setAttribute('href', v.trim()); refreshDirty();
  }
  function editPageTitle() {
    var t = S.doc.querySelector('title'); if (!t) return;
    var v = prompt('Page title (shown on the browser tab and in Google results):', t.textContent);
    if (v === null) return; snap();
    t.textContent = v;
    var m = S.doc.querySelector('meta[name="description"]'); if (m && /Blake Hurst Architectural Design, Reading, PA\.$/.test(m.content)) m.content = v.split('|')[0].trim() + ' | Blake Hurst Architectural Design, Reading, PA.';
    refreshDirty();
  }

  // slides
  function setSlide(i) {
    var s = S.doc.querySelectorAll('.slide'); if (!s.length) return;
    i = Math.max(0, Math.min(i, s.length - 1));
    s.forEach(function (x, k) { x.classList.toggle('on', k === i); });
    slideLabel();
  }
  function curSlide() { var s = Array.prototype.slice.call(S.doc.querySelectorAll('.slide')); var i = s.findIndex(function (x) { return x.classList.contains('on'); }); return { i: Math.max(i, 0), n: s.length }; }
  function stepSlide(d) { var c = curSlide(); setSlide((c.i + d + c.n) % c.n); hideToolbar(); }
  function slideLabel() { var c = curSlide(); $('#slideCtl').hidden = !c.n; $('#slNo').textContent = (c.i + 1) + ' / ' + c.n; }

  // ---------------------------------------------------------------- menu
  function readMenu(doc) {
    return Array.prototype.map.call(doc.querySelectorAll('header .nv'), function (nv) {
      var top = nv.firstElementChild;
      return {
        label: top.textContent.trim(),
        href: top.tagName === 'A' ? top.getAttribute('href') : null,
        items: Array.prototype.map.call(nv.querySelectorAll('.dd a'), function (a) { return { label: a.textContent.trim(), href: a.getAttribute('href') }; })
      };
    });
  }
  function applyMenu(doc, m, preview) {
    var nvs = doc.querySelectorAll('header .nv');
    (m.groups || []).forEach(function (g, i) {
      var nv = nvs[i]; if (!nv) return;
      var top = nv.firstElementChild;
      top.textContent = g.label;
      if (top.tagName === 'A' && g.href) top.setAttribute('href', g.href);
      var dd = nv.querySelector('.dd'); if (!dd) return;
      var links = dd.querySelectorAll('a');
      var tpl = links[0] ? links[0].cloneNode(true) : null; if (!tpl) return;
      links.forEach(function (a) { a.remove(); });
      g.items.forEach(function (it) {
        var a = tpl.cloneNode(true); a.textContent = it.label; a.setAttribute('href', it.href); dd.appendChild(a);
      });
    });
    if (m.logoPath) doc.querySelectorAll('header img').forEach(function (im) { im.setAttribute('src', preview && m.logoUrl ? m.logoUrl : m.logoPath); });
  }
  function applyMenuToHtml(html, m, preview) {
    var d = parse(html); applyMenu(d, m, preview);
    return '<!doctype html>\n' + d.documentElement.outerHTML + '\n';
  }

  function openMenuDialog() {
    if (!S.doc || !S.doc.querySelector('header .nv')) { alert('This page has no menu.'); return; }
    var groups = readMenu(S.doc);
    var logo = { path: null, url: null };
    var dlg = document.createElement('div'); dlg.className = 'modal';
    var box = document.createElement('div'); box.className = 'box';
    dlg.appendChild(box);
    var pages = S.files.slice().sort(function (a, b) { return prettyName(a).localeCompare(prettyName(b)); });
    function pageSelect(href, onchange) {
      var sel = document.createElement('select');
      pages.forEach(function (p) { var o = document.createElement('option'); o.value = p; o.textContent = prettyName(p); sel.appendChild(o); });
      var oth = document.createElement('option'); oth.value = '__other'; oth.textContent = 'Other link…'; sel.appendChild(oth);
      var inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'https://… or mailto:…'; inp.hidden = true; inp.className = 'url';
      var known = pages.indexOf(href) >= 0;
      sel.value = known ? href : '__other'; inp.value = known ? '' : href; inp.hidden = known;
      sel.onchange = function () { inp.hidden = sel.value !== '__other'; onchange(); };
      inp.oninput = onchange;
      var w = document.createElement('span'); w.className = 'target'; w.appendChild(sel); w.appendChild(inp);
      w.get = function () { return sel.value === '__other' ? inp.value.trim() : sel.value; };
      return w;
    }
    function render() {
      box.innerHTML = '';
      var h = document.createElement('h2'); h.textContent = 'Edit the menu'; box.appendChild(h);
      var p = document.createElement('p'); p.className = 'hint'; p.textContent = 'These changes apply to every page of the site.'; box.appendChild(p);
      groups.forEach(function (g, gi) {
        var sec = document.createElement('section');
        var top = document.createElement('div'); top.className = 'toprow';
        var lab = document.createElement('input'); lab.type = 'text'; lab.value = g.label; lab.className = 'toplabel'; lab.setAttribute('aria-label', 'Menu title');
        lab.oninput = function () { g.label = lab.value; };
        top.appendChild(lab);
        if (g.href !== null) { var t = pageSelect(g.href, function () { g.href = t.get(); }); top.appendChild(t); }
        sec.appendChild(top);
        g.items.forEach(function (it, ii) {
          var row = document.createElement('div'); row.className = 'itemrow';
          var l = document.createElement('input'); l.type = 'text'; l.value = it.label; l.setAttribute('aria-label', 'Dropdown item name'); l.oninput = function () { it.label = l.value; };
          var t2 = pageSelect(it.href, function () { it.href = t2.get(); });
          var up = document.createElement('button'); up.type = 'button'; up.textContent = '↑'; up.title = 'Move up'; up.onclick = function () { if (ii > 0) { g.items.splice(ii - 1, 0, g.items.splice(ii, 1)[0]); render(); } };
          var dn = document.createElement('button'); dn.type = 'button'; dn.textContent = '↓'; dn.title = 'Move down'; dn.onclick = function () { if (ii < g.items.length - 1) { g.items.splice(ii + 1, 0, g.items.splice(ii, 1)[0]); render(); } };
          var rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '✕'; rm.title = 'Remove'; rm.onclick = function () { if (g.items.length > 1) { g.items.splice(ii, 1); render(); } else alert('Each menu needs at least one item.'); };
          [l, t2, up, dn, rm].forEach(function (x) { row.appendChild(x); });
          sec.appendChild(row);
        });
        var add = document.createElement('button'); add.type = 'button'; add.className = 'addrow'; add.textContent = '+ Add an item to this menu';
        add.onclick = function () { g.items.push({ label: 'New item', href: pages[0] }); render(); };
        sec.appendChild(add);
        box.appendChild(sec);
      });
      var lg = document.createElement('div'); lg.className = 'logorow';
      var lb = document.createElement('button'); lb.type = 'button'; lb.textContent = 'Replace the logo at the top'; lb.onclick = function () {
        var input = $('#file'); input.value = '';
        input.onchange = function () { var f = input.files && input.files[0]; if (!f) return;
          prepareImage(f, true).then(function (r) { logo = { path: r.path, url: r.url, blob: r.blob }; note.textContent = 'New logo chosen. It will be used on every page.'; }).catch(function (e) { alert('That image could not be used: ' + e.message); }); };
        input.click();
      };
      var note = document.createElement('span'); note.className = 'hint'; note.textContent = logo.path ? 'New logo chosen.' : 'Use a PNG with a transparent background.';
      lg.appendChild(lb); lg.appendChild(note); box.appendChild(lg);
      var act = document.createElement('div'); act.className = 'actions';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = function () { dlg.remove(); };
      var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'primary'; ok.textContent = 'Apply to every page';
      ok.onclick = function () {
        var bad = groups.some(function (g) { return !g.label.trim() || g.items.some(function (i) { return !i.label.trim() || !i.href; }); });
        if (bad) { alert('Every menu title and item needs a name and a link.'); return; }
        snap();
        var m = { groups: groups.map(function (g) { return { label: g.label.trim(), href: g.href, items: g.items.map(function (i) { return { label: i.label.trim(), href: i.href }; }) }; }) };
        if (logo.path) { m.logoPath = logo.path; m.logoUrl = logo.url; S.pending[logo.path] = logo.blob; S.urlToPath[logo.url] = logo.path; S.pathToUrl[logo.path] = logo.url; }
        S.menu = m; applyMenu(S.doc, m, true); markEditable(S.doc);
        refreshDirty(); dlg.remove(); status('Menu updated on every page. Save & publish to make it live.');
      };
      act.appendChild(cancel); act.appendChild(ok); box.appendChild(act);
    }
    render(); document.body.appendChild(dlg);
  }

  function addPage() {
    var name = prompt('Name of the new page (for example: Careers):');
    if (!name || !name.trim()) return; name = name.trim();
    var slug = slugify(name); if (!slug) { alert('Please use letters or numbers in the name.'); return; }
    var file = slug + '.html';
    if (S.files.indexOf(file) >= 0 || S.pages[file]) { alert('A page called "' + file + '" already exists.'); return; }
    var tplName = S.files.indexOf('Design.html') >= 0 ? 'Design.html' : 'Contact.html';
    getHtml(tplName).then(function (tpl) {
      var d = parse(tpl);
      var t = d.querySelector('title'); if (t) t.textContent = name + ' | Blake Hurst Architectural Design';
      var m = d.querySelector('meta[name="description"]'); if (m) m.setAttribute('content', name + ' | Blake Hurst Architectural Design, Reading, PA.');
      var h1 = d.querySelector('main h1'); if (h1) h1.textContent = name;
      S.pages[file] = { html: '<!doctype html>\n' + d.documentElement.outerHTML + '\n', baseline: '', isNew: true, loaded: true };
      S.files.push(file);
      return openPage(file).then(function () { status('New page created. Add it to the menu with "Edit menu", then Save & publish.'); });
    }).catch(function (e) { alert(e.message); });
  }

  // ---------------------------------------------------------------- projects
  function projectListing(doc) {
    var a = doc.querySelector('main > a[href$=".html"]');
    if (!a) return null;
    var h = a.getAttribute('href');
    return LISTINGS.indexOf(h) >= 0 ? h : null;
  }
  function parse(html) { return new DOMParser().parseFromString(html, 'text/html'); }

  function addProject() {
    var listing = S.current;
    var name = prompt('Name of the new project (for example: The Lake House):');
    if (!name || !name.trim()) return; name = name.trim();
    var slug = slugify(name); if (!slug) { alert('Please use letters or numbers in the name.'); return; }
    var file = slug + '.html';
    if (S.files.indexOf(file) >= 0 || S.pages[file]) { alert('A page called "' + file + '" already exists. Pick a different name.'); return; }
    snap();
    var doc = S.doc;
    var first = doc.querySelector('main a[href$=".html"][style*="display: block"]');
    if (!first) { alert('Could not find a project card to copy on this page.'); return; }
    var templateFile = first.getAttribute('href');
    getHtml(templateFile).then(function (tpl) {
      var d = parse(tpl);
      var t = d.querySelector('title'); if (t) t.textContent = name + ' | Blake Hurst Architectural Design';
      var m = d.querySelector('meta[name="description"]'); if (m) m.setAttribute('content', name + ' | Blake Hurst Architectural Design, Reading, PA.');
      var h1 = d.querySelector('main h1'); if (h1) h1.textContent = name;
      var ps = d.querySelectorAll('main p[data-pm-slice], main > div p'); // About paragraphs
      var paras = Array.prototype.filter.call(d.querySelectorAll('main p'), function (p) { return !/Tell us about your ideas/.test(p.textContent); });
      paras.forEach(function (p, i) { p.removeAttribute('data-pm-slice'); p.textContent = i === 0 ? 'Write about the project here.' : 'Add a second paragraph, or delete this one.'; });
      var tplHero = d.querySelector('main img');
      var out = '<!doctype html>\n' + d.documentElement.outerHTML + '\n';
      S.pages[file] = { html: out, baseline: '', isNew: true, loaded: true, tplImg: tplHero ? tplHero.getAttribute('src') : null };
      S.files.push(file);
      // card on the listing page
      var card = first.cloneNode(true);
      card.removeAttribute('data-ed-sel');
      card.setAttribute('href', file);
      var spans = card.querySelectorAll('span');
      if (spans[0]) spans[0].textContent = name;
      if (spans[1]) spans[1].textContent = '· Town, PA';
      var tag = card.querySelector('p'); if (tag) tag.textContent = 'Add a one-line description.';
      first.parentNode.insertBefore(card, first.nextSibling);
      afterChange();
      return openPage(file).then(function () { status('New project created. Replace the photos and fill in the details, then Save & publish.'); });
    }).catch(function (e) { alert(e.message); });
  }

  function deleteProject() {
    var name = S.current, listing = projectListing(S.doc);
    if (!listing) return;
    if (!confirm('Delete this project and its page? This removes it from your website when you Save & publish.')) return;
    if (S.pages[name] && S.pages[name].isNew) { delete S.pages[name]; } else { S.deleted[name] = true; delete S.pages[name]; }
    S.files = S.files.filter(function (f) { return f !== name; });
    S.current = null;
    openPage(listing).then(function () {
      var card = S.doc.querySelector('main a[href="' + name + '"]');
      if (card) { snap(); card.remove(); }
      afterChange();
      status('Project removed. Save & publish to make it final.');
    });
  }

  // ---------------------------------------------------------------- save / publish
  function footerOf(html) { var m = /<footer[\s\S]*?<\/footer>/i.exec(html); return m ? m[0] : null; }

  function save() {
    if (S.busy) return;
    var dirty = dirtyList();
    var del = Object.keys(S.deleted);
    if (!dirty.length && !del.length && !S.menu) { status('Nothing to publish. No changes yet.'); return; }
    // warn about new pages still using the template's photo
    var warn = dirty.filter(function (n) { var p = S.pages[n]; return p.isNew && p.tplImg && p.html.indexOf(p.tplImg) >= 0; });
    if (warn.length && !confirm('A new project page still shows another project\'s photos. Publish anyway?')) return;
    S.busy = true; $('#btnSave').disabled = true; status('Publishing…');
    var files = {};      // path -> { text | blob } or null (delete)
    var result;
    var footerNew = null;
    dirty.forEach(function (n) {
      var p = S.pages[n]; files[CFG.root + '/' + n] = { text: p.html };
      var f = footerOf(p.html), fb = p.isNew ? null : footerOf(p.baseline);
      if (!p.isNew && f && fb && f !== fb) footerNew = f;
    });
    del.forEach(function (n) { files[CFG.root + '/' + n] = null; });
    var chain = Promise.resolve();
    var menu = S.menu;
    function transform(html) {
      if (footerNew) html = html.replace(/<footer[\s\S]*?<\/footer>/i, function () { return footerNew; });
      if (menu) html = applyMenuToHtml(html, menu, false);
      return html;
    }
    if (footerNew || menu) {
      chain = chain.then(function () {
        var others = S.files.filter(function (n) { return !files[CFG.root + '/' + n] && !S.deleted[n]; });
        status('Updating ' + (menu ? 'the menu' : 'the footer') + ' on every page…');
        return Promise.all(others.map(function (n) {
          return api(repoPath('/contents/' + CFG.root + '/' + encodeURIComponent(n) + '?ref=' + CFG.branch), { headers: { Accept: 'application/vnd.github.raw+json' }, raw: true }).then(function (txt) {
            files[CFG.root + '/' + n] = { text: transform(txt) };
          });
        })).then(function () {
          dirty.forEach(function (n) { var p = S.pages[n]; p.html = transform(p.html); files[CFG.root + '/' + n] = { text: p.html }; });
        });
      });
    }
    chain.then(function () {
      // photos that are actually used
      var all = Object.keys(files).map(function (k) { return files[k] && files[k].text || ''; }).join('\n');
      Object.keys(S.pending).forEach(function (p) { if (all.indexOf(p) >= 0) files[CFG.root + '/' + p] = { blob: S.pending[p] }; });
      return commit(files, 'Website edit: ' + dirty.concat(del).join(', ').slice(0, 120));
    }).then(function () {
      dirty.forEach(function (n) { var p = S.pages[n]; p.baseline = p.html; p.isNew = false; });
      del.forEach(function (n) { delete S.deleted[n]; });
      Object.keys(S.pending).forEach(function (p) { if (files[CFG.root + '/' + p]) { /* keep url mapping so open pages still display */ } });
      if (menu) { S.menu = null; Object.keys(S.pages).forEach(function (n) { var p = S.pages[n]; if (S.deleted[n]) return; if (dirty.indexOf(n) < 0) p.html = applyMenuToHtml(p.html, menu, false); p.baseline = p.html; }); }
      if (footerNew) Object.keys(S.pages).forEach(function (n) { var p = S.pages[n]; if (S.deleted[n]) return; ['html', 'baseline'].forEach(function (k) { if (p[k] && footerOf(p[k])) p[k] = p[k].replace(/<footer[\s\S]*?<\/footer>/i, function () { return footerNew; }); }); });
      refreshDirty(); fillSelect();
      status('Published. Your live site updates in about a minute.');
    }).catch(function (e) {
      status('', ''); alert('Could not publish: ' + (e.message || e).toString().slice(0, 300));
    }).then(function () { S.busy = false; $('#btnSave').disabled = false; refreshDirty(); });
  }

  function commit(files, message, attempt) {
    attempt = attempt || 0;
    var paths = Object.keys(files);
    var head, baseTree;
    return api(repoPath('/git/ref/heads/' + CFG.branch)).then(function (ref) {
      head = ref.object.sha;
      return api(repoPath('/git/commits/' + head));
    }).then(function (c) {
      baseTree = c.tree.sha;
      status('Uploading ' + paths.length + ' file' + (paths.length === 1 ? '' : 's') + '…');
      return Promise.all(paths.map(function (p) {
        var f = files[p];
        if (f === null) return Promise.resolve({ path: p, mode: '100644', type: 'blob', sha: null });
        if (f.sha) return Promise.resolve({ path: p, mode: '100644', type: 'blob', sha: f.sha });
        var body = f.blob ? b64(f.blob).then(function (d) { return { content: d, encoding: 'base64' }; }) : Promise.resolve({ content: f.text, encoding: 'utf-8' });
        return body.then(function (b) { return api(repoPath('/git/blobs'), { method: 'POST', body: JSON.stringify(b) }); })
          .then(function (r) { f.sha = r.sha; return { path: p, mode: '100644', type: 'blob', sha: r.sha }; });
      }));
    }).then(function (tree) {
      return api(repoPath('/git/trees'), { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: tree }) });
    }).then(function (t) {
      return api(repoPath('/git/commits'), { method: 'POST', body: JSON.stringify({ message: message, tree: t.sha, parents: [head] }) });
    }).then(function (c) {
      return api(repoPath('/git/refs/heads/' + CFG.branch), { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
    }).catch(function (e) {
      if ((e.status === 422 || e.status === 409) && attempt < 2) return commit(files, message, attempt + 1);
      throw e;
    });
  }

  window.BH = S;
  boot();
})();
