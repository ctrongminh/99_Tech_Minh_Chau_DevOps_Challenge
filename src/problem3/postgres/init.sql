-- Runs once, on first initialisation of an empty data volume.
-- NOTE: the original `ALTER SYSTEM SET max_connections = 20;` was removed:
--   * this file was never mounted, so it never ran;
--   * if it had, max_connections only applies after a restart, and 20 is too
--     low (each API replica's pool alone takes up to 10).
-- max_connections is now set explicitly via `command:` in docker-compose.yml.
SELECT 1;
