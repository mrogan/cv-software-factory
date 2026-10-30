-- The line compares the sessions in the store with Martin's sign-ins, so a session no sign-in recorded pages him
-- (apps/factory/src/line/admin-actions.ts): the admin service starts each in the transaction that appends its
-- `admin.signed-in`. It reads when each started, and nothing else: not the session's hash, its passkey or its end.

grant select (signed_in_at) on sessions to factory_line;
