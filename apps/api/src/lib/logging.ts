export function logEvent(event: string, fields: Record<string, unknown> = {}) {
  const payload = {
    time: new Date().toISOString(),
    event,
    ...fields,
  };
  console.log(JSON.stringify(payload));
}