-- Remove the public `anon` execute grant on resolve_mcp_token.
--
-- resolve_mcp_token is SECURITY DEFINER (it reads mcp_tokens outside RLS) and
-- was executable by the `anon` role so the MCP server could call it before it
-- had any user context. That exposed a definer function to unauthenticated
-- callers. The MCP server now calls it with a minted `authenticated` JWT
-- (mcp-server/src/auth.ts → mintServiceJwt), so only holders of the JWT secret
-- can invoke it. `authenticated` keeps its grant.
--
-- ORDER OF OPERATIONS: deploy the updated MCP server FIRST, then run this.
-- Revoking before the server is redeployed would break token resolution
-- (staff MCP connections) until the deploy lands.

revoke execute on function public.resolve_mcp_token(text) from anon;
