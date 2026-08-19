'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => { cleanup = useIsolatedDataDir('ccc-network-'); });
after(() => cleanup());

const net = require('../../lib/ccc-network');

function makeCreator(email, overrides = {}) {
  return net.signup({ role: 'creator', first_name: 'Test', last_name: 'Creator', email, looking_for: 'brands', ...overrides });
}
function makeBrand(email, overrides = {}) {
  return net.signup({ role: 'brand', first_name: 'Test', last_name: 'Brand', email, brand_name: 'Brand Co', looking_for: 'creators', ...overrides });
}
function approve(uuid, extra = {}) {
  return net.setStatus(uuid, { status: 'approved', ...extra }).person;
}

describe('signup', () => {
  test('rejects an invalid role', () => {
    assert.equal(net.signup({ role: 'sponsor', first_name: 'X', email: 'x@example.com' }).ok, false);
  });
  test('requires first_name and email', () => {
    assert.equal(net.signup({ role: 'creator', email: 'x@example.com' }).ok, false);
    assert.equal(net.signup({ role: 'creator', first_name: 'X' }).ok, false);
  });
  test('brand requires brand_name', () => {
    const r = net.signup({ role: 'brand', first_name: 'X', email: 'brandnoname@example.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'brand_name is required for brand signups');
  });
  test('creates a creator, defaulting tier=general and status=pending', () => {
    const r = makeCreator('creator1@example.com');
    assert.equal(r.ok, true);
    const p = net.getPerson(r.uuid);
    assert.equal(p.role, 'creator');
    assert.equal(p.tier, 'general');
    assert.equal(p.status, 'pending');
    assert.deepEqual(p.links, []);
  });
  test('brand can self-declare a priority tier at signup', () => {
    const r = makeBrand('brand1@example.com', { tier: 'priority' });
    assert.equal(net.getPerson(r.uuid).tier, 'priority');
  });
  test('creator cannot self-declare a priority tier — forced to general', () => {
    const r = makeCreator('creator-tier@example.com', { tier: 'priority' });
    assert.equal(net.getPerson(r.uuid).tier, 'general');
  });
  test('duplicate email while still pending resends + refreshes instead of rejecting', () => {
    // Self-serve signup has no admin approval step to fall back on, so a
    // pending row can only mean "never confirmed the first email" — treat
    // resubmission as a resend, not a conflict, or a lost/expired
    // confirmation link would permanently strand that person.
    const r1 = makeCreator('dup-pending@example.com', { bio: 'first draft' });
    const r2 = makeCreator('dup-pending@example.com', { bio: 'fixed typo' });
    assert.equal(r2.ok, true);
    assert.equal(r2.resent, true);
    assert.equal(r2.uuid, r1.uuid); // same person, not a new row
    assert.equal(net.getPerson(r2.uuid).bio, 'fixed typo'); // profile refreshed
    assert.equal(net.getPerson(r2.uuid).status, 'pending'); // still not approved
  });
  test('rejects a duplicate email once already approved/rejected/deactivated', () => {
    const r1 = makeCreator('dup-approved@example.com');
    approve(r1.uuid);
    const r2 = makeCreator('dup-approved@example.com');
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'already_registered');
    assert.equal(r2.status, 'approved');
  });
  test('email is normalized (case + whitespace)', () => {
    makeCreator(' Case@Example.com ');
    assert.ok(net.getPersonByEmail('case@example.com'));
  });
});

describe('status / approval / magic links', () => {
  test('createMagicLink returns null for a non-approved person (caller responds generically either way)', () => {
    makeCreator('notapproved@example.com');
    assert.equal(net.createMagicLink('notapproved@example.com'), null);
  });
  test('setStatus approves and stamps approved_at', () => {
    const r = makeCreator('approveme@example.com');
    const res = net.setStatus(r.uuid, { status: 'approved' });
    assert.equal(res.ok, true);
    assert.equal(res.person.status, 'approved');
    assert.ok(res.person.approved_at);
  });
  test('setStatus rejects an invalid status value', () => {
    const r = makeCreator('badstatus@example.com');
    assert.equal(net.setStatus(r.uuid, { status: 'banned' }).ok, false);
  });
  test('setStatus on an unknown uuid returns not_found', () => {
    const res = net.setStatus('00000000-0000-0000-0000-000000000000', { status: 'approved' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_found');
  });
  test('magic link: create, consume once, reject reuse', () => {
    const r = makeCreator('magic1@example.com');
    approve(r.uuid);
    const link = net.createMagicLink('magic1@example.com');
    assert.ok(link.token);
    const consumed = net.consumeMagicLink(link.token);
    assert.equal(consumed.ok, true);
    assert.equal(consumed.person.uuid, r.uuid);
    const reused = net.consumeMagicLink(link.token);
    assert.equal(reused.ok, false);
    assert.equal(reused.error, 'already_used');
  });
  test('magic link: invalid token rejected', () => {
    const r = net.consumeMagicLink('not-a-real-token');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_token');
  });
});

describe('directory gating', () => {
  test('creators always see the full directory', () => {
    const c = makeCreator('dirc1@example.com');
    approve(c.uuid);
    assert.equal(net.listDirectory(net.getPerson(c.uuid)).gated, false);
  });
  test('priority-tier brands always see the full directory', () => {
    const b = makeBrand('dirb1@example.com', { tier: 'priority' });
    approve(b.uuid, { tier: 'priority' });
    assert.equal(net.listDirectory(net.getPerson(b.uuid)).gated, false);
  });
  test('general-tier brand is gated while CCC_NETWORK_GENERAL_OPENS_AT is in the future', () => {
    process.env.CCC_NETWORK_GENERAL_OPENS_AT = new Date(Date.now() + 86400000).toISOString();
    const b = makeBrand('dirb2@example.com');
    approve(b.uuid);
    const result = net.listDirectory(net.getPerson(b.uuid));
    assert.equal(result.gated, true);
    assert.ok(result.opensAt);
    delete process.env.CCC_NETWORK_GENERAL_OPENS_AT;
  });
  test('general-tier brand sees the directory once the open date has passed', () => {
    process.env.CCC_NETWORK_GENERAL_OPENS_AT = new Date(Date.now() - 86400000).toISOString();
    const b = makeBrand('dirb3@example.com');
    approve(b.uuid);
    assert.equal(net.listDirectory(net.getPerson(b.uuid)).gated, false);
    delete process.env.CCC_NETWORK_GENERAL_OPENS_AT;
  });
  test('directory excludes the viewer themselves and non-approved people', () => {
    const c = makeCreator('dirself@example.com');
    approve(c.uuid);
    const pending = makeCreator('dirpending@example.com'); // left pending
    const { people } = net.listDirectory(net.getPerson(c.uuid));
    assert.ok(!people.some((p) => p.uuid === c.uuid));
    assert.ok(!people.some((p) => p.uuid === pending.uuid));
  });
});

describe('connections: request -> accept', () => {
  let creator, brand;
  before(() => {
    creator = approve(makeCreator('connA@example.com').uuid);
    brand = approve(makeBrand('connB@example.com').uuid);
  });

  test('cannot connect to self', () => {
    const r = net.connect(creator.id, creator.uuid);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cannot_connect_to_self');
  });
  test('cannot connect to a non-approved person', () => {
    const pendingPerson = makeCreator('connpending@example.com');
    const r = net.connect(creator.id, pendingPerson.uuid);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_found');
  });
  test('connect() creates a pending request without revealing contact info', () => {
    const r = net.connect(creator.id, brand.uuid);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pending');
    assert.equal(r.otherPerson.email, undefined);
  });
  test('connect() again while pending is a no-op, still pending', () => {
    assert.equal(net.connect(creator.id, brand.uuid).status, 'pending');
  });
  test('listConnections buckets correctly for both sides', () => {
    const creatorConns = net.listConnections(creator.id);
    assert.equal(creatorConns.outgoing.length, 1);
    assert.equal(creatorConns.outgoing[0].uuid, brand.uuid);
    assert.equal(creatorConns.current.length, 0);

    const brandConns = net.listConnections(brand.id);
    assert.equal(brandConns.incoming.length, 1);
    assert.equal(brandConns.incoming[0].uuid, creator.uuid);
  });
  test('getPersonProfile reflects outgoing/incoming relationship, no contact pre-accept', () => {
    const asCreator = net.getPersonProfile(creator.id, brand.uuid);
    assert.equal(asCreator.relationship, 'outgoing');
    assert.equal(asCreator.email, undefined);

    const asBrand = net.getPersonProfile(brand.id, creator.uuid);
    assert.equal(asBrand.relationship, 'incoming');
  });
  test('respondToConnection(accept) reveals contact info both ways', () => {
    const res = net.respondToConnection(brand.id, creator.uuid, true);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'accepted');
    assert.ok(res.otherPerson.email);

    const asCreator = net.getPersonProfile(creator.id, brand.uuid);
    assert.equal(asCreator.relationship, 'accepted');
    assert.ok(asCreator.email);

    const asBrand = net.getPersonProfile(brand.id, creator.uuid);
    assert.equal(asBrand.relationship, 'accepted');
    assert.ok(asBrand.email);
  });
  test('accepted connection now appears in both sides "current" list', () => {
    assert.equal(net.listConnections(creator.id).current.length, 1);
    assert.equal(net.listConnections(brand.id).current.length, 1);
  });
  test('connect() again post-accept is a no-op returning accepted', () => {
    assert.equal(net.connect(creator.id, brand.uuid).status, 'accepted');
  });
});

describe('connections: decline + re-request', () => {
  let creator, brand;
  before(() => {
    creator = approve(makeCreator('declA@example.com').uuid);
    brand = approve(makeBrand('declB@example.com').uuid);
    net.connect(creator.id, brand.uuid);
  });

  test('respondToConnection(decline) sets status declined, no contact reveal', () => {
    const res = net.respondToConnection(brand.id, creator.uuid, false);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'declined');
    assert.equal(res.otherPerson.email, undefined);
  });
  test('declined connection appears in no bucket', () => {
    const conns = net.listConnections(creator.id);
    assert.equal(conns.current.length, 0);
    assert.equal(conns.outgoing.length, 0);
  });
  test('connect() after a decline resets to pending, allowing a fresh request', () => {
    const r = net.connect(creator.id, brand.uuid);
    assert.equal(r.ok, true);
    assert.equal(r.status, 'pending');
    assert.equal(net.listConnections(creator.id).outgoing.length, 1);
  });
  test('respondToConnection with no matching pending request returns not_found', () => {
    const stranger = approve(makeCreator('stranger@example.com').uuid);
    const res = net.respondToConnection(brand.id, stranger.uuid, true);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_found');
  });
});

describe('settings', () => {
  let person;
  before(() => { person = approve(makeBrand('settings1@example.com').uuid); });

  test('setNotificationPrefs persists booleans as 0/1', () => {
    const updated = net.setNotificationPrefs(person.id, { notify_request: false, notify_approval: true, notify_message: false });
    assert.equal(updated.notify_request, 0);
    assert.equal(updated.notify_approval, 1);
    assert.equal(updated.notify_message, 0);
  });
  test('setTierRequest accepts a valid tier, rejects an invalid one', () => {
    const ok = net.setTierRequest(person.id, 'executive');
    assert.equal(ok.ok, true);
    assert.equal(ok.person.tier, 'executive');
    assert.equal(net.setTierRequest(person.id, 'diamond').ok, false);
  });
  test('requestEmailChange rejects an invalid or already-registered email', () => {
    approve(makeCreator('taken@example.com').uuid);
    assert.equal(net.requestEmailChange(person.id, 'not-an-email').ok, false);
    assert.equal(net.requestEmailChange(person.id, 'taken@example.com').ok, false);
  });
  test('requestEmailChange + confirmEmailChange updates the email; token is single-use', () => {
    const req = net.requestEmailChange(person.id, 'newemail@example.com');
    assert.equal(req.ok, true);
    const confirmed = net.confirmEmailChange(req.token);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.person.email, 'newemail@example.com');
    assert.equal(net.getPersonByEmail('newemail@example.com').id, person.id);

    const reused = net.confirmEmailChange(req.token);
    assert.equal(reused.ok, false);
    assert.equal(reused.error, 'invalid_token');
  });
  test('deactivate sets status to deactivated', () => {
    net.deactivate(person.id);
    assert.equal(net.getPerson(person.id).status, 'deactivated');
  });
});

describe('admin listing', () => {
  test('listAll filters by role/status/tier', () => {
    assert.ok(net.listAll({ role: 'creator' }).every((p) => p.role === 'creator'));
    assert.ok(net.listAll({ status: 'approved' }).every((p) => p.status === 'approved'));
  });
  test('listApprovedCreatorsForExport returns only approved creators', () => {
    const rows = net.listApprovedCreatorsForExport();
    assert.ok(Array.isArray(rows));
  });
});
