'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// app.js is a browser script, but createStore has no DOM access and the file
// only touches the DOM inside function bodies — so it unit-tests cleanly in
// Node via the guarded module.exports at the bottom.
const { createStore } = require('../public/app.js');

test('createStore: set merges a patch, notifies subscribers, and get returns state', () => {
  const store = createStore({ a: 1 });
  const seen = [];
  store.subscribe((s) => seen.push(s));
  store.set({ b: 2 });
  assert.deepEqual(store.get(), { a: 1, b: 2 }, 'patch is merged onto existing state');
  assert.equal(seen.length, 1, 'subscriber notified once per set');
  assert.equal(seen[0].b, 2);
});

test('createStore: unchanged slices keep object identity so subscribers can diff', () => {
  const store = createStore({ stats: { open_notifications: 3 }, attendance: [] });
  const statsRef = store.get().stats;
  const oldAttRef = store.get().attendance;
  store.set({ attendance: [{ id: 1, student_name: 'Aarav Sharma' }] });
  assert.equal(store.get().stats, statsRef, 'untouched slice keeps the same reference');
  assert.notEqual(store.get().attendance, oldAttRef, 'changed slice is a fresh reference');
});

test('createStore: subscribe returns an unsubscribe that stops notifications', () => {
  const store = createStore({});
  let calls = 0;
  const off = store.subscribe(() => calls++);
  off();
  store.set({ x: 1 });
  assert.equal(calls, 0, 'no notifications after unsubscribe');
});

test('createStore: two subscribers both receive every set, independently', () => {
  const store = createStore({});
  const a = [];
  const b = [];
  store.subscribe((s) => a.push(s.n));
  store.subscribe((s) => b.push(s.n));
  store.set({ n: 1 });
  store.set({ n: 2 });
  assert.deepEqual(a, [1, 2]);
  assert.deepEqual(b, [1, 2]);
});
