'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => { cleanup = useIsolatedDataDir('ccc-booths-'); });
after(() => cleanup());

// Required after useIsolatedDataDir() so it opens its DB in the temp dir.
const booths = require('../../lib/ccc-booths');

test('getAvailability tallies the 4 seeded historical rows correctly', () => {
  const a = booths.getAvailability();
  // Seed data: freedom-way has 1 Expired (doesn't count) -> 40/40 available.
  // capitol-canopy has 1 Expired + 2 Paid (count) -> 28/30 available.
  assert.equal(a['freedom-way'].total, 40);
  assert.equal(a['freedom-way'].available, 40);
  assert.equal(a['capitol-canopy'].total, 30);
  assert.equal(a['capitol-canopy'].available, 28);
});

test('createSignup rejects an unknown booth type', () => {
  const r = booths.createSignup({ booth_type: 'nonexistent', email: 'a@b.com', brand_name: 'Brand' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_booth_type');
});

test('createSignup requires email and brand_name', () => {
  assert.equal(booths.createSignup({ booth_type: 'freedom-way', brand_name: 'Brand' }).ok, false);
  assert.equal(booths.createSignup({ booth_type: 'freedom-way', email: 'a@b.com' }).ok, false);
});

test('createSignup reserves a slot and decrements availability', () => {
  const before1 = booths.getAvailability()['freedom-way'].available;
  const r = booths.createSignup({
    booth_type: 'freedom-way', first_name: 'Test', last_name: 'Person',
    email: 'test1@example.com', brand_name: 'Test Brand', product_category: 'Testing',
  });
  assert.equal(r.ok, true);
  assert.match(r.reservationId, /^[a-f0-9]{24}$/);
  assert.match(r.paymentUrl, /client_reference_id=/);
  assert.match(r.paymentUrl, /prefilled_email=test1%40example\.com/);
  assert.equal(booths.getAvailability()['freedom-way'].available, before1 - 1);
});

test('setStatus updates a reservation; rejects bad status and unknown id', () => {
  const r = booths.createSignup({ booth_type: 'capitol-canopy', email: 'test2@example.com', brand_name: 'Brand 2' });
  const ok = booths.setStatus(r.reservationId, 'Paid');
  assert.equal(ok.ok, true);
  const row = booths.listAll({ booth_type: 'capitol-canopy' }).find((x) => x.reservation_id === r.reservationId);
  assert.equal(row.status, 'Paid');

  assert.equal(booths.setStatus(r.reservationId, 'NotAStatus').ok, false);

  const notFound = booths.setStatus('doesnotexist', 'Paid');
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, 'not_found');
});

test('createSignup blocks once a booth is sold out', () => {
  const avail = booths.getAvailability()['capitol-canopy'].available;
  for (let i = 0; i < avail; i++) {
    const r = booths.createSignup({ booth_type: 'capitol-canopy', email: `fill${i}@example.com`, brand_name: `Filler ${i}` });
    assert.equal(r.ok, true, `fill slot ${i} should succeed`);
  }
  assert.equal(booths.getAvailability()['capitol-canopy'].available, 0);

  const overflow = booths.createSignup({ booth_type: 'capitol-canopy', email: 'overflow@example.com', brand_name: 'Overflow' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error, 'sold_out');
});

test('listAll filters by booth_type and status', () => {
  const paidCapitol = booths.listAll({ booth_type: 'capitol-canopy', status: 'Paid' });
  assert.ok(paidCapitol.length > 0);
  assert.ok(paidCapitol.every((r) => r.booth_type === 'capitol-canopy' && r.status === 'Paid'));
});
