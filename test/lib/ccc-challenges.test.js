'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { useIsolatedDataDir } = require('../helpers/isolated-data-dir');

let cleanup;
before(() => { cleanup = useIsolatedDataDir('ccc-challenges-'); });
after(() => cleanup());

const net = require('../../lib/ccc-network');
const ch = require('../../lib/ccc-challenges');

function approvedCreator(email) {
  const r = net.signup({ role: 'creator', first_name: 'C', last_name: 'One', email, looking_for: 'x', terms_accepted: true });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}
function approvedBrand(email, brandName = 'Brand Co') {
  const r = net.signup({ role: 'brand', first_name: 'B', last_name: 'One', email, brand_name: brandName, looking_for: 'x', terms_accepted: true });
  return net.setStatus(r.uuid, { status: 'approved' }).person;
}

describe('normalizeUrl', () => {
  test('accepts a bare domain and adds https', () => {
    assert.equal(ch.normalizeUrl('tiktok.com/@a/video/1'), 'https://tiktok.com/@a/video/1');
  });
  test('keeps an existing scheme', () => {
    assert.equal(ch.normalizeUrl('http://example.com/x'), 'http://example.com/x');
  });
  test('rejects anything that is not http(s)', () => {
    // The URL ends up in an href on the brand's screen, so a javascript: or
    // data: value must never survive normalization.
    assert.equal(ch.normalizeUrl('javascript:alert(1)'), null);
    assert.equal(ch.normalizeUrl('data:text/html,<script>'), null);
    assert.equal(ch.normalizeUrl('  '), null);
    assert.equal(ch.normalizeUrl('notadomain'), null);
  });
});

describe('creating challenges', () => {
  test('only brands can create one', () => {
    const creator = approvedCreator('chcreator1@example.com');
    assert.equal(ch.createChallenge(creator, { title: 'Nope' }).error, 'brands_only');
  });

  test('a title is required', () => {
    const brand = approvedBrand('chbrand1@example.com');
    assert.equal(ch.createChallenge(brand, { title: '   ' }).error, 'title_required');
  });

  test('a created challenge shows up in the roster feed with its brand', () => {
    const brand = approvedBrand('chbrand2@example.com', 'Oceanblue');
    const creator = approvedCreator('chcreator2@example.com');
    const r = ch.createChallenge(brand, { title: 'Film it', description: 'do the thing', reward: '$500' });
    assert.equal(r.ok, true);

    const feed = ch.listChallenges(creator);
    const found = feed.find((c) => c.uuid === r.challenge.uuid);
    assert.ok(found);
    assert.equal(found.brand_name, 'Oceanblue');
    assert.equal(found.entry_count, 0);
  });
});

describe('submitting links', () => {
  test('a creator can submit, and the brand sees the entry', () => {
    const brand = approvedBrand('chbrand3@example.com');
    const creator = approvedCreator('chcreator3@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Enter me' });

    const entered = ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/video/9', note: 'here you go' });
    assert.equal(entered.ok, true);
    assert.equal(entered.challenge.entry_count, 1);

    const listed = ch.listEntries(brand, challenge.uuid);
    assert.equal(listed.ok, true);
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].links[0].url, 'https://tiktok.com/@c/video/9');
    assert.equal(listed.entries[0].links[0].note, 'here you go');
  });

  test('a second link is added, not substituted for the first', () => {
    // The whole point of the rewrite: a brief asking for three videos used to
    // overwrite each previous one, silently destroying the creator's work.
    const brand = approvedBrand('chbrand4@example.com');
    const creator = approvedCreator('chcreator4@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Three videos', deliverables: 3 });

    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/video/1' });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/video/2' });
    const third = ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/video/3' });

    assert.equal(third.ok, true);
    assert.equal(third.challenge.entry_count, 1, 'still one entry, not three');

    const [entry] = ch.listEntries(brand, challenge.uuid).entries;
    assert.equal(entry.links.length, 3);
    assert.deepEqual(entry.links.map((l) => l.url), [
      'https://tiktok.com/@c/video/1',
      'https://tiktok.com/@c/video/2',
      'https://tiktok.com/@c/video/3',
    ]);
    assert.equal(entry.complete, true, 'three of three should read as complete');
  });

  test('an entry short of the deliverable count is not complete', () => {
    const brand = approvedBrand('chbrand4b@example.com');
    const creator = approvedCreator('chcreator4b@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Three videos', deliverables: 3 });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/only-one' });

    const [entry] = ch.listEntries(brand, challenge.uuid).entries;
    assert.equal(entry.links.length, 1);
    assert.equal(entry.complete, false);
  });

  test('the same link twice is refused rather than counted as two deliverables', () => {
    const brand = approvedBrand('chbrand4c@example.com');
    const creator = approvedCreator('chcreator4c@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Dupes', deliverables: 2 });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/same' });
    const again = ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/same' });
    assert.equal(again.error, 'duplicate_link');
  });

  test('a creator can remove one link without losing the rest', () => {
    const brand = approvedBrand('chbrand4d@example.com');
    const creator = approvedCreator('chcreator4d@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Removable', deliverables: 3 });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/keep1' });
    const second = ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/drop' });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/keep2' });

    const dropId = second.entry.links.find((l) => l.url.endsWith('/drop')).id;
    const after = ch.removeLink(creator, challenge.uuid, dropId);
    assert.equal(after.ok, true);
    assert.deepEqual(after.entry.links.map((l) => l.url), [
      'https://tiktok.com/@c/keep1',
      'https://tiktok.com/@c/keep2',
    ]);
  });

  test('links are capped so one creator cannot flood the review queue', () => {
    const brand = approvedBrand('chbrand4e@example.com');
    const creator = approvedCreator('chcreator4e@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Cap', deliverables: 1 });
    for (let i = 0; i < ch.MAX_LINKS_PER_ENTRY; i += 1) {
      assert.equal(ch.submitLink(creator, challenge.uuid, { url: `tiktok.com/@c/v${i}` }).ok, true);
    }
    assert.equal(ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/one-too-many' }).error, 'too_many_links');
  });

  test('brands cannot enter their own challenge', () => {
    const brand = approvedBrand('chbrand5@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Mine' });
    assert.equal(ch.submitLink(brand, challenge.uuid, { url: 'tiktok.com/x' }).error, 'creators_only');
  });

  test('a bad url is refused and no entry is recorded', () => {
    const brand = approvedBrand('chbrand6@example.com');
    const creator = approvedCreator('chcreator6@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Strict' });

    assert.equal(ch.submitLink(creator, challenge.uuid, { url: 'javascript:alert(1)' }).error, 'bad_url');
    assert.equal(ch.listEntries(brand, challenge.uuid).entries.length, 0);
  });

  test('a closed challenge takes no new links', () => {
    const brand = approvedBrand('chbrand7@example.com');
    const creator = approvedCreator('chcreator7@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Closing time' });
    ch.setChallengeStatus(brand, challenge.uuid, 'closed');

    assert.equal(ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/x' }).error, 'closed');
  });

  test('withdrawing removes the entry and all of its links', () => {
    const brand = approvedBrand('chbrand8@example.com');
    const creator = approvedCreator('chcreator8@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Second thoughts', deliverables: 2 });

    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/x' });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/y' });
    ch.withdrawEntry(creator, challenge.uuid);
    assert.equal(ch.listEntries(brand, challenge.uuid).entries.length, 0);
  });
});

describe('reviewing entries', () => {
  function setup(email, opts = {}) {
    const brand = approvedBrand(`rev-brand-${email}@example.com`);
    const creator = approvedCreator(`rev-creator-${email}@example.com`);
    const { challenge } = ch.createChallenge(brand, { title: 'Reviewable', deliverables: 1, ...opts });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/@c/v' });
    return { brand, creator, challenge };
  }

  test('an entry starts as submitted and unpaid', () => {
    const { brand, challenge } = setup('a');
    const [entry] = ch.listEntries(brand, challenge.uuid).entries;
    assert.equal(entry.status, 'submitted');
    assert.equal(entry.paid_at, null);
  });

  test('a brand can accept with a note, and the creator sees both', () => {
    const { brand, creator, challenge } = setup('b');
    const r = ch.reviewEntry(brand, challenge.uuid, creator.uuid, { status: 'accepted', brand_note: 'loved the second one' });
    assert.equal(r.ok, true);

    const mine = ch.listChallenges(creator).find((c) => c.uuid === challenge.uuid);
    assert.equal(mine.my_entry.status, 'accepted');
    assert.equal(mine.my_entry.brand_note, 'loved the second one');
    assert.ok(mine.my_entry.reviewed_at);
  });

  test('a winner-model challenge can mark a winner', () => {
    const { brand, creator, challenge } = setup('c', { reward_model: 'winners' });
    assert.equal(ch.reviewEntry(brand, challenge.uuid, creator.uuid, { status: 'winner' }).ok, true);
    assert.equal(ch.listEntries(brand, challenge.uuid).entries[0].status, 'winner');
  });

  test('an unknown status is refused', () => {
    const { brand, creator, challenge } = setup('d');
    assert.equal(ch.reviewEntry(brand, challenge.uuid, creator.uuid, { status: 'maybe' }).error, 'bad_status');
  });

  test('another brand cannot review or mark paid on someone else’s challenge', () => {
    const { creator, challenge } = setup('e');
    const rival = approvedBrand('revrival@example.com');
    assert.equal(ch.reviewEntry(rival, challenge.uuid, creator.uuid, { status: 'accepted' }).error, 'not_yours');
    assert.equal(ch.setEntryPaid(rival, challenge.uuid, creator.uuid, true).error, 'not_yours');
  });

  test('paid is a reversible record, not a money movement', () => {
    const { brand, creator, challenge } = setup('f');
    ch.setEntryPaid(brand, challenge.uuid, creator.uuid, true);
    assert.ok(ch.listEntries(brand, challenge.uuid).entries[0].paid_at);

    ch.setEntryPaid(brand, challenge.uuid, creator.uuid, false);
    assert.equal(ch.listEntries(brand, challenge.uuid).entries[0].paid_at, null);
  });
});

describe('entry visibility', () => {
  test('a different brand cannot read someone else’s entries', () => {
    const owner = approvedBrand('chowner@example.com');
    const nosy = approvedBrand('chnosy@example.com');
    const creator = approvedCreator('chcreator9@example.com');
    const { challenge } = ch.createChallenge(owner, { title: 'Private' });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/secret' });

    const attempt = ch.listEntries(nosy, challenge.uuid);
    assert.equal(attempt.ok, false);
    assert.equal(attempt.error, 'not_yours');
  });

  test('a creator cannot close a brand’s challenge', () => {
    const brand = approvedBrand('chbrand10@example.com');
    const creator = approvedCreator('chcreator10@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'Not yours to close' });
    assert.equal(ch.setChallengeStatus(creator, challenge.uuid, 'closed').error, 'not_yours');
  });

  test('entries never carry the creator’s email or phone', () => {
    const brand = approvedBrand('chbrand11@example.com');
    const creator = approvedCreator('chcreator11@example.com');
    const { challenge } = ch.createChallenge(brand, { title: 'No contact leak' });
    ch.submitLink(creator, challenge.uuid, { url: 'tiktok.com/x' });

    const [entry] = ch.listEntries(brand, challenge.uuid).entries;
    assert.equal(entry.email, undefined);
    assert.equal(entry.phone, undefined);
  });
});
