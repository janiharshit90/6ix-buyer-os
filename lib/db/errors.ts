// Turns database errors into messages a user can act on, without exposing SQL internals.
// Messages we raise ourselves (P0001/P0002 in our RPCs and triggers) are written for users,
// so they pass through; anything else becomes a generic message plus a log line with the code.

export type DbError = { code?: string; message: string };

export function dbMessage(
  error: DbError,
  fallback = "Something went wrong saving that. Try again.",
): string {
  switch (error.code) {
    case "42501":
      return "You don't have permission to do that.";
    case "23505":
      return "That conflicts with an existing record (e.g. an open draft or a duplicate value).";
    case "23514":
      return "A value failed a database check. Review the fields and try again.";
    case "22001":
      return "A value is too long.";
    case "P0001":
    case "P0002":
      return error.message;
    default:
      console.error(`[db] unexpected error ${error.code ?? "unknown"}`);
      return fallback;
  }
}
