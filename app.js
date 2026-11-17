// GDoc web viewer: the groups someone shared with you, readable in a browser
// and kept on the device so they still open without a connection.
//
// It is read-only. Sign-in and access rules are the same as the app's: Google
// through Supabase, and the server only returns groups shared with your email.

const config = window.GDOC_CONFIG;
const base = new URL('.', location.href).href;
const db = window.supabase.createClient(config.url, config.key, {
  auth: { flowType: 'pkce' },
});

const BUCKET = 'documents';
const FILE_CACHE = 'gdoc-files-v1'; // not versioned with the app: survives updates
const KEYS = { groups: 'gdoc.groups', email: 'gdoc.email', tip: 'gdoc.tip-dismissed' };

const GROUP_STYLES = {
  folder: ['📁', '#64748b'],
  trip: ['✈️', '#0284c7'],
  stay: ['🛏️', '#7c3aed'],
  id: ['🪪', '#0f766e'],
  health: ['🩺', '#dc2626'],
  money: ['👛', '#ca8a04'],
  vehicle: ['🚗', '#ea580c'],
  work: ['💼', '#4f46e5'],
  home: ['🏠', '#16a34a'],
};

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
};

const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3 7 8l1.4 1.4L11 6.8V16h2V6.8l2.6 2.6L17 8zM5 19v-7H3v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M17.6 6.4A8 8 0 1 0 19.7 14h-2.1a6 6 0 1 1-1.4-6.2L13 11h7V4z"/></svg>',
  chevron: '<svg class="chevron" viewBox="0 0 24 24"><path d="m9 6-1.4 1.4 4.6 4.6-4.6 4.6L9 18l6-6z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="m15 6 1.4 1.4-4.6 4.6 4.6 4.6L15 18l-6-6z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="m9 6-1.4 1.4 4.6 4.6-4.6 4.6L9 18l6-6z"/></svg>',
};

const state = {
  signedIn: false,
  email: localStorage.getItem(KEYS.email),
  groups: readGroups(),
  saved: new Set(), // cache keys of the files on this device
  syncing: false,
  progress: null, // { done, total } while files are being fetched
  problem: null, // why the last sync didn't work
};

// Bumped on every render, so slow work started for a previous screen knows
// not to touch the page any more.
let screen = 0;
// Bumped on sign-out. A sync that started before it must not write anything
// back afterwards.
let login = 0;
let running = null; // the sync in flight, if any
let objectUrls = [];
let openPdf = null;
let currentBlob = null;

// ------------------------------------------------------------- helpers --

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function readGroups() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.groups) || 'null');
  } catch {
    return null;
  }
}

function extension(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function kind(doc) {
  const type = MIME[extension(doc.file_name)] || '';
  if (type.startsWith('image/')) return 'image';
  return type === 'application/pdf' ? 'pdf' : 'other';
}

function fileKey(group, doc) {
  return `${base}files/${group.id}/${encodeURIComponent(doc.file_name)}`;
}

function isSaved(group, doc) {
  return state.saved.has(fileKey(group, doc));
}

async function savedBlob(group, doc) {
  const cache = await caches.open(FILE_CACHE);
  const hit = await cache.match(fileKey(group, doc));
  return hit ? hit.blob() : null;
}

/** File names for copies leaving the app: the title, made safe and unique. */
function exportNames(docs) {
  const used = new Set();
  return docs.map((doc) => {
    const ext = extension(doc.file_name);
    let stem = doc.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!stem || stem.startsWith('.')) stem = `Document ${stem}`.trim();
    let name = ext ? `${stem}.${ext}` : stem;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      name = ext ? `${stem} (${n}).${ext}` : `${stem} (${n})`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function count(n) {
  return n === 1 ? '1 document' : `${n} documents`;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------------------------------------------------------------- sync --

async function refreshSaved() {
  const cache = await caches.open(FILE_CACHE);
  state.saved = new Set((await cache.keys()).map((request) => request.url));
}

/**
 * Brings the list of shared groups up to date, then fetches every file that
 * isn't on this device yet and drops the ones that were removed.
 */
function sync() {
  if (running || !state.signedIn) return running ?? Promise.resolve();
  running = runSync(login).finally(() => (running = null));
  return running;
}

async function runSync(startedIn) {
  // True once the user has signed out since this sync began.
  const stale = () => startedIn !== login;
  state.syncing = true;
  state.problem = null;
  render();
  try {
    const { data, error } = await db
      .from('groups')
      .select(
        'id, name, icon, owner_email, created_at, ' +
          'documents(id, title, file_name, position, added_at)',
      )
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (stale()) return;

    for (const group of data) {
      group.documents.sort(
        (a, b) => a.position - b.position || a.added_at.localeCompare(b.added_at),
      );
    }
    state.groups = data;
    localStorage.setItem(KEYS.groups, JSON.stringify(data));
    render();

    const cache = await caches.open(FILE_CACHE);
    const wanted = data.flatMap((group) => group.documents.map((doc) => ({ group, doc })));
    const missing = wanted.filter(({ group, doc }) => !isSaved(group, doc));
    let failed = 0;
    for (const [index, { group, doc }] of missing.entries()) {
      state.progress = { done: index, total: missing.length };
      render();
      const { data: blob, error: failure } = await db.storage
        .from(BUCKET)
        .download(`${group.id}/${doc.file_name}`);
      if (stale()) return;
      if (failure) {
        failed++;
        continue;
      }
      const type = MIME[extension(doc.file_name)] || blob.type || 'application/octet-stream';
      await cache.put(
        fileKey(group, doc),
        new Response(blob, { headers: { 'Content-Type': type } }),
      );
      if (stale()) return;
      state.saved.add(fileKey(group, doc));
    }

    // Forget files for documents that are gone or no longer shared.
    const keep = new Set(wanted.map(({ group, doc }) => fileKey(group, doc)));
    for (const request of await cache.keys()) {
      if (!keep.has(request.url)) {
        await cache.delete(request);
        state.saved.delete(request.url);
      }
    }
    if (failed) state.problem = "Some documents couldn't be downloaded yet.";
  } catch (error) {
    console.warn('Sync failed', error);
    if (stale()) return;
    state.problem = state.groups
      ? "Couldn't reach the server. Showing what's saved on this phone."
      : "Couldn't reach the server. Check your connection and try again.";
  } finally {
    state.syncing = false;
    state.progress = null;
    if (!stale()) render();
  }
}

async function signIn() {
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: base, queryParams: { prompt: 'select_account' } },
  });
  if (error) toast("Couldn't start Google sign-in. Check your connection.");
}

/** Removes everything this browser holds: the login, the list, the files. */
async function wipe() {
  localStorage.removeItem(KEYS.groups);
  localStorage.removeItem(KEYS.email);
  await caches.delete(FILE_CACHE);
  Object.assign(state, { signedIn: false, email: null, groups: null, problem: null });
  state.saved = new Set();
}

async function signOut() {
  login++; // anything still downloading now belongs to nobody
  const inFlight = running;
  await db.auth.signOut({ scope: 'local' }).catch(() => {});
  await wipe();
  // A download that was mid-write when we wiped may have landed since; wait
  // for it to notice it is stale, then wipe again so nothing is left behind.
  await inFlight?.catch(() => {});
  await wipe();
  location.hash = '';
  render();
}

/** Hands copies to the share sheet (Save to Files, AirDrop…), or downloads. */
async function sendCopies(group, docs, blobs) {
  const names = exportNames(docs);
  const files = [];
  for (const [index, doc] of docs.entries()) {
    const blob = blobs?.[index] ?? (await savedBlob(group, doc));
    if (blob) {
      const type = MIME[extension(doc.file_name)] || blob.type || 'application/octet-stream';
      files.push(new File([blob], names[index], { type }));
    }
  }
  if (!files.length) return toast("Nothing here is saved on this phone yet.");
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
    } catch (error) {
      if (error.name !== 'AbortError') toast("Couldn't open the share sheet.");
    }
    return;
  }
  for (const file of files) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  }
}

// -------------------------------------------------------------- screens --

function route() {
  const [, groupId, docId] = location.hash.match(/^#g\/([^/]+)(?:\/([^/]+))?$/) || [];
  const group = state.groups?.find((g) => g.id === groupId);
  if (!group) return { name: 'home' };
  const index = docId ? group.documents.findIndex((d) => d.id === docId) : -1;
  return index < 0 ? { name: 'group', group } : { name: 'doc', group, index };
}

function render() {
  screen++;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  openPdf?.destroy();
  openPdf = null;
  currentBlob = null;

  const app = document.getElementById('app');
  const at = route();
  document.body.classList.toggle('viewing', at.name === 'doc');

  if (!state.groups && !state.signedIn) {
    app.innerHTML = signInScreen();
  } else if (at.name === 'doc') {
    app.innerHTML = docScreen(at.group, at.index);
    showDocument(at.group, at.group.documents[at.index], screen);
  } else if (at.name === 'group') {
    app.innerHTML = groupScreen(at.group);
    showThumbnails(at.group, screen);
  } else {
    app.innerHTML = homeScreen();
  }
}

function signInScreen() {
  return `
    <main>
      <div class="empty">
        <div class="tile">📁</div>
        <h2>Documents shared with you</h2>
        <p>Sign in with the Google account the group was shared with. Your
          documents are then saved on this phone, so they open without a
          connection.</p>
        <button class="primary" data-action="sign-in">Sign in with Google</button>
        ${state.problem ? `<p class="hint">${esc(state.problem)}</p>` : ''}
      </div>
    </main>`;
}

function statusLine() {
  const docs = (state.groups || []).flatMap((group) =>
    group.documents.map((doc) => isSaved(group, doc)),
  );
  const saved = docs.filter(Boolean).length;
  if (state.progress) {
    return `Saving for offline… ${state.progress.done} of ${state.progress.total}`;
  }
  if (state.syncing) return 'Checking for changes…';
  if (!docs.length) return '';
  return saved === docs.length
    ? `All ${count(docs.length)} saved on this phone.`
    : `${saved} of ${count(docs.length)} saved on this phone.`;
}

function notices() {
  const parts = [];
  if (!state.signedIn) {
    parts.push(`
      <div class="notice"><p>You're signed out. Sign in to get updates.</p>
        <button class="text-button" data-action="sign-in">Sign in</button></div>`);
  } else if (state.problem && !state.syncing) {
    parts.push(`
      <div class="notice"><p>${esc(state.problem)}</p>
        <button class="text-button" data-action="sync">Retry</button></div>`);
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const installed = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !installed && !localStorage.getItem(KEYS.tip)) {
    parts.push(`
      <div class="notice"><p>Tip: tap Share, then <b>Add to Home Screen</b>, to
        keep this like an app. You'll sign in once more there.</p>
        <button class="text-button" data-action="dismiss-tip">OK</button></div>`);
  }
  return parts.join('');
}

function homeScreen() {
  const groups = state.groups || [];
  const list = groups
    .map((group) => {
      const [emoji, tint] = GROUP_STYLES[group.icon] || GROUP_STYLES.folder;
      const mine = group.owner_email === state.email;
      return `
        <a class="card" href="#g/${esc(group.id)}">
          <span class="tile" style="--tint:${tint}">${emoji}</span>
          <span class="label"><strong>${esc(group.name)}</strong>
            <span>${count(group.documents.length)}${mine ? '' : ` · From ${esc(group.owner_email)}`}</span>
          </span>${ICONS.chevron}
        </a>`;
    })
    .join('');
  const empty = `
    <div class="empty">
      <div class="tile">📭</div>
      <h2>Nothing shared with you yet</h2>
      <p>When someone shares a group with <b>${esc(state.email || 'your account')}</b>,
        it appears here.</p>
    </div>`;
  return `
    <header class="bar">
      <h1>My documents</h1>
      <button class="icon-button" data-action="sync" aria-label="Refresh"
        ${state.syncing || !state.signedIn ? 'disabled' : ''}>
        <span class="${state.syncing ? 'spin' : ''}" style="display:grid">${ICONS.refresh}</span>
      </button>
    </header>
    <main>
      ${notices()}
      ${groups.length ? `<p class="status">${esc(statusLine())}</p>${list}` : state.syncing ? `<p class="status">${esc(statusLine())}</p>` : empty}
      <p class="account">${state.email ? `Signed in as ${esc(state.email)}` : ''}
        <button class="text-button" data-action="sign-out">Sign out</button></p>
    </main>`;
}

function groupScreen(group) {
  const rows = group.documents
    .map((doc) => {
      const saved = isSaved(group, doc);
      const ext = extension(doc.file_name).toUpperCase();
      return `
        <a class="row" href="#g/${esc(group.id)}/${esc(doc.id)}">
          <span class="thumb" data-thumb="${esc(doc.id)}">${esc(ext || 'FILE')}</span>
          <span class="label"><strong>${esc(doc.title)}</strong>
            <span>${saved ? esc(ext) : state.syncing ? 'Downloading…' : 'Not saved on this phone yet'}</span>
          </span>
        </a>`;
    })
    .join('');
  return `
    <header class="bar">
      <a class="icon-button" href="#" aria-label="Back">${ICONS.back}</a>
      <h1>${esc(group.name)}</h1>
      <button class="icon-button" data-action="save-all" aria-label="Save copies of all documents"
        ${group.documents.length ? '' : 'disabled'}>${ICONS.share}</button>
    </header>
    <main>
      ${group.documents.length ? rows : '<div class="empty"><h2>Nothing here yet</h2><p>Documents added to this group will appear here.</p></div>'}
    </main>`;
}

async function showThumbnails(group, forScreen) {
  for (const doc of group.documents) {
    if (kind(doc) !== 'image' || !isSaved(group, doc)) continue;
    const blob = await savedBlob(group, doc);
    if (forScreen !== screen) return;
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const slot = document.querySelector(`[data-thumb="${CSS.escape(doc.id)}"]`);
    if (slot) slot.innerHTML = `<img src="${url}" alt="" loading="lazy" decoding="async">`;
  }
}

function docScreen(group, index) {
  const doc = group.documents[index];
  const total = group.documents.length;
  const link = (i) => `#g/${esc(group.id)}/${esc(group.documents[i].id)}`;
  return `
    <header class="bar">
      <a class="icon-button" href="#g/${esc(group.id)}" aria-label="Back">${ICONS.back}</a>
      <h1>${esc(doc.title)}</h1>
      <button class="icon-button" data-action="save-one" aria-label="Save a copy">${ICONS.share}</button>
    </header>
    <div class="pages" id="pages"><p class="message">Opening…</p></div>
    ${
      total > 1
        ? `<nav class="pager">
            ${index > 0 ? `<a class="icon-button" href="${link(index - 1)}" data-replace aria-label="Previous">${ICONS.prev}</a>` : `<button class="icon-button" disabled aria-label="Previous">${ICONS.prev}</button>`}
            <span>${index + 1} of ${total}</span>
            ${index < total - 1 ? `<a class="icon-button" href="${link(index + 1)}" data-replace aria-label="Next">${ICONS.next}</a>` : `<button class="icon-button" disabled aria-label="Next">${ICONS.next}</button>`}
          </nav>`
        : ''
    }`;
}

async function showDocument(group, doc, forScreen) {
  const pages = document.getElementById('pages');
  const message = (text) => (pages.innerHTML = `<p class="message">${esc(text)}</p>`);
  const blob = await savedBlob(group, doc);
  if (forScreen !== screen) return;
  if (!blob) {
    return message(
      state.syncing
        ? 'Downloading this document…'
        : "This document isn't saved on this phone yet. Connect to the internet and it will download.",
    );
  }
  currentBlob = blob;

  if (kind(doc) === 'image') {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    pages.innerHTML = `<img src="${url}" alt="${esc(doc.title)}">`;
  } else if (kind(doc) === 'pdf') {
    try {
      await showPdf(pages, blob, forScreen);
    } catch (error) {
      console.warn('PDF failed', error);
      if (forScreen === screen) message("This PDF can't be shown here. Use the share button to open it in another app.");
    }
  } else {
    message("This kind of file can't be previewed here. Use the share button to open it in another app.");
  }
}

async function showPdf(pages, blob, forScreen) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  const lib = `${base}vendor/pdfjs/`;
  pdfjs.GlobalWorkerOptions.workerSrc = `${lib}pdf.worker.min.mjs`;
  // The loading task, not the document it resolves to, is what gets released.
  const task = pdfjs.getDocument({
    data: await blob.arrayBuffer(),
    cMapUrl: `${lib}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${lib}standard_fonts/`,
    wasmUrl: `${lib}wasm/`,
    iccUrl: `${lib}iccs/`,
  });
  const pdf = await task.promise;
  if (forScreen !== screen) return task.destroy();
  openPdf = task;
  pages.innerHTML = '';

  // Each page is drawn the first time it comes near the screen, sharp enough
  // to pinch into but within what a phone will allocate for one canvas.
  const drawn = new Set();
  const draw = async (holder, number) => {
    if (drawn.has(number)) return;
    drawn.add(number);
    const page = await pdf.getPage(number);
    const natural = page.getViewport({ scale: 1 });
    let scale = (holder.clientWidth * Math.min(devicePixelRatio || 1, 3)) / natural.width;
    const limit = 12_000_000;
    const area = natural.width * natural.height * scale * scale;
    if (area > limit) scale *= Math.sqrt(limit / area);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    if (forScreen === screen) holder.replaceChildren(canvas);
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) draw(entry.target, Number(entry.target.dataset.page));
      }
    },
    { rootMargin: '600px 0px' },
  );
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    if (forScreen !== screen) return;
    const { width, height } = page.getViewport({ scale: 1 });
    const holder = document.createElement('div');
    holder.className = 'page';
    holder.dataset.page = number;
    holder.style.aspectRatio = `${width} / ${height}`;
    pages.append(holder);
    observer.observe(holder);
  }
}

// --------------------------------------------------------------- events --

document.addEventListener('click', (event) => {
  // Paging between documents shouldn't pile up in the back button's history.
  const replace = event.target.closest('a[data-replace]');
  if (replace) {
    event.preventDefault();
    history.replaceState(null, '', replace.getAttribute('href'));
    return render();
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const at = route();
  if (action === 'sign-in') signIn();
  else if (action === 'sign-out') signOut();
  else if (action === 'sync') sync();
  else if (action === 'dismiss-tip') {
    localStorage.setItem(KEYS.tip, '1');
    render();
  } else if (action === 'save-all' && at.name === 'group') {
    sendCopies(at.group, at.group.documents.filter((doc) => isSaved(at.group, doc)));
  } else if (action === 'save-one' && at.name === 'doc') {
    const doc = at.group.documents[at.index];
    sendCopies(at.group, [doc], currentBlob ? [currentBlob] : null);
  }
});

// A quick sideways flick turns to the next document, unless zoomed in, when
// the same gesture is panning across the page.
let touch = null;
document.addEventListener('touchstart', (event) => {
  const zoomed = (window.visualViewport?.scale || 1) > 1.02;
  touch =
    event.touches.length === 1 && !zoomed
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY, at: Date.now() }
      : null;
});
document.addEventListener('touchend', (event) => {
  const at = route();
  if (!touch || at.name !== 'doc' || event.changedTouches.length !== 1) return;
  const dx = event.changedTouches[0].clientX - touch.x;
  const dy = event.changedTouches[0].clientY - touch.y;
  const quick = Date.now() - touch.at < 500;
  touch = null;
  if (!quick || Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 2) return;
  const target = at.group.documents[at.index + (dx < 0 ? 1 : -1)];
  if (!target) return;
  history.replaceState(null, '', `#g/${at.group.id}/${target.id}`);
  render();
});

window.addEventListener('hashchange', render);
window.addEventListener('online', sync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});

// ---------------------------------------------------------------- start --

async function start() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Offline support unavailable', error));
  }
  await refreshSaved();

  // Coming back from Google with a refusal shows up in the address.
  const query = new URLSearchParams(location.search);
  if (query.get('error_description')) state.problem = query.get('error_description');

  db.auth.onAuthStateChange((event, session) => {
    // Supabase must not be called from inside this callback; defer.
    setTimeout(() => {
      const wasSignedIn = state.signedIn;
      state.signedIn = Boolean(session);
      if (session?.user?.email) {
        state.email = session.user.email.toLowerCase();
        localStorage.setItem(KEYS.email, state.email);
      }
      if (state.signedIn && !wasSignedIn) sync();
      else render();
    });
  });
  // Resolves once any sign-in carried in the address has been processed. When
  // offline with an expired session this fails; the saved copies still show.
  const { data } = await db.auth.getSession().catch(() => ({ data: {} }));
  state.signedIn = Boolean(data?.session);
  render();
  if (state.signedIn) sync();
}

// For tests and debugging from the browser console.
window.gdoc = { db, state, sync, signOutForTest: signOut };

start();
