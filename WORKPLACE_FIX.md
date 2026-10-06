# Supabase workplace and clock-in repair

The repair adapts the UUID workplace fixes from the local `EdgeWForced` project to the GitHub application.

Employee and user tables keep numeric primary IDs, while workplace assignments, attendance, supervisor links and employee-to-user links reference their stable UUID columns. The application now resolves either form of employee ID and uses the UUID for those foreign keys. Authentication linking preserves the existing application UUID instead of replacing it with an Auth UUID.

The production database adapter uses the service-role client independently of staff sign-in clients. It accepts empty database results, waits up to eight seconds for reads, and propagates database failures. Production and serverless requests no longer store unsuccessful writes in an ephemeral local seed database. Tests use an isolated in-memory store.

Clock-in writes use the numbered schema's `date`, `clock_in_time`, `clock_in_lat` and related columns. Legacy deployments can explicitly select `SUPABASE_SCHEMA_VARIANT=legacy`. Workplace IDs are stored in `location_id`; they are not written into the separate `stores` foreign key. Assignment history captures the previous primary workplace before demotion, inactive workplaces are excluded, and the assignment form displays load errors.

## Deployment order

1. In the existing Supabase project, run `supabase/migrations/017_workplace_attendance_runtime.sql`. This adds attendance metadata and shift columns without deleting records or rewriting employee identities. It may be run repeatedly. The inspected database already has UUID alignment and location telemetry tables from the local project's migrations 011–016; do not replay historical seed/install scripts.
2. Confirm the backend has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` and `SUPABASE_SCHEMA_VARIANT=numbered`. Keep the service-role key on the server.
3. Merge/deploy the fix to the `edgewforced` Vercel project.
4. Assign an employee to an active workplace, refresh the employee's session, and verify clock-in from inside that workplace's geofence. Field/sales staff still follow Nigeria shift windows and GPS accuracy checks.

## Verification

- All 130 server tests pass, covering workplace assignment, temporary windows, GPS accuracy, shift attendance and authentication.
- The additional production test runs the actual Supabase adapter against an isolated HTTP simulation with the live database's column layout. It validates numeric-to-UUID assignment, reads taking longer than the former 450 ms cutoff, clock-in/out persistence, duplicate prevention, canonical attendance columns, correct workplace/store foreign keys and failure propagation.
- A local PostgreSQL engine executed migration 017 twice against a reconstruction of the inspected attendance schema, checked preservation of an existing record and accepted a UUID clock-in insert.
- The production frontend build succeeds.

Verification logs are ignored local files. Production migration and deployment status are recorded separately when applied.

## Live database status

Migration 017 was applied successfully to the existing Edgeforced production database. The SQL editor returned `Workplace attendance migration 017 applied` and verified the five workplace/shift columns. No employee assignments or attendance records were deleted.
