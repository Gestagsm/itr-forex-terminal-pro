'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TF, aggregateM1, cTimeInTimezone, timezoneDayStart } = require('../market');

function minute(time, price, volume = 1, ticks = 1) {
  return { t: time.getTime(), o: price, h: price + 1, l: price - 1, c: price, v: volume, n: ticks };
}

test('all standard timeframes aggregate M1 candles on local calendar boundaries', () => {
  for (const [name, minutes] of Object.entries(TF)) {
    const dayStart = new Date(2026, 5, 14, 0, 0, 0, 0);
    const boundary = new Date(dayStart.getTime() + minutes * 60000);
    const input = minutes === 1
      ? [minute(boundary, 12, 4, 2), minute(dayStart, 10, 2, 4)]
      : [
        minute(boundary, 12, 4, 2),
        minute(new Date(boundary.getTime() - 60000), 9, 3, 3),
        minute(dayStart, 10, 2, 4),
      ];
    const beforeCall = input.slice();
    const candles = aggregateM1(input, minutes);

    assert.deepEqual(input, beforeCall, `${name} leaves source rows untouched`);
    assert.equal(candles.length, 2, `${name} splits at its next boundary`);
    assert.equal(candles[0].t, dayStart.getTime(), `${name} aligns from local midnight`);
    assert.equal(candles[0].o, 10, `${name} open is earliest M1 open`);
    assert.equal(candles[0].h, 11, `${name} high is the interval maximum`);
    assert.equal(candles[0].l, minutes === 1 ? 9 : 8, `${name} low is the interval minimum`);
    assert.equal(candles[0].c, minutes === 1 ? 10 : 9, `${name} close is latest M1 close`);
    assert.equal(candles[0].v, minutes === 1 ? 2 : 5, `${name} sums volume`);
    assert.equal(candles[0].n, minutes === 1 ? 4 : 7, `${name} sums ticks`);
    assert.equal(candles[1].t, boundary.getTime(), `${name} second candle starts exactly on boundary`);
  }
});

test('D1 candles break at local midnight and preserve date boundaries', () => {
  const beforeMidnight = new Date(2026, 5, 14, 23, 59, 0, 0);
  const midnight = new Date(2026, 5, 15, 0, 0, 0, 0);
  const candles = aggregateM1([
    minute(midnight, 12),
    minute(beforeMidnight, 10),
  ], TF.D1);

  assert.equal(candles.length, 2);
  assert.equal(candles[0].t, new Date(2026, 5, 14, 0, 0, 0, 0).getTime());
  assert.equal(candles[0].time.slice(0, 10), '2026-06-14');
  assert.equal(candles[1].t, midnight.getTime());
  assert.equal(candles[1].time.slice(0, 10), '2026-06-15');
});

test('timezone-aligned candles and date boundaries follow the requested user timezone', () => {
  const beforeNairobiMidnight = Date.parse('2026-10-08T20:59:00Z');
  const nairobiMidnight = Date.parse('2026-10-08T21:00:00Z');
  const daily = aggregateM1([
    minute(new Date(nairobiMidnight), 12),
    minute(new Date(beforeNairobiMidnight), 10),
  ], TF.D1, 'Africa/Nairobi');

  assert.equal(daily.length, 2);
  assert.equal(daily[0].t, Date.parse('2026-10-07T21:00:00Z'));
  assert.equal(daily[1].t, nairobiMidnight);
  assert.equal(cTimeInTimezone(daily[1].t, 'Africa/Nairobi'), '2026-10-09 00:00');
  assert.equal(timezoneDayStart('2026-10-09', 'Africa/Nairobi'), nairobiMidnight);
});

test('DST changes preserve user-local day and repeated hourly candle boundaries', () => {
  const beforeSpringJump = Date.parse('2026-03-08T06:59:00Z');
  const afterSpringJump = Date.parse('2026-03-08T07:00:00Z');
  const springDaily = aggregateM1([
    minute(new Date(beforeSpringJump), 10),
    minute(new Date(afterSpringJump), 12),
  ], TF.D1, 'America/New_York');
  assert.equal(springDaily.length, 1);
  assert.equal(springDaily[0].t, Date.parse('2026-03-08T05:00:00Z'));
  assert.equal(timezoneDayStart('2026-03-09', 'America/New_York'), Date.parse('2026-03-09T04:00:00Z'));

  const repeatedHour = aggregateM1([
    minute(new Date('2026-11-01T05:30:00Z'), 10),
    minute(new Date('2026-11-01T06:30:00Z'), 12),
  ], TF.H1, 'America/New_York');
  assert.equal(repeatedHour.length, 2);
  assert.equal(repeatedHour[0].t, Date.parse('2026-11-01T05:00:00Z'));
  assert.equal(repeatedHour[1].t, Date.parse('2026-11-01T06:00:00Z'));
});

test('unsupported timeframe widths are rejected', () => {
  assert.deepEqual(aggregateM1([], 0), []);
  assert.deepEqual(aggregateM1([], 7), []);
  assert.deepEqual(aggregateM1([], 2880), []);
  assert.ok(Number.isNaN(timezoneDayStart('2026-02-30', 'UTC')));
});
