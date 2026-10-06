// Keep API aliases out of PostgREST writes; each schema stores one set of columns.
export function attendanceWrite(record, variant = 'numbered') {
  const result = { ...record };
  const aliases = [
    ['date', 'attendance_date'],
    ['clock_in_time', 'clock_in'], ['clock_out_time', 'clock_out'],
    ['clock_in_lat', 'clock_in_latitude'], ['clock_in_lng', 'clock_in_longitude'],
    ['clock_out_lat', 'clock_out_latitude'], ['clock_out_lng', 'clock_out_longitude']
  ];
  for (const [numbered, legacy] of aliases) {
    const [target, alias] = variant === 'numbered' ? [numbered, legacy] : [legacy, numbered];
    if (result[target] === undefined && result[alias] !== undefined) result[target] = result[alias];
    delete result[alias];
  }
  if (variant === 'numbered' && typeof result.status === 'string') {
    const statuses = { present: 'Present', late: 'Late', absent: 'Absent' };
    result.status = statuses[result.status.toLowerCase()] || result.status;
  }
  return result;
}
