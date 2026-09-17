-- Remove the placeholder MCP personal-token scheme.
--
-- Superseded by the OAuth 2.1 authorization server in mcp-server
-- (add_oauth_server.sql). Nothing reads these objects any more: the server's
-- resolveToken() is gone, and the Settings "Connect Claude" card was replaced by
-- "Connected apps", which reads oauth_refresh_tokens / oauth_access_tokens.
--
-- ⚠️  RUN ONLY AFTER the OAuth-enabled mcp-server is live in production. Until
--   then the deployed server still calls resolve_mcp_token on every request and
--   dropping it would take the connector down. Order of operations:
--     1. add_oauth_server.sql            (done)
--     2. deploy mcp-server with OAuth    (merge to main → deploy-mcp.yml)
--     3. this file
--
-- Irreversible for the token rows (their hashes are useless without the old
-- server anyway). Users reconnect through OAuth.

drop function if exists public.resolve_mcp_token(text);
drop function if exists public.create_mcp_token(text);
drop table    if exists public.mcp_tokens;
