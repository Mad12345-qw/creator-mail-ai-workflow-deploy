export class RedisStore {
  constructor(config) {
    this.url = config.redis.url;
    this.token = config.redis.token;
    this.prefix = config.redis.keyPrefix || "creator-mail-ai";
  }

  isConfigured() {
    return Boolean(this.url && this.token);
  }

  key(name) {
    return `${this.prefix}:${name}`;
  }

  async command(command, ...args) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: "Redis is not configured." };
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify([command, ...args])
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(`Redis command failed: ${data.error || response.statusText}`);
    }
    return data.result;
  }

  async get(name) {
    return this.command("GET", this.key(name));
  }

  async getJson(name) {
    const value = await this.get(name);
    if (!value || typeof value !== "string") return null;
    return JSON.parse(value);
  }

  async set(name, value, options = {}) {
    if (options.ex) {
      return this.command("SET", this.key(name), value, "EX", String(options.ex));
    }
    return this.command("SET", this.key(name), value);
  }

  async setJson(name, value, options = {}) {
    return this.set(name, JSON.stringify(value), options);
  }

  async exists(name) {
    const result = await this.command("EXISTS", this.key(name));
    return result === 1;
  }

  async del(name) {
    return this.command("DEL", this.key(name));
  }
}
