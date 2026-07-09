const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

export class FeishuClient {
  constructor(config) {
    this.config = config;
    this.tenantToken = "";
    this.tenantTokenExpireAt = 0;
  }

  isConfigured() {
    return Boolean(this.config.feishu.appId && this.config.feishu.appSecret);
  }

  async getTenantAccessToken() {
    if (!this.isConfigured()) {
      throw new Error("Feishu app credentials are not configured.");
    }
    const now = Date.now();
    if (this.tenantToken && now < this.tenantTokenExpireAt - 60_000) {
      return this.tenantToken;
    }

    const response = await fetch(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu token request failed: ${data.msg || response.statusText}`);
    }
    this.tenantToken = data.tenant_access_token;
    this.tenantTokenExpireAt = now + Number(data.expire || 7200) * 1000;
    return this.tenantToken;
  }

  async request(path, options = {}) {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
      throw new Error(`Feishu API failed: ${data.msg || response.statusText}`);
    }
    return data;
  }

  async createBitableRecord(tableName, fields) {
    const appToken = this.config.bitable.appToken;
    const tableId = this.config.bitable.tables[tableName];
    if (!appToken || !tableId) {
      return {
        skipped: true,
        reason: `Missing bitable config for ${tableName}`
      };
    }

    return this.request(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      method: "POST",
      body: JSON.stringify({ fields })
    });
  }
}
