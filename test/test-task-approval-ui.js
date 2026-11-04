/**
 * Modul: Freigabepflicht in der Oberflaeche (Check-in mit Bestaetigung)
 * Zweck: Der Server haelt die Regel (test:task-approval); diese Suite misst,
 *        was der Client daraus macht - und zwar als VERHALTEN, nicht als
 *        Quelltextfantasie: der Dialog schickt das Feld, die Leseansicht zeigt
 *        den Antrag (und den Grund der Ablehnung), der Admin-Blick bekommt
 *        Bestaetigung und Ablehnung und setzt sie ab, der nicht-Admin-Blick
 *        sieht beide Knopfe nicht, die Karte traegt die Marke, und die
 *        Admin-Zeile schaltet die Liste auf `approval=pending` um.
 *
 * Gefahren mit dem Browser-Loader (Stubs fuer /api.js, /components/modal.js,
 * /components/detail-view.js) und dem Mini-DOM fuer die bauenden Renderer -
 * dasselbe Muster wie test-task-detail-finish.js (#1251): gemessen wird, was
 * bei einem gegebenen Zustand herauskommt, nicht ob der Code dasteht.
 *
 * Ausfuehren: npm run test:task-approval-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
// Die Leseansicht und die Admin-Zeile BAUEN ihre Knoten - ohne `document`
// scheiterten sie vor der Stelle, die hier gemessen wird.
import { installMiniDom } from './mini-dom.js';
installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
const toasts = [];
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast: (msg, type) => toasts.push({ msg, type }) };

const { __test: tasks } = await import('../public/pages/tasks.js');
const { openTaskDetail, __test: detailTest } = await import('../public/components/task-detail.js');

// ---------------------------------------------------------------------------
// Dialog: Schalter im Formular, Feld im Sprechzettel
// ---------------------------------------------------------------------------

test('der Dialog bietet den Freigabe-Schalter an und setzt ihn am bestehenden Task', () => {
  const leer = tasks.renderModalContent({ task: null, users: [] });
  assert.match(leer, /id="task-requires-approval"/, 'der Schalter fehlt im Neuanlage-Formular');
  assert.doesNotMatch(leer, /id="task-requires-approval"[^>]*\bchecked\b/, 'eine neue Aufgabe ist frei');

  const bearbeitet = tasks.renderModalContent({
    task: { id: 5, title: 'Muell raus', status: 'open', requires_approval: 1, locked: 0 },
    users: [],
  });
  assert.match(bearbeitet, /id="task-requires-approval"[^>]*\bchecked\b/, 'gesetzte Pflicht bleibt im Formular an');
});

test('das Speichern schickt requires_approval am Schalter (nicht am Task)', () => {
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  assert.match(src, /requires_approval:\s*form\.querySelector\('#task-requires-approval'\)\?\.checked \? 1 : 0,/);
});

// ---------------------------------------------------------------------------
// Liste: Marke an der Karte und Umschalter der Abfrage
// ---------------------------------------------------------------------------

test('die Karte traegt die Marke nur bei offenem Check-in', () => {
  assert.match(tasks.renderApprovalBadge({ approval_status: 'pending' }), /role="img"/);
  assert.match(tasks.renderApprovalBadge({ approval_status: 'pending' }), /tasks\.approvalPendingBadge/);
  assert.equal(tasks.renderApprovalBadge({ approval_status: 'approved' }), '');
  assert.equal(tasks.renderApprovalBadge({}), '');
});

test('die Liste und das Brett teilen sich dieselbe Marke (eine Aufrufstelle je Ansicht)', () => {
  const src = readFileSync(new URL('../public/pages/tasks.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/\$\{renderApprovalBadge\(task\)\}/g)];
  assert.equal(calls.length, 2, 'Zeile und Brett - wie beim Schloss (#1607)');
});

test('der Umschalter haengt das pending-Filter an die Abfrage, sonst nicht', () => {
  tasks.state.approvalOnly = true;
  assert.match(tasks.taskQuery(), /approval=pending/);
  tasks.state.approvalOnly = false;
  assert.doesNotMatch(tasks.taskQuery(), /approval/);
});

// ---------------------------------------------------------------------------
// Admin-Zeile ueber der Liste
// ---------------------------------------------------------------------------

/** Der Behaelter, den die Seite stellt: `.tasks-body` mit kind-Liste. */
function fakeBodyHost() {
  const host = {
    children: [],
    get firstChild() { return this.children[0] ?? null; },
    insertBefore(node, before) {
      const i = before ? this.children.indexOf(before) : -1;
      if (i < 0) this.children.push(node);
      else this.children.splice(i, 0, node);
      return node;
    },
    querySelector(sel) {
      const id = sel.startsWith('#') ? sel.slice(1) : null;
      return this.children.find((c) => c.getAttribute?.('id') === id) ?? null;
    },
  };
  host.remove = (node) => { host.children = host.children.filter((c) => c !== node); };
  return {
    host,
    container: { querySelector: (sel) => (sel === '.tasks-body' ? host : null) },
  };
}

test('die Admin-Zeile zaehlt die offenen Check-ins und haelt ihren Griff', () => {
  const vorher = { admin: tasks.state.isAdmin, tasks: tasks.state.tasks, dismissed: tasks.state.approvalNoticeDismissed, only: tasks.state.approvalOnly };
  try {
    tasks.state.isAdmin = true;
    tasks.state.approvalNoticeDismissed = false;
    tasks.state.approvalOnly = false;
    tasks.state.tasks = [
      { id: 1, approval_status: 'pending' },
      { id: 2, approval_status: 'approved' },
      { id: 3, approval_status: 'pending' },
    ];
    const { host, container } = fakeBodyHost();
    tasks.syncApprovalNotice(container);
    const el = host.querySelector('#task-approval-notice');
    assert.ok(el, 'bei zwei offenen Check-ins muss die Zeile stehen');
    assert.equal(el.listener, 'click', 'die Zeile ist verdrahtet (Umschalter und Schliessen)');
    const html = el.outerHTML;
    assert.match(html, /count":2/, 'die Zahl traegt den Bestand');
    assert.match(html, /id="task-approval-toggle"/, 'der Umschalter ist da');
    assert.match(html, /id="task-approval-dismiss"/, 'der Schliessknopf ist da');
  } finally {
    Object.assign(tasks.state, vorher);
  }
});

test('ohne Admin-Blick, ohne Bestand oder geschlossen steht die Zeile nicht', () => {
  const vorher = { admin: tasks.state.isAdmin, tasks: tasks.state.tasks, dismissed: tasks.state.approvalNoticeDismissed, only: tasks.state.approvalOnly };
  try {
    tasks.state.tasks = [{ id: 1, approval_status: 'pending' }];
    tasks.state.approvalNoticeDismissed = false;
    tasks.state.approvalOnly = false;

    tasks.state.isAdmin = false;
    let f = fakeBodyHost();
    tasks.syncApprovalNotice(f.container);
    assert.equal(f.host.children.length, 0, 'der Nicht-Admin sieht die Zeile nicht');

    tasks.state.isAdmin = true;
    tasks.state.tasks = [{ id: 1, approval_status: 'approved' }];
    f = fakeBodyHost();
    tasks.syncApprovalNotice(f.container);
    assert.equal(f.host.children.length, 0, 'ohne offenen Check-in nicht');

    tasks.state.tasks = [{ id: 1, approval_status: 'pending' }];
    tasks.state.approvalNoticeDismissed = true;
    tasks.state.approvalOnly = true;
    f = fakeBodyHost();
    tasks.syncApprovalNotice(f.container);
    assert.equal(f.host.children.length, 0, 'geschlossen bleibt sie zu');
    assert.equal(tasks.state.approvalOnly, false, 'und der Umschalter geht mit - kein blinder Filter');
  } finally {
    Object.assign(tasks.state, vorher);
  }
});

// ---------------------------------------------------------------------------
// Leseansicht: Banner, Antrag, Knopfe
// ---------------------------------------------------------------------------

const BASIS = { id: 7, title: 'Fenster putzen', status: 'done', visibility: 'all', created_by: 2, subtasks: [] };
const ANTRAG = { requires_approval: 1, approval_status: 'pending' };

function optionenBei(extra = {}, viewer = {}) {
  let gesehen = null;
  globalThis.__openDetailView = (options) => { gesehen = options; };
  try {
    openTaskDetail({ task: { ...BASIS, ...extra }, users: [], currentUserId: 2, ...viewer });
  } finally {
    delete globalThis.__openDetailView;
  }
  assert.ok(gesehen, 'die Leseansicht wurde gar nicht geoeffnet');
  return gesehen;
}

test('ein offener Check-in steht als Antrag ganz oben - fuer jeden Blick', () => {
  const opts = optionenBei(ANTRAG);
  const erste = opts.sections[0];
  assert.ok(erste?.node, 'der Antrag haengt vor der Statuszeile');
  assert.match(erste.node.outerHTML, /task-approval-banner--pending/);
  assert.match(erste.node.outerHTML, /tasks\.approvalPendingBanner/);
});

test('der Grund der Ablehnung bleibt an der offenen Aufgabe sichtbar', () => {
  const sicht = detailTest.approvalNoticeView({
    requires_approval: 1, approval_status: null, status: 'open', reject_note: 'Erst das Bad, dann das Fenster.',
  });
  assert.equal(sicht.kind, 'rejected');
  assert.equal(sicht.text, 'Erst das Bad, dann das Fenster.');
  // Gegenprobe: ohne Grund (oder an der bestaetigten Aufgabe) bleibt es still.
  assert.equal(detailTest.approvalNoticeView({ requires_approval: 1, approval_status: null, status: 'open' }), null);
  assert.equal(detailTest.approvalNoticeView({ requires_approval: 0, status: 'open', reject_note: 'alt' }), null);
  assert.equal(detailTest.approvalNoticeView({ requires_approval: 1, approval_status: 'approved', status: 'done', reject_note: 'alt' }), null);
});

test('der Admin-Blick bekommt Bestaetigung und Ablehnung, der andere nicht', () => {
  const admin = optionenBei(ANTRAG, { isAdmin: true }).actions.map((a) => a.id);
  assert.ok(admin.includes('task-detail-approve'), `Bestaetigung fehlt: ${admin.join(', ')}`);
  assert.ok(admin.includes('task-detail-reject'), `Ablehnung fehlt: ${admin.join(', ')}`);
  const gast = optionenBei(ANTRAG, { isAdmin: false }).actions.map((a) => a.id);
  assert.ok(!gast.includes('task-detail-approve'), 'der Nicht-Admin sieht keine Knopfe');
  assert.ok(!gast.includes('task-detail-reject'), 'keine leeren Versprechen');
  // Gegenprobe am Gegenfall: ohne Antrag gibt es die Knopfe auch dem Admin nicht.
  const ohne = optionenBei({ requires_approval: 1 }, { isAdmin: true }).actions.map((a) => a.id);
  assert.ok(!ohne.includes('task-detail-approve'), 'nur bei pending');
});

test('Bestaetigung POSTet action=approve und rueckt die Umgebung nach', async () => {
  const calls = [];
  globalThis.__apiStub = {
    post: async (path, body) => { calls.push([path, body]); return { data: null }; },
  };
  const toastsVorher = toasts.length;
  let nachgelaen = 0;
  const opts = optionenBei(ANTRAG, { isAdmin: true, onChanged: () => { nachgelaen += 1; } });
  const knopf = opts.actions.find((a) => a.id === 'task-detail-approve');
  let geschlossen = 0;
  await knopf.onClick({ button: {}, close: async () => { geschlossen += 1; } });
  assert.deepEqual(calls, [['/tasks/7/approval', { action: 'approve' }]]);
  assert.equal(nachgelaen, 1, 'die Umgebung ladet nach');
  assert.equal(geschlossen, 1, 'die Ansicht meldet sich ab');
  assert.ok(toasts.length > toastsVorher, 'eine Quittung gibt es auch');
  delete globalThis.__apiStub;
});

test('Ablehnung fragt den Grund (optional) und schickt ihn mit', async () => {
  const calls = [];
  globalThis.__apiStub = {
    post: async (path, body) => { calls.push([path, body]); return { data: null }; },
  };
  // Die Rueckfrage antwortet ohne echtes Fenster (derselbe Haken wie
  // __promptModal fuer promptModal): die Antwort kommt direkt.
  globalThis.__askOverModal = async () => 'Zu wenig geputzt.';
  const task = { ...BASIS, ...ANTRAG };
  const ctx = { currentUserId: 2, isAdmin: true, onChanged: () => {} };
  await detailTest.resolveTaskApproval(task, 'reject', {}, ctx, async () => {});
  assert.deepEqual(calls, [['/tasks/7/approval', { action: 'reject', note: 'Zu wenig geputzt.' }]]);
  assert.equal(task.status, 'open', 'die Aufgabe ist wieder offen');
  assert.equal(task.reject_note, 'Zu wenig geputzt.');
  assert.equal(task.approval_status, null);
  delete globalThis.__askOverModal;
  delete globalThis.__apiStub;
});

test('leerer Grund bleibt ohne note-Feld, Abbruch sendet gar nichts', async () => {
  const calls = [];
  globalThis.__apiStub = {
    post: async (path, body) => { calls.push([path, body]); return { data: null }; },
  };
  const ctx = { currentUserId: 2, isAdmin: true, onChanged: () => {} };
  globalThis.__askOverModal = async () => '   ';
  await detailTest.resolveTaskApproval({ ...BASIS, ...ANTRAG }, 'reject', {}, ctx, async () => {});
  assert.deepEqual(calls, [['/tasks/7/approval', { action: 'reject' }]], 'leer ist kein Grund');
  const vorher = calls.length;
  globalThis.__askOverModal = async () => null;
  await detailTest.resolveTaskApproval({ ...BASIS, ...ANTRAG }, 'reject', {}, ctx, async () => {});
  assert.equal(calls.length, vorher, 'Abbruch sendet nichts');
  delete globalThis.__askOverModal;
  delete globalThis.__apiStub;
});

test('der Ablehnungsgrund bleibt auf der Servergrenze (500 Zeichen)', async () => {
  const calls = [];
  globalThis.__apiStub = {
    post: async (path, body) => { calls.push([path, body]); return { data: null }; },
  };
  globalThis.__askOverModal = async () => 'x'.repeat(600);
  const ctx = { currentUserId: 2, isAdmin: true, onChanged: () => {} };
  await detailTest.resolveTaskApproval({ ...BASIS, ...ANTRAG }, 'reject', {}, ctx, async () => {});
  assert.equal(detailTest.REJECT_NOTE_MAX, 500);
  assert.equal(calls[0][1].note.length, 500, 'abgeschnitten, nie abgelehnt wegen Laenge');
  delete globalThis.__askOverModal;
  delete globalThis.__apiStub;
});
