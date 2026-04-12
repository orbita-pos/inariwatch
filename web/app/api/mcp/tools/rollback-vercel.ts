/**
 * Legacy MCP tool alias — `rollback_vercel` now delegates to the host-agnostic
 * `rollback_deploy` implementation. Kept so MCP clients that still call the
 * older name continue to work regardless of the user's hosting provider.
 */

export { execute } from "./rollback-deploy";
