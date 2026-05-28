/* eslint-disable no-console */
type Fields = Record<string, unknown> | undefined;

function fmt(level: string, msg: string, fields?: Fields): string {
  const ts = new Date().toISOString();
  const tail = fields ? ` ${JSON.stringify(fields)}` : '';
  return `[${ts}] ${level} ${msg}${tail}`;
}

export const log = {
  info: (msg: string, fields?: Fields) => console.log(fmt('INFO', msg, fields)),
  warn: (msg: string, fields?: Fields) => console.warn(fmt('WARN', msg, fields)),
  error: (msg: string, fields?: Fields) => console.error(fmt('ERROR', msg, fields)),
  debug: (msg: string, fields?: Fields) => console.debug(fmt('DEBUG', msg, fields)),
};
