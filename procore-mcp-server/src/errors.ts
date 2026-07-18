/**
 * Domain errors surfaced to Claude as clear, actionable tool messages. Tool
 * handlers catch these and return fail(err.message).
 */

/** The user has never connected their Procore account (or was disconnected). */
export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to Procore. Reconnect the Procore connector to authorize access.');
    this.name = 'NotConnectedError';
  }
}

/** The user's Procore session can no longer be refreshed — they must reconnect. */
export class ReconnectRequiredError extends Error {
  constructor() {
    super('Procore session expired and could not be refreshed. Reconnect the Procore connector.');
    this.name = 'ReconnectRequiredError';
  }
}

/** Procore returned 403 — the user/app lacks access to this resource. */
export class ForbiddenError extends Error {
  constructor(resource: string, detail?: string) {
    super(`You don't have access to ${resource} (Procore returned 403).${detail ? ` Procore says: ${detail}` : ''}`);
    this.name = 'ForbiddenError';
  }
}

/** Procore returned 404 — the resource/id doesn't exist or isn't visible. */
export class NotFoundError extends Error {
  constructor(resource: string, detail?: string) {
    super(`Not found: ${resource}. Verify the project/id is correct.${detail ? ` Procore says: ${detail}` : ''}`);
    this.name = 'NotFoundError';
  }
}
