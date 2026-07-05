-- Remove anon/public execute access to resolve_mcp_token.
--
-- resolve_mcp_token is SECURITY DEFINER (it reads mcp_tokens outside RLS) and
-- was executable by `anon` so the MCP server could call it before it had any
-- user context. The MCP server now calls it with a minted `authenticated` JWT
-- (mcp-server/src/auth.ts -> mintServiceJwt), so only holders of the JWT secret
-- can invoke it.
--
-- IMPORTANT: Postgres grants EXECUTE on functions to PUBLIC by default, and
-- `anon` inherits that. Revoking from `anon` alone is NOT enough — PUBLIC still
-- covers it (has_function_privilege('anon', ...) stays true). We must revoke
-- from PUBLIC as well, then explicitly re-grant to the one role that needs it.
--
-- ORDER OF OPERATIONS: deploy the updated MCP server FIRST, then run this.

revoke execute on function public.resolve_mcp_token(text) from public;
revoke execute on function public.resolve_mcp_token(text) from anon;
grant  execute on function public.resolve_mcp_token(text) to authenticated;
