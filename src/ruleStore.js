import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class RuleStore {
  constructor(config) {
    this.directory = config.rules.directory;
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    const files = [
      "no-reply-rules.json",
      "manual-review-rules.json",
      "status-rules.json",
      "promotion-rules.json"
    ];
    const entries = await Promise.all(
      files.map(async (file) => {
        const text = await readFile(join(this.directory, file), "utf8");
        return [file, JSON.parse(text)];
      })
    );
    this.cache = Object.fromEntries(entries);
    return this.cache;
  }
}
