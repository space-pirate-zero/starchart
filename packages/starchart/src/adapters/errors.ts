/** Thrown when an adapter needs credentials that are not configured; callers skip rather than fail. */
export class MissingCredentialsError extends Error {
  constructor(
    readonly adapter: string,
    message: string,
  ) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

export const isMissingCredentials = (e: unknown): e is MissingCredentialsError => e instanceof MissingCredentialsError;

/** Error text for any thrown value. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
