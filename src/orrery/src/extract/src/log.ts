type Field = string | number | boolean | null;

// JSON lines to stderr, so stdout stays clean for anything that wants to pipe
// the graph. Values are never logged, only names and counts: see the project
// rule about secrets.
export function log(event: string, fields: Record<string, Field> = {}): void {
  process.stderr.write(JSON.stringify({ event, ...fields }) + "\n");
}
