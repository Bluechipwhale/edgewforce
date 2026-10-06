import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceWrite } from '../config/attendanceSchema.js';

test('numbered attendance accepts zero coordinates and removes legacy column aliases', () => {
  const record = attendanceWrite({
    attendance_date: '2026-10-05', clock_in: '2026-10-05T07:00:00Z',
    clock_in_latitude: 0, clock_in_longitude: 3.4, status: 'present',
    employee_id: 'f2d4b16a-73a9-4f01-9cf1-7a3e84ef6d28', morning_clock_in: '2026-10-05T07:00:00Z'
  });
  assert.equal(record.date, '2026-10-05');
  assert.equal(record.clock_in_lat, 0);
  assert.equal(record.status, 'Present');
  assert.equal(record.morning_clock_in, record.clock_in_time);
  for (const alias of ['attendance_date', 'clock_in', 'clock_in_latitude', 'clock_in_longitude']) {
    assert.ok(!Object.hasOwn(record, alias));
  }
});

test('legacy attendance keeps its own canonical columns for existing deployments', () => {
  const record = attendanceWrite({date: '2026-10-05', clock_out_time: null, clock_out_lat: 0}, 'legacy');
  assert.deepEqual(record, {attendance_date: '2026-10-05', clock_out: null, clock_out_latitude: 0});
});
