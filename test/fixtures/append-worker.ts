/** Separate process for the cross-process append test: two Node processes must
 *  never race on a shared temp file. argv: <dir> <tag> <count>. */
import { appendEntry } from "../../src/index.ts";

const [dir, tag, count] = process.argv.slice(2);
const file = `${dir}/entries.jsonl`;
for (let i = 0; i < Number(count); i++) {
  appendEntry(file, { at: Date.now() + i, kind: tag, text: `${tag}-${i}` }, 1000);
}