const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

export class FeishuClient {
  constructor(config) {
    this.config = config;
    this.tenantToken = "";
    this.tenantTokenExpireAt = 0;
    this.appToken = "";
    this.appTokenExpireAt = 0;
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

  async getAppAccessToken() {
    if (!this.isConfigured()) {
      throw new Error("Feishu app credentials are not configured.");
    }
    const now = Date.now();
    if (this.appToken && now < this.appTokenExpireAt - 60_000) {
      return this.appToken;
    }

    const response = await fetch(`${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu app token request failed: ${data.msg || response.statusText}`);
    }
    this.appToken = data.app_access_token;
    this.appTokenExpireAt = now + Number(data.expire || 7200) * 1000;
    return this.appToken;
  }

  getAuthorizationUrl({ redirectUri, state, scopes = [] }) {
    const url = new URL(`${FEISHU_BASE_URL}/authen/v1/authorize`);
    url.searchParams.set("app_id", this.config.feishu.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
    return url.toString();
  }

  async requestWithAppToken(path, body) {
    const appToken = await this.getAppAccessToken();
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu OAuth request failed: ${data.msg || response.statusText}`);
    }
    return data.data || data;
  }

  async exchangeAuthorizationCode(code) {
    return this.requestWithAppToken("/authen/v1/oidc/access_token", {
      grant_type: "authorization_code",
      code
    });
  }

  async refreshUserAccessToken(refreshToken) {
    return this.requestWithAppToken("/authen/v1/oidc/refresh_access_token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
  }

  async requestWithUserToken(path, accessToken, options = {}) {
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
      throw new Error(`Feishu mailbox API failed: ${data.msg || response.statusText}`);
    }
    return data.data || data;
  }

  async listMailboxMessages({ userMailboxId = "me", accessToken, pageSize = 1 }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/messages?page_size=${pageSize}`,
      accessToken
    );
  }

  async listMailboxFolders({ userMailboxId = "me", accessToken }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/folders`,
      accessToken
    );
  }

  async getMailboxMessage({ userMailboxId = "me", messageId, accessToken }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    const message = encodeURIComponent(messageId);
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/messages/${message}`,
      accessToken
    );
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
