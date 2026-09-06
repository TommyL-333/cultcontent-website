'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => { cleanup = useIsolatedDataDir('ccc-network-'); });
after(() => cleanup());

const net = require('../../lib/ccc-network');

// terms_accepted defaults to true in these helpers so the existing tests keep
// exercising what they were written for; the consent rules get their own
// describe block below, which passes it explicitly either way.
function makeCreator(email, overrides = {}) {
  return net.signup({ role: 'creator', first_name: 'Test', last_name: 'Creator', email, looking_for: 'brands', terms_accepted: true, ...overrides });
}
function makeBrand(email, overrides = {}) {
  return net.signup({ role: 'brand', first_name: 'Test', last_name: 'Brand', email, brand_name: 'Brand Co', looking_for: 'creators', terms_accepted: true, ...overrides });
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
    const r = net.signup({ role: 'brand', first_name: 'X', email: 'brandnoname@example.com', terms_accepted: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'brand_name is required for brand signups');
  });
  test('tiktok_handle and instagram_handle are separate fields, both persisted', () => {
    const r = net.signup({
      role: 'creator', first_name: 'Two', last_name: 'Handles', email: 'twohandles@example.com',
      tiktok_handle: '@tiktokname', instagram_handle: '@instaname', looking_for: 'brands', terms_accepted: true,
    });
    assert.equal(r.ok, true);
    const p = net.getPerson(r.uuid);
    assert.equal(p.tiktok_handle, '@tiktokname');
    assert.equal(p.instagram_handle, '@instaname');
  });
  test('updateProfile updates tiktok_handle and instagram_handle independently', () => {
    const r = makeCreator('handleupdate@example.com', { tiktok_handle: '@old' });
    net.updateProfile(net.getPerson(r.uuid).id, {
      first_name: 'Handle', last_name: 'Update', looking_for: 'brands',
      tiktok_handle: '@new', instagram_handle: '@fresh',
    });
    const p = net.getPerson(r.uuid);
    assert.equal(p.tiktok_handle, '@new');
    assert.equal(p.instagram_handle, '@fresh');
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
  test('a brand cannot set its own tier — that is staff-assigned', () => {
    // Tier gates early roster access and the creator contact export, so
    // self-service here would be self-granted sponsor access.
    const before = net.getPerson(person.uuid).tier;
    const result = net.setTierRequest(person.id, 'executive');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'tier_is_admin_assigned');
    assert.equal(net.getPerson(person.uuid).tier, before, 'tier must be unchanged');
  });

  test('staff can still set a tier through setStatus', () => {
    const b = makeBrand('stafftier@example.com');
    const promoted = net.setStatus(b.uuid, { status: 'approved', tier: 'priority' });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.person.tier, 'priority');
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

describe('terms + contact sharing consent', () => {
  test('signup is refused outright when the terms box was not ticked', () => {
    const r = net.signup({ role: 'creator', first_name: 'No', email: 'noterms@example.com', looking_for: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'terms_not_accepted');
    assert.equal(net.getPersonByEmail('noterms@example.com'), null, 'no row should be written');
  });

  test('accepting the terms records when, and contact sharing defaults to off', () => {
    const r = makeCreator('defaultshare@example.com');
    const p = net.getPerson(r.uuid);
    assert.equal(p.share_contact, 0);
    assert.ok(p.terms_accepted_at, 'expected an accepted-at timestamp');
  });

  test('the sponsor export only ever contains creators who opted in', () => {
    const optedOut = makeCreator('optout@example.com');
    const optedIn = makeCreator('optin@example.com', { share_contact: true });
    net.setStatus(optedOut.uuid, { status: 'approved' });
    net.setStatus(optedIn.uuid, { status: 'approved' });

    const emails = net.listApprovedCreatorsForExport().map((r) => r.email);
    assert.ok(emails.includes('optin@example.com'), 'opted-in creator should be exported');
    assert.ok(!emails.includes('optout@example.com'), 'opted-out creator must never be exported');
  });

  test('turning sharing off removes someone from the export again', () => {
    const c = makeCreator('togglesharing@example.com', { share_contact: true });
    net.setStatus(c.uuid, { status: 'approved' });
    const person = net.getPerson(c.uuid);
    assert.ok(net.listApprovedCreatorsForExport().some((r) => r.email === 'togglesharing@example.com'));

    net.setContactSharing(person.id, false);
    assert.ok(!net.listApprovedCreatorsForExport().some((r) => r.email === 'togglesharing@example.com'));
  });
});

describe('photo, rates, and profile completion', () => {
  test('a photo url is normalised, and a non-http one is dropped', () => {
    const c = makeCreator('photo1@example.com');
    const p = net.getPerson(c.uuid);
    net.updateProfile(p.id, { first_name: 'P', photo_url: 'cdn.example.com/a.jpg' });
    assert.equal(net.getPerson(c.uuid).photo_url, 'https://cdn.example.com/a.jpg');

    // The value is rendered into an <img src> for every other member.
    net.updateProfile(p.id, { first_name: 'P', photo_url: 'javascript:alert(1)' });
    assert.equal(net.getPerson(c.uuid).photo_url, '');
  });

  test('rates are hidden from someone with no accepted connection', () => {
    const creator = makeCreator('rates1@example.com');
    const brand = makeBrand('ratesbrand1@example.com');
    const c = approve(creator.uuid);
    const b = approve(brand.uuid);
    net.updateProfile(c.id, { first_name: 'R', rate_price: '$500 per video', rate_videos: '4 a month', rate_terms: '30 day usage' });

    const seen = net.getPersonProfile(b.id, creator.uuid);
    assert.equal(seen.rate_price, undefined, 'rate must not leak before connecting');
    assert.equal(seen.rate_videos, undefined);
    assert.equal(seen.rate_terms, undefined);
    assert.equal(seen.email, undefined, 'contact still gated too');
  });

  test('rates appear once the connection is accepted, in both directions', () => {
    const creator = makeCreator('rates2@example.com');
    const brand = makeBrand('ratesbrand2@example.com');
    const c = approve(creator.uuid);
    const b = approve(brand.uuid);
    net.updateProfile(c.id, { first_name: 'R', rate_price: '$800 per video' });

    net.connect(b.id, creator.uuid);
    net.respondToConnection(c.id, brand.uuid, true);

    assert.equal(net.getPersonProfile(b.id, creator.uuid).rate_price, '$800 per video');
  });

  test('rates never appear in the directory listing, connected or not', () => {
    const creator = makeCreator('rates3@example.com');
    const brand = makeBrand('ratesbrand3@example.com');
    const c = approve(creator.uuid);
    const b = approve(brand.uuid);
    net.updateProfile(c.id, { first_name: 'R', rate_price: '$999 per video', photo_url: 'https://cdn.example.com/x.jpg' });
    net.connect(b.id, creator.uuid);
    net.respondToConnection(c.id, brand.uuid, true);

    const listed = net.listDirectory(b).people.find((p) => p.uuid === creator.uuid);
    assert.ok(listed, 'creator should be listed');
    // Browsing is not the same as connecting — the directory is a public
    // surface even between connected people.
    assert.equal(listed.rate_price, undefined, 'directory must never carry rates');
    assert.equal(listed.email, undefined);
    assert.equal(listed.photo_url, 'https://cdn.example.com/x.jpg', 'photo is public, unlike rates');
  });

  test('completion reports what is missing and reaches 100 when filled', () => {
    const creator = makeCreator('completion@example.com');
    const p = net.getPerson(creator.uuid);

    const before = net.profileCompletion(p);
    assert.ok(before.percent < 100);
    assert.ok(before.missing.includes('A profile photo'));
    assert.ok(before.missing.includes('Your rates'));

    net.updateProfile(p.id, {
      first_name: 'Full', photo_url: 'https://cdn.example.com/a.jpg', bio: 'hi',
      looking_for: 'brands', tiktok_handle: '@x', category: 'beauty', rate_price: '$500',
    });
    const after = net.profileCompletion(net.getPerson(creator.uuid));
    assert.equal(after.percent, 100);
    assert.deepEqual(after.missing, []);
  });

  test('brands are not scored on rates, which they do not have', () => {
    const brand = makeBrand('completionbrand@example.com');
    const p = net.getPerson(brand.uuid);
    net.updateProfile(p.id, {
      first_name: 'B', brand_name: 'Brand Co', photo_url: 'https://cdn.example.com/b.jpg',
      bio: 'we sell things', looking_for: 'creators', category: 'wellness',
    });
    const done = net.profileCompletion(net.getPerson(brand.uuid));
    assert.equal(done.percent, 100, 'a brand with no rates should still be complete');
  });
});

describe('brand contact opt-in', () => {
  test('a brand that has not opted in stays gated to creators', () => {
    const brand = makeBrand('closedbrand@example.com');
    const creator = makeCreator('viewer1@example.com');
    const b = approve(brand.uuid);
    const c = approve(creator.uuid);
    net.updateProfile(b.id, { first_name: 'B', brand_name: 'Closed Co', phone: '555' });

    const seen = net.getPersonProfile(c.id, brand.uuid);
    assert.equal(seen.email, undefined);
    assert.equal(seen.phone, undefined);
    assert.equal(seen.contact_is_public, false);
  });

  test('a brand that opts in is contactable by creators without connecting', () => {
    const brand = makeBrand('openbrand@example.com');
    const creator = makeCreator('viewer2@example.com');
    const b = approve(brand.uuid);
    const c = approve(creator.uuid);
    net.setContactSharing(b.id, true);

    const seen = net.getPersonProfile(c.id, brand.uuid);
    assert.equal(seen.email, 'openbrand@example.com');
    assert.equal(seen.contact_is_public, true);
  });

  test('opting in exposes the brand to creators only — not to other brands', () => {
    const brand = makeBrand('openbrand2@example.com');
    const rival = makeBrand('rivalbrand@example.com');
    const b = approve(brand.uuid);
    const r = approve(rival.uuid);
    net.setContactSharing(b.id, true);

    // A competing brand harvesting exhibitor contacts is exactly what this
    // must not enable — they still have to send a connection request.
    const seen = net.getPersonProfile(r.id, brand.uuid);
    assert.equal(seen.email, undefined, 'a rival brand must still be gated');
    assert.equal(seen.contact_is_public, false);
  });

  test('a creator opting in does NOT publish their contact to brands browsing', () => {
    const creator = makeCreator('optincreator@example.com');
    const brand = makeBrand('browsingbrand@example.com');
    const c = approve(creator.uuid);
    const b = approve(brand.uuid);
    net.setContactSharing(c.id, true);

    // For a creator the flag governs the sponsor export, not direct browsing.
    const seen = net.getPersonProfile(b.id, creator.uuid);
    assert.equal(seen.email, undefined, 'creator contact stays behind a connection');
    assert.equal(seen.contact_is_public, false);
  });

  test('an opted-in brand still never exposes rates or the CRM id', () => {
    const brand = makeBrand('openbrand3@example.com');
    const creator = makeCreator('viewer3@example.com');
    const b = approve(brand.uuid);
    const c = approve(creator.uuid);
    net.setContactSharing(b.id, true);
    net.updateProfile(b.id, { first_name: 'B', brand_name: 'Open Co', rate_price: 'should never show' });

    const seen = net.getPersonProfile(c.id, brand.uuid);
    assert.equal(seen.rate_price, undefined);
    assert.equal(seen.ghl_contact_id, undefined);
  });
});
