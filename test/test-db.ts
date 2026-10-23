/**
 * Resolves the database used by the integration tests and REFUSES to use
 * anything that is not clearly a throwaway test database, because the tests
 * truncate tables.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Point it at an empty, disposable Postgres database whose name ends in _test (see backend/.env.example).",
    );
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": the name must end with "_test".`,
    );
  }
  return url;
}
