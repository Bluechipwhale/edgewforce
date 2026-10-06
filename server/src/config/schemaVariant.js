export function resolveSchemaVariant(value) {
  const variant = value || 'numbered';
  if (!['numbered', 'legacy'].includes(variant)) {
    throw new Error('SUPABASE_SCHEMA_VARIANT must be numbered or legacy.');
  }
  return variant;
}
