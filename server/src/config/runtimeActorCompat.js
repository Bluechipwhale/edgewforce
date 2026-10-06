import { isUuid } from '../utils/id.js';

const runtimeUserColumns = {
  inventory_movements: ['recorded_by'],
  orders: ['approved_by'],
  order_approvals: ['approver_id'],
  tasks: ['acknowledged_by', 'completed_by']
};

export async function retryLegacyRuntimeActorWrite(table, record, error, supabase, write) {
  if (!['22P02', '42804'].includes(error?.code) || !/bigint|integer/i.test(error.message || '')) return null;

  const columns = (runtimeUserColumns[table] || []).filter(column => isUuid(record[column]));
  if (!columns.length) return null;

  const legacy = { ...record };
  for (const uuid of new Set(columns.map(column => record[column]))) {
    const { data: user, error: lookupError } = await supabase.from('users')
      .select('id').eq('uuid', uuid).maybeSingle();
    if (lookupError || !user) return null;
    for (const column of columns) {
      if (record[column] === uuid) legacy[column] = user.id;
    }
  }
  return write(legacy);
}
